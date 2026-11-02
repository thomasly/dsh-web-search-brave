/**
 * Brave Search provider for the DeepSeek Harness web capability seam (`ctx.web`).
 *
 * The plugin registers one `WebSearchProvider` under the id `brave-search`.
 * `web.searchProvider` in the profile picks it, and from then on every model in
 * this profile reaches Brave through the standard, model-facing `web_search`
 * tool: no per-model plumbing, no model-side API calls, and no extra token cost
 * beyond the conversation itself.
 *
 * The key comes from the profile's credential store first (the reference named
 * by `apiKeyEnv`, `BRAVE_API_KEY` by default), then the launch-time environment,
 * then the process environment. A literal `apiKey` in the row config wins over
 * all of them.
 *
 * This module intentionally has no imports. A bundle installed from a local
 * directory is linked into the profile, so the plugin file's real location is
 * the checkout, not the profile; bare host imports would fail to resolve there.
 * Plain `fetch`, `URL`, and the `ctx` services are all this provider needs.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave';

/** The web capability seam this provider registers into. */
export const inject = ['web'];

/** Provider id registered into `ctx.web` (the value for `web.searchProvider`). */
export const DEFAULT_PROVIDER_ID = 'brave-search';

/** Brave's Web Search endpoint; `/res/v1/web/search` is the versioned path. */
export const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

/** Credential reference consulted when no literal `apiKey` is configured. */
export const DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY';

/** Brave's API accepts 1–20 results per request. */
const BRAVE_MAX_COUNT = 20;

/** Default number of results asked from Brave when the request omits `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;

/** Per-request timeout; the tool layer also enforces its own cooperative budget. */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Minimum spacing between two Brave requests, in milliseconds.
 *
 * The free plan allows roughly one request per second, while `web_search` may
 * fan a single call out to several queries. Pacing them avoids a 429 that would
 * otherwise abort the whole tool call.
 */
const DEFAULT_MIN_INTERVAL_MS = 1100;

/** Longest `Retry-After` honored before a 429 is reported instead of retried. */
const RETRY_AFTER_CAP_MS = 5000;

/** Upper bound for one source snippet, matching the seam's portable size. */
const MAX_SNIPPET_CHARS = 1000;

/** Extra snippets folded into a single snippet, at most. */
const MAX_EXTRA_SNIPPETS = 3;

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-brave/1.0.0';

/** Brave's accepted `safesearch` values. */
const SAFESEARCH_VALUES = new Set(['off', 'moderate', 'strict']);

/** A `freshness` value Brave accepts: a preset or an explicit date range. */
const FRESHNESS_PATTERN = /^(?:pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/u;

/** A `page_age` value worth forwarding as `publishedAt` (ISO-8601 date prefix). */
const PAGE_AGE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

/**
 * The provider's error type. It mirrors the seam's `WebError` contract — a
 * message plus a machine-routable `code` and an optional `cause` — without
 * importing the host package, so the same file works when a bundle is linked
 * from a checkout whose bare imports cannot see the profile's host packages.
 */
export class BraveSearchError extends Error {
  /**
   * @param {string} message - human- and model-readable failure description.
   * @param {string} code - stable, open-string code such as `WEB_PROVIDER_ERROR`.
   * @param {unknown} [cause] - the underlying failure, when there is one.
   */
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WebError';
    this.code = code;
  }
}

/**
 * Read one config field, whether the loader handed us a plain value (direct
 * library use, tests) or a live volatile reference (the 0.2.x loader).
 *
 * @param {unknown} value - the field's raw value.
 * @returns {unknown} the current plain value.
 */
function readField(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value;
}

/**
 * Normalize one optional string field.
 *
 * @param {unknown} value - candidate value.
 * @returns {string} the trimmed string, or `''`.
 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Clamp one integer field into its accepted range.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the candidate is not a number.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the accepted integer.
 */
