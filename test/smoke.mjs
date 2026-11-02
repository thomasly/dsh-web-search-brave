/**
 * Smoke test for the Brave search provider.
 *
 * It exercises the real plugin surface (`apply`, `available`, `search`, error
 * paths) against the real Brave API. The key is read from the environment
 * (`BRAVE_API_KEY`) or from the DSH credential store, so the test works on any
 * machine without committing a secret:
 *
 *   BRAVE_API_KEY=... node test/smoke.mjs     # explicit key
 *   node test/smoke.mjs                       # read ~/.dsh/.credentials.yaml
 *
 * Without any key the live section is skipped and the offline checks still run.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BraveSearchProvider, apply, mapBravePayload } from '../index.js';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const CREDENTIALS = process.env.DSH_CREDENTIALS ?? join(DSH_HOME, '.credentials.yaml');

/** Read the key from the environment first, then from the DSH credential store. */
function readBraveKey() {
  const fromEnv = (process.env.BRAVE_API_KEY ?? '').trim();
  if (fromEnv.length > 0) return fromEnv;
  let text;
  try {
    text = readFileSync(CREDENTIALS, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^\s{2}BRAVE_API_KEY:\s*(\S+)\s*$/mu.exec(text);
  return match === null ? undefined : match[1];
}

const BRAVE_KEY = readBraveKey();
const failures = [];

function check(label, condition, detail = '') {
  const status = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${status} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!condition) failures.push(label);
}

function fakeContext({ withCredentials = true } = {}) {
  const registered = [];
  return {
    registered,
    ctx: {
      web: {
        registerSearchProvider(provider) {
          registered.push(provider);
          return () => {};
        },
      },
      get(name) {
        if (name === 'credentials' && withCredentials) {
          return {
            resolve: async (ref) => (ref === 'BRAVE_API_KEY' ? { value: BRAVE_KEY, source: 'file' } : undefined),
          };
        }
        return undefined;
      },
    },
  };
}

/** Mapping contract: entities, markup, duplicates, date passthrough. */
function testMapping() {
  console.log('\n[unit] payload mapping');
  const mapped = mapBravePayload({
    web: {
      results: [
        {
          url: 'https://example.com/a',
          title: 'A &amp; B &#x2014; <b>bold</b>',
          description: 'desc &lt;1&gt;',
          page_age: '2026-10-29T18:30:30',
          extra_snippets: ['extra one', 'extra one', 'extra two'],
        },
        { url: 'https://example.com/a', title: 'duplicate' },
        { url: 'https://example.com/b', title: 'no date' },
        { title: 'missing url' },
      ],
    },
  });
  check('dedupes by url', mapped.sources.length === 2, `sources=${mapped.sources.length}`);
  check('decodes entities and strips tags', mapped.sources[0].title === 'A & B — bold', mapped.sources[0].title);
  check('keeps page_age as-is', mapped.sources[0].publishedAt === '2026-10-29T18:30:30');
  check('dedupes extra snippets', mapped.sources[0].snippet === 'desc <1> extra one extra two', mapped.sources[0].snippet);
  check('omits absent date', mapped.sources[1].publishedAt === undefined);
  check('not truncated', mapped.truncated === false);
}

function throwsTypeError(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

async function main() {
  testMapping();

  console.log('\n[plugin] registration');
  const { ctx, registered } = fakeContext();
  apply(ctx, { providerId: 'brave-search', apiKeyEnv: 'BRAVE_API_KEY', minIntervalMs: 0 });
  check('registers exactly one provider', registered.length === 1);
  const provider = registered[0];
  check('provider id is brave-search', provider.id === 'brave-search', provider.id);
  check('available() is true locally', provider.available() === true);
  check('rejects a missing resolveOptions thunk', throwsTypeError(() => new BraveSearchProvider()));

  console.log('\n[error] missing credential');
  const noKey = fakeContext({ withCredentials: false });
  apply(noKey.ctx, { apiKeyEnv: 'BRAVE_API_KEY_MISSING', minIntervalMs: 0 });
  const missingKeyProvider = noKey.registered[0];
  try {
    await missingKeyProvider.search({ query: 'test' }, undefined);
    check('throws on missing key', false);
  } catch (error) {
    check('throws WEB_PROVIDER_CREDENTIAL_MISSING', error?.code === 'WEB_PROVIDER_CREDENTIAL_MISSING', error?.code);
    check('error mirrors the WebError name', error?.name === 'WebError');
  }

  console.log('\n[error] aborted signal');
  const controller = new AbortController();
  controller.abort(new Error('test abort'));
  try {
    await provider.search({ query: 'test' }, controller.signal);
    check('throws on abort', false);
  } catch (error) {
    check('throws WEB_ABORTED', error?.code === 'WEB_ABORTED', error?.code);
  }

  if (BRAVE_KEY === undefined) {
    console.log('\n[live] skipped — no BRAVE_API_KEY in the environment and no refs.BRAVE_API_KEY in the credential store');
  } else {
    console.log('\n[live] english freshness query');
    const english = await provider.search({ query: 'latest AI model release', maxResults: 5 }, undefined);
    check('returns results', english.sources.length > 0, `count=${english.sources.length}`);
    check('every source has a title', english.sources.every((source) => typeof source.title === 'string' && source.title.length > 0));
    const dated = english.sources.filter((source) => typeof source.publishedAt === 'string');
    check('most results carry publishedAt', dated.length >= Math.ceil(english.sources.length / 2), `${dated.length}/${english.sources.length}`);
    for (const source of english.sources.slice(0, 3)) {
      console.log(`      - ${source.publishedAt ?? 'no date'} | ${source.title}`);
    }

    console.log('\n[live] chinese query');
    const chinese = await provider.search({ query: '上海博物馆 美洲展 门票', maxResults: 5 }, undefined);
    check('returns results', chinese.sources.length > 0, `count=${chinese.sources.length}`);
    check('every source has a snippet', chinese.sources.every((source) => typeof source.snippet === 'string' && source.snippet.length > 0));
    for (const source of chinese.sources.slice(0, 3)) {
      console.log(`      - ${source.publishedAt ?? 'no date'} | ${source.title}`);
    }
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