function integerOf(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Normalize Brave's two-letter `country` code.
 *
 * @param {unknown} value - candidate value.
 * @returns {string} an upper-case code, `ALL`, or `''` to omit the parameter.
 */
function countryOf(value) {
  const text = textOf(value);
  return /^(?:[a-z]{2}|all)$/iu.test(text) ? text.toUpperCase() : '';
}

/**
 * Normalize Brave's `search_lang` value.
 *
 * @param {unknown} value - candidate value.
 * @returns {string} a lower-case language tag, or `''` to omit the parameter.
 */
function searchLangOf(value) {
  const text = textOf(value).toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(text) ? text : '';
}

/**
 * Normalize Brave's `freshness` value.
 *
 * @param {unknown} value - candidate value.
 * @returns {string} the accepted value, or `''` to omit the parameter.
 */
function freshnessOf(value) {
  const text = textOf(value);
  return FRESHNESS_PATTERN.test(text) ? text : '';
}

/**
 * Normalize Brave's `safesearch` value.
 *
 * @param {unknown} value - candidate value.
 * @returns {string} one of `off`, `moderate`, or `strict`.
 */
function safesearchOf(value) {
  const text = textOf(value).toLowerCase();
  return SAFESEARCH_VALUES.has(text) ? text : 'moderate';
}

/**
 * Build one operation's fully resolved options from the row config.
 *
 * The config is read on every operation, so a saved edit or a live volatile
 * reference is picked up by the next search without re-registering anything.
 *
 * @param {object} ctx - the plugin context (services are read lazily).
 * @param {object | undefined} config - the row config as the loader passed it.
 * @returns {object} options for one search.
 */
export function resolveOptions(ctx, config) {
  const source = config ?? {};
  const literalApiKey = textOf(readField(source.apiKey));
  const apiKeyEnv = textOf(readField(source.apiKeyEnv)) || DEFAULT_API_KEY_ENV;
  const providerId = textOf(readField(source.providerId)) || DEFAULT_PROVIDER_ID;
  return {
    providerId,
    literalApiKey,
    apiKeyEnv,
    baseURL: textOf(readField(source.baseURL)) || DEFAULT_BASE_URL,
    count: integerOf(readField(source.count), DEFAULT_MAX_RESULTS, 1, BRAVE_MAX_COUNT),
    country: countryOf(readField(source.country)),
    searchLang: searchLangOf(readField(source.searchLang)),
    freshness: freshnessOf(readField(source.freshness)),
    safesearch: safesearchOf(readField(source.safesearch)),
    extraSnippets: readField(source.extraSnippets) !== false,
    timeoutMs: integerOf(readField(source.timeoutMs), DEFAULT_TIMEOUT_MS, 1000, 120000),
    minIntervalMs: integerOf(readField(source.minIntervalMs), DEFAULT_MIN_INTERVAL_MS, 0, 10000),
    /** Resolve this operation's key; throws a credential error when none exists. */
    resolveApiKey: (signal) => resolveApiKey(ctx, { literalApiKey, apiKeyEnv }, signal),
  };
}

/**
 * Read one context service without letting a host without it throw.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} name - the service name.
 * @returns {unknown} the service, or `undefined`.
 */
function contextService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the key for one operation: literal config, credential store, launch
 * environment, then this process's environment.
 *
 * @param {object} ctx - the plugin context.
 * @param {{ literalApiKey: string, apiKeyEnv: string }} source - key sources.
 * @param {AbortSignal | undefined} signal - the surrounding search's signal.
 * @returns {Promise<string>} a non-empty key.
 * @throws {BraveSearchError} `WEB_PROVIDER_CREDENTIAL_MISSING` when none exists.
 */
async function resolveApiKey(ctx, source, signal) {
  if (source.literalApiKey.length > 0) return source.literalApiKey;
  const credentials = contextService(ctx, 'credentials');
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    let resolved;
    try {
      resolved = await credentials.resolve(source.apiKeyEnv);
    } catch (error) {
      throw new BraveSearchError(
        `Brave search could not resolve the credential reference "${source.apiKeyEnv}": ${describeError(error)}`,
        'WEB_PROVIDER_ERROR',
        error,
      );
    }
    const stored = textOf(resolved?.value);
    if (stored.length > 0) return stored;
  }
  const launchEnvironment = contextService(ctx, 'launchEnvironment');
  if (launchEnvironment !== undefined && typeof launchEnvironment.get === 'function') {
    const entry = launchEnvironment.get(source.apiKeyEnv);
    const ambient = textOf(entry?.value);
    if (ambient.length > 0) return ambient;
  }
  const fromProcess = textOf(process.env[source.apiKeyEnv]);
  if (fromProcess.length > 0) return fromProcess;
  throw new BraveSearchError(
    `Brave Search has no API key for "${source.apiKeyEnv}". `
      + 'Store it through the credentials service (the web Models page writes it, or edit ~/.dsh/.credentials.yaml under refs), '
      + `export ${source.apiKeyEnv} in the launching environment, or set a literal "apiKey" in the web-search-brave row config.`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  );
}

/**
 * The provider's stable cancellation error, keeping the caller's reason.
 *
 * @param {AbortSignal | undefined} signal - the aborted signal.
 * @returns {BraveSearchError} the aborted error.
 */
function abortedError(signal) {
  return new BraveSearchError('Brave search aborted', 'WEB_ABORTED', signal?.reason);
}

/**
 * Throw the stable cancellation error when the caller already aborted.
 *
 * @param {AbortSignal | undefined} signal - the surrounding search's signal.
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortedError(signal);
}

/**
 * Wait without swallowing the caller's cancellation.
 *
 * @param {number} ms - milliseconds to wait.
 * @param {AbortSignal | undefined} signal - the surrounding search's signal.
 * @returns {Promise<void>} resolves after the wait.
 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortedError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Describe a caught error for a model- and user-readable message.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} a concise description.
 */
function describeError(error) {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  return String(error);
}

/**
 * Decode the small entity set Brave descriptions use.
 *
 * @param {string} text - text that may contain HTML entities.
 * @returns {string} decoded text.
 */
function decodeEntities(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/giu, (match, name) => {
    const lower = name.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    try {
      if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    } catch {
      return match;
    }
    return match;
  });
}

/**
 * Turn one provider string into plain, single-spaced text.
 *
 * @param {unknown} value - a title, description, or extra snippet.
 * @returns {string} clean text, possibly empty.
 */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  const withoutTags = value.replace(/<[^>]*>/gu, ' ');
  return decodeEntities(withoutTags).replace(/\s+/gu, ' ').trim();
}

/**
 * Cap one string at a character count without splitting a surrogate pair.
 *
 * @param {string} text - the text to cap.
 * @param {number} limit - maximum length.
 * @returns {string} the capped text.
 */
function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Build one result's snippet from its description and extra snippets.
 *
 * @param {object} row - one `web.results[]` entry.
 * @returns {string} the joined snippet, possibly empty.
 */
function buildSnippet(row) {
  const parts = [];
  const description = cleanText(row?.description);
  if (description.length > 0) parts.push(description);
  if (Array.isArray(row?.extra_snippets)) {
    for (const extra of row.extra_snippets.slice(0, MAX_EXTRA_SNIPPETS)) {
      const text = cleanText(extra);
      if (text.length > 0 && !parts.includes(text)) parts.push(text);
    }
  }
  return truncate(parts.join(' '), MAX_SNIPPET_CHARS);
}

/**
 * Forward Brave's `page_age` as `publishedAt` when it looks like a date.
 *
 * Brave reports `page_age` without an explicit zone. It is passed through
 * unchanged on purpose: inventing a timezone would silently shift every date.
 *
 * @param {unknown} value - the `page_age` field.
 * @returns {string | undefined} the timestamp, or `undefined` when absent.
 */
function isoPageAge(value) {
  const text = textOf(value);
  return PAGE_AGE_PATTERN.test(text) ? text : undefined;
}

/**
 * Map one Brave Web Search payload into the seam's normalized result.
 *
 * @param {unknown} payload - the parsed response body.
 * @returns {{ sources: object[], truncated: boolean }} the normalized result.
 */
export function mapBravePayload(payload) {
  const rows = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  const seen = new Set();
  const sources = [];
  for (const row of rows) {
    const url = textOf(row?.url);
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    const source = { url };
    const title = cleanText(row?.title);
    if (title.length > 0) source.title = title;
    const snippet = buildSnippet(row);
    if (snippet.length > 0) source.snippet = snippet;
    const publishedAt = isoPageAge(row?.page_age);
    if (publishedAt !== undefined) source.publishedAt = publishedAt;
    sources.push(source);
  }
  return { sources, truncated: false };
}

/**
 * Build this operation's request URL.
 *
 * @param {object} options - resolved options.
 * @param {string} query - the non-empty query.
 * @param {number} count - the number of results to ask for.
 * @returns {URL} the endpoint with every configured parameter applied.
 */
function buildEndpoint(options, query, count) {
  let endpoint;
  try {
    endpoint = new URL(options.baseURL);
  } catch (error) {
    throw new BraveSearchError(
      `Brave search endpoint ${JSON.stringify(options.baseURL)} is not a valid URL.`,
      'WEB_PROVIDER_ERROR',
      error,
    );
  }
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('count', String(count));
  endpoint.searchParams.set('text_decorations', 'false');
  if (options.country.length > 0) endpoint.searchParams.set('country', options.country);
  if (options.searchLang.length > 0) endpoint.searchParams.set('search_lang', options.searchLang);
  if (options.freshness.length > 0) endpoint.searchParams.set('freshness', options.freshness);
  if (options.safesearch.length > 0) endpoint.searchParams.set('safesearch', options.safesearch);
  if (options.extraSnippets) endpoint.searchParams.set('extra_snippets', 'true');
  return endpoint;
}

/**
 * Decide how many results this request asks Brave for.
 *
 * @param {{ maxResults?: number }} request - the seam request.
 * @param {object} options - resolved options (its `count` is the provider cap).
 * @returns {number} a count between 1 and Brave's maximum.
 */
function resultCount(request, options) {
  const wanted = Number.isInteger(request?.maxResults) && request.maxResults > 0
    ? request.maxResults
    : options.count;
  return Math.max(1, Math.min(wanted, options.count, BRAVE_MAX_COUNT));
}

/**
 * Pull a readable detail out of a non-2xx Brave response.
 *
 * @param {Response} response - the failed response.
 * @returns {Promise<string>} the detail, possibly empty.
 */
async function errorDetail(response) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    return '';
  }
  if (body.length === 0) return '';
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.error?.detail ?? parsed?.error?.message ?? parsed?.detail ?? parsed?.message;
    if (typeof detail === 'string' && detail.length > 0) return detail;
  } catch {
    // A non-JSON body is reported verbatim below.
  }
  return body.slice(0, 300);
}

/**
 * Read the wait a 429 asks for, capped so one blocked request cannot stall a
 * whole tool call.
 *
 * @param {Response} response - the 429 response.
 * @returns {number | undefined} milliseconds to wait, or `undefined` to report.
 */
function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (header === null || header.length === 0) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_AFTER_CAP_MS, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, date - Date.now()));
  return undefined;
}

/**
 * Turn one non-2xx Brave response into the provider's error.
 *
 * @param {Response} response - the failed response.
 * @param {string} detail - a readable server detail.
 * @param {object} options - resolved options (for the key reference and host).
 * @returns {BraveSearchError} the classified error.
 */
function httpError(response, detail, options) {
  const status = response.status;
  const suffix = detail.length > 0 ? `: ${detail}` : '';
  const host = (() => {
    try {
      return new URL(options.baseURL).host;
    } catch {
      return options.baseURL;
    }
  })();
  if (status === 401 || status === 403 || status === 422) {
    return new BraveSearchError(
      `Brave Search rejected the API key (HTTP ${status} from ${host})${suffix}. `
        + `Update the key behind the "${options.apiKeyEnv}" credential reference, or set a literal "apiKey" in the row config.`,
      'WEB_PROVIDER_CREDENTIAL_INVALID',
    );
  }
  if (status === 429) {
    return new BraveSearchError(
      `Brave Search is rate limiting this key (HTTP 429)${suffix}. `
        + 'Free plans allow about one request per second; retry shortly, or raise minIntervalMs in the row config.',
      'WEB_PROVIDER_RATE_LIMITED',
    );
  }
  if (status >= 500) {
    return new BraveSearchError(
      `Brave Search is unavailable (HTTP ${status} from ${host})${suffix}. This is a server-side failure; retry later.`,
      'WEB_PROVIDER_ERROR',
    );
  }
  return new BraveSearchError(
    `Brave Search rejected the request (HTTP ${status} from ${host})${suffix}.`,
    'WEB_PROVIDER_ERROR',
  );
}

/**
 * Dispatch one GET and map transport failures onto the provider's errors.
 *
 * @param {URL} endpoint - the fully built request URL.
 * @param {string} apiKey - the resolved key.
 * @param {object} options - resolved options.
 * @param {AbortSignal | undefined} signal - the surrounding search's signal.
 * @returns {Promise<Response>} the response (which may be non-2xx).
 * @throws {BraveSearchError} on cancellation, timeout, or transport failure.
 */
async function requestOnce(endpoint, apiKey, options, signal) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Brave search timed out after ${options.timeoutMs} ms`, 'TimeoutError')),
    options.timeoutMs,
  );
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-subscription-token': apiKey,
        'user-agent': USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted === true) throw abortedError(signal);
    if (controller.signal.reason?.name === 'TimeoutError') {
      throw new BraveSearchError(
        `Brave search timed out after ${options.timeoutMs} ms while contacting ${endpoint.host}.`,
        'WEB_PROVIDER_TIMEOUT',
        error,
      );
    }
    throw new BraveSearchError(
      `Brave search request to ${endpoint.host} failed: ${describeError(error)}`,
      'WEB_PROVIDER_ERROR',
      error,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * The Brave-backed search provider.
 *
 * One instance per plugin mount. It keeps only pacing state, so a config edit
 * reaches the next search through the options thunk without re-registration.
 */
export class BraveSearchProvider {
  #resolveOptions;

  /** Promise chain used to serialize requests at `minIntervalMs` spacing. */
  #gate = Promise.resolve();

  /** Wall-clock start of the most recent dispatched request, in ms. */
  #lastRequestAt = 0;

  /**
   * @param {() => object} resolveOptions - thunk returning the NEXT operation's
   *   options, snapshotted once at each operation's entry.
   */
  constructor(resolveOptions) {
    if (typeof resolveOptions !== 'function') {
      throw new TypeError('BraveSearchProvider needs a resolveOptions function');
    }
    this.#resolveOptions = resolveOptions;
  }

  /**
   * Read per operation rather than frozen at construction, so a saved
   * `providerId` edit stays honest in diagnostics.
   *
   * @returns {string} the registry id this provider reports.
   */
  get id() {
    return this.#resolveOptions().providerId;
  }

  /**
   * Cheap local usability check, per the seam contract: no network calls.
   *
   * The key itself is resolved per search (it may live in the async credential
   * store), so a missing key surfaces as a descriptive search error rather than
   * as a silent fallback to another provider.
   *
   * @returns {boolean} whether this provider can be selected.
   */
  available() {
    const options = this.#resolveOptions();
    return URL.canParse(options.baseURL) && options.count >= 1;
  }

  /**
   * Run one search through the Brave Web Search API.
   *
   * @param {{ query: string, maxResults?: number }} request - the seam request.
   * @param {AbortSignal} [signal] - the surrounding search's cancellation.
   * @returns {Promise<{ sources: object[], truncated: boolean }>} normalized results.
   */
  async search(request, signal) {
    const options = this.#resolveOptions();
    throwIfAborted(signal);
    const query = typeof request?.query === 'string' ? request.query.trim() : '';
    if (query.length === 0) {
      throw new BraveSearchError('Brave search received an empty query.', 'WEB_PROVIDER_ERROR');
    }
    const apiKey = await options.resolveApiKey(signal);
    throwIfAborted(signal);
    const endpoint = buildEndpoint(options, query, resultCount(request, options));
    await this.#pace(options.minIntervalMs, signal);
    const response = await this.#dispatch(endpoint, apiKey, options, signal);
    throwIfAborted(signal);
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted === true) throw abortedError(signal);
      throw new BraveSearchError(
        'Brave Search returned a response body that was not valid JSON.',
        'WEB_PROVIDER_ERROR',
        error,
      );
    }
    return mapBravePayload(payload);
  }

  /**
   * Serialize requests so consecutive calls respect the provider's spacing.
   *
   * @param {number} minIntervalMs - the configured spacing.
   * @param {AbortSignal | undefined} signal - the surrounding search's signal.
   * @returns {Promise<void>} resolves when this request may start.
   */
  async #pace(minIntervalMs, signal) {
    if (!(minIntervalMs > 0)) return;
    const previous = this.#gate;
    let release;
    this.#gate = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      throwIfAborted(signal);
      const waitMs = this.#lastRequestAt + minIntervalMs - Date.now();
      if (waitMs > 0) await sleep(waitMs, signal);
      this.#lastRequestAt = Date.now();
    } finally {
      release();
    }
  }

  /**
   * Dispatch one search, retrying a 429 once when Brave names a short wait.
   *
   * @param {URL} endpoint - the request URL.
   * @param {string} apiKey - the resolved key.
   * @param {object} options - resolved options.
   * @param {AbortSignal | undefined} signal - the surrounding search's signal.
   * @returns {Promise<Response>} the successful response.
   * @throws {BraveSearchError} when the response cannot be recovered.
   */
  async #dispatch(endpoint, apiKey, options, signal) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await requestOnce(endpoint, apiKey, options, signal);
      if (response.ok) return response;
      const detail = await errorDetail(response);
      if (response.status === 429 && attempt === 0) {
        const waitMs = retryAfterMs(response);
        if (waitMs !== undefined) {
          await sleep(waitMs, signal);
          continue;
        }
      }
      throw httpError(response, detail, options);
    }
  }
}

/**
 * Register the Brave search provider with `ctx.web`.
 *
 * The seam's registration is fiber-scoped, so the loader disposes it together
 * with the row; no explicit disposer is needed here.
 *
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} config - the row config.
 */
export function apply(ctx, config) {
  const provider = new BraveSearchProvider(() => resolveOptions(ctx, config));
  ctx.web.registerSearchProvider(provider);
}
