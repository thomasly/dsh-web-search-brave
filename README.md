# dsh-web-search-brave

[![license](https://img.shields.io/github/license/thomasly/dsh-web-search-brave)](https://github.com/thomasly/dsh-web-search-brave/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4f46e5)](https://github.com/deepseek-ai)
[![no dependencies](https://img.shields.io/badge/dependencies-none-2ea44f)](package.json)

把 [Brave Search API](https://brave.com/search/api/) 接进 DeepSeek Harness（dsh）的网页搜索插件。
它注册在 dsh 官方 `ctx.web` 搜索接缝上，provider id 是 **`brave-search`**，因此**所有模型**都能
通过 dsh 自带的 `web_search` 工具搜索，不需要某个特定模型，也不额外消耗模型 token 去让模型自己上网。

- 直连 Brave 官方接口，不经过 LLM，不产生模型费用；
- 复用你已经在 `~/.dsh/.credentials.yaml` 里配置好的 Brave key，不在对话或日志里出现明文；
- 单文件、**零依赖、零 import 宿主包**，装得上、不会因为宿主接口变动而加载失败；
- 结果带发布日期（`publishedAt`），对「最近有什么新东西」这类查询尤其有用。

> 适用版本：dsh 0.2.x（在 `0.2.1-rc.2` 上实测通过）。用 Node.js ≥ 22.19。

---

## 为什么需要这个插件

dsh 0.2.1 前后的插件接口变过。早先社区里的 Brave provider 大多从 `@deepseek-ai/dsh-settings`
等宿主包里 import 运行时符号，而 0.2.1 已经移除了其中一些导出，结果就是模块加载失败、
provider 始终没注册上——搜索看起来「装了但没用」。

这个插件换了一种做法：**一个 import 都不写**。它只用运行时自带的 `fetch`、`URL`，以及
`ctx.web`、`ctx.credentials`、`ctx.launchEnvironment` 三个服务。好处有两个：

1. 宿主内部模块怎么改都不会把它带崩；
2. 从本地目录安装（pnpm 会建成 `link:` 符号链接）时，插件的真实路径在 profile 之外，
   bare import 会解析不到宿主包——零 import 正好绕开这个坑。

---

## 安装

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:thomasly/dsh-web-search-brave
```

装完重启一次 dsh web（bundle 类插件需要重启才会挂载）。如果你习惯用 Web 界面，
在 **插件 → 安装** 里填上面的 GitHub 地址也可以。

### 方式二：本地开发目录

```bash
git clone https://github.com/thomasly/dsh-web-search-brave.git
```

然后在 dsh 里用插件管理指向这个目录（等价的领域工具调用是
`plugin_manager install_bundle`，`target` 传目录绝对路径）。pnpm 会以 `link:` 方式挂载，
所以**这个目录以后不能删、不能移**，否则 search 会失效。

### 启用（一行配置）

不管用哪种方式装，最后都要让 dsh 选中这个 provider。在
`~/.dsh/profiles/web/cordis.patch.yml` 里加：

```yaml
- id: web
  config:
    searchProvider: brave-search
    fetchProvider: http
```

`fetchProvider: http` 保持 `web_fetch` 走 dsh 内置的本地 HTTP 抓取，不额外花钱。

### 确认装好了

重启后随便问一句带时效的问题，比如「latest AI model release」，然后看搜索结果：

- 结果里出现 `(2026-11-01T10:55:46)` 这种**没有 `Z`、没有毫秒**的日期 → 就是 Brave
  （`page_age` 原样透传；Exa 之类的 provider 通常给 `...000Z`）；
- 如果报 `configured web provider "brave-search" is not registered`，说明 bundle 没挂上，
  先确认重启过、再确认 `dsh --profile web --dump-config | grep web-search-brave` 能看到
  `- id: web-search-brave-local`。

---

## 配置参考

配置写在 `cordis.patch.yml` 的 `web-search-brave-local` 行（bundle 自带的插入行）下面，
全部可选：

```yaml
- insert:
    - id: web-search-brave-local
      name: dsh-web-search-brave
      config:
        providerId: brave-search
        apiKeyEnv: BRAVE_API_KEY
        count: 10
        safesearch: moderate
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `brave-search` | 注册进 `ctx.web` 的 id，必须与 `searchProvider` 一致；改这里时两边一起改 |
| `apiKey` | 空 | 字面量 key。会写进配置文件，不推荐；设置了就优先于凭据库 |
| `apiKeyEnv` | `BRAVE_API_KEY` | 凭据库里的引用名（`refs.<这个名字>`），也是环境变量名 |
| `baseURL` | `https://api.search.brave.com/res/v1/web/search` | 接口地址；走代理或镜像时改这里 |
| `count` | `10` | 单次最多要几条，Brave 上限 20，下限 1 |
| `country` | 空 | 两位国家码（如 `CN`、`US`）或 `ALL`；空则不传 |
| `searchLang` | 空 | 如 `zh-hans`、`en`；空则不传 |
| `freshness` | 空 | `pd`/`pw`/`pm`/`py`，或 `2026-01-01to2026-01-31` |
| `safesearch` | `moderate` | `off` / `moderate` / `strict` |
| `extraSnippets` | `true` | 是否请求额外摘要片段并并入 `snippet` |
| `timeoutMs` | `20000` | 单次请求超时（毫秒） |
| `minIntervalMs` | `1100` | 两次请求的最小间隔；Brave 免费档约 1 次/秒 |

> `freshness` 是**整个 provider 级**的设置，不是每个 query 单独设的。dsh 的 `web_search`
> 入参只有 queries，所以想让「最新」类查询默认只看最近一周，可以在 profile 里配
> `freshness: pw`，或者另建一个 profile 专门跑时效性任务。

---

## API Key 从哪来

按顺序找，找到就用：

1. 行配置里的字面量 `apiKey`；
2. dsh 凭据库里的引用（`refs.<apiKeyEnv>`，默认 `refs.BRAVE_API_KEY`，
   即 `~/.dsh/.credentials.yaml`）；
3. dsh 启动时的环境快照（启动环境里的 `BRAVE_API_KEY`，含 `~/.env`）；
4. 当前进程的环境变量 `BRAVE_API_KEY`。

换 key 只需要改凭据库或环境变量，**不用改插件、不用重启**：每次搜索都会重新读一次配置和凭据。

把 key 放进凭据库最省事的方式是让 dsh 的设置页去写；手工写就是：

```yaml
refs:
  BRAVE_API_KEY: your-key-here
```

---

## 结果怎么交给模型

`ctx.web` 的 `web_search` 需要 `{ url, title?, snippet?, publishedAt? }`，本插件这样映射：

| 字段 | 来源 | 处理 |
| --- | --- | --- |
| `url` | `web.results[].url` | 空值丢弃，按 url 去重 |
| `title` | `title` | 去 HTML 标签、解实体（`&amp;`、`&#x2014;` 等）、压缩空白 |
| `snippet` | `description` + `extra_snippets` | 去标签解实体，最多再并入 3 条额外摘要，压到 1000 字以内 |
| `publishedAt` | `page_age` | 格式像日期（`YYYY-MM-DD[THH:MM[:SS[.sss]][Z|±hh:mm]]`）才透传，**不补时区** |

不补时区是故意的：Brave 给的 `page_age` 没有时区，硬加一个会让所有日期整体偏移。

---

## 错误码

| code | 触发条件 | 建议处理 |
| --- | --- | --- |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | 四个来源都没找到 key | 去凭据库加 `refs.BRAVE_API_KEY`，或设环境变量 |
| `WEB_PROVIDER_CREDENTIAL_INVALID` | 401 / 403 / 422 | key 复制错、订阅没开通、或用了别的产品线的 key |
| `WEB_PROVIDER_RATE_LIMITED` | 429，且重试一次后仍限流 | 等一会儿再搜，或把 `minIntervalMs` 调大 |
| `WEB_PROVIDER_TIMEOUT` | 超过 `timeoutMs` | 检查网络/代理，或调大 `timeoutMs` |
| `WEB_ABORTED` | 调用被取消 | 无需处理；这是正常的协作取消 |
| `WEB_PROVIDER_ERROR` | 其他网络、JSON、5xx、端点配置错误 | 看错误消息里的 host / HTTP 状态码 |

错误对象沿用接缝的 `WebError` 形状（`name === 'WebError'`、带 `code`、可选 `cause`），
但**没有 import 宿主类**——插件自己定义了一个同形状的 `Error` 子类，避免零依赖被打破。

---

## 限速与配额

- Brave 的配额和速率由你的账户决定，插件不改变额度。
- 免费档大约 1 次/秒；插件默认在两次请求之间等 1.1 秒。`web_search` 一次最多带 4 个
  query，会串行发，最坏多等几秒。
- 收到 429 时，如果响应带 `Retry-After` 且不超过 5 秒，会自动等一次再重试；否则直接报
  `WEB_PROVIDER_RATE_LIMITED`。
- 实测（2026-11-02，Brave 免费档 key）：响应头 `x-ratelimit-limit: 50` QPS，连续两次请求
  都放行，未见 1 秒限制；但插件仍保守节流，避免多 query 并发把配额打满。

---

## 工作原理（给想改代码的人）

```text
dsh 启动
  └─ loader 读取 web profile 的补丁层
       ├─ bundle 自带 cordis.patch.yml 插入 web-search-brave-local
       └─ 加载 dsh-web-search-brave → apply(ctx, config)
            └─ ctx.web.registerSearchProvider(new BraveSearchProvider(读配置的函数))
                 └─ 注册是 fiber 级的：这行被禁用/卸载时自动回收

模型调用 web_search
  └─ ctx.web 按 web.searchProvider = brave-search 找到 provider
       ├─ available()  纯本地判断（不发网络请求）
       └─ search({query, maxResults}, signal)
            ├─ 每次现读配置和 key（支持热改）
            ├─ 串行节流 → GET api.search.brave.com/res/v1/web/search
            ├─ 429 且 Retry-After 可接受 → 等一次重试
            └─ 映射成 { sources, truncated: false }
```

关键设计点：

- **零 import**：见上文「为什么需要这个插件」。
- **每次操作重新读配置**：配置里可能是 loader 传入的 volatile 引用（`{ get() }`），
  `readField()` 两种形态都认；保存配置后下一次搜索就生效，不需要重新注册。
- **串行节流**：内部用一条 Promise 链把并发搜索排队，保证任意两次请求间隔 ≥ `minIntervalMs`。
- **取消传播**：调用方的 `AbortSignal` 会一路传到 `fetch`，等待和重试都可以被打断。
- **超时用独立的 AbortController**：超时会报 `WEB_PROVIDER_TIMEOUT`，不会误报成用户取消。

---

## 目录结构

```text
dsh-web-search-brave/
├── index.js            provider 实现（单文件、零 import）
├── cordis.patch.yml    bundle 补丁：插入 web-search-brave-local 一行
├── package.json        name + dsh.bundle.patch（市场收录需要的元数据）
├── locale/
│   ├── en.json         插件管理页的英文标题/说明
│   └── zh.json         插件管理页的中文标题/说明
├── icon.svg            插件图标
├── test/smoke.mjs      离线单测 + 真实 Brave 冒烟（无 key 时自动跳过在线部分）
├── README.md
└── LICENSE
```

---

## 开发与测试

```bash
node --check index.js          # 语法
npm test                       # 离线单测 + 在线冒烟（有 key 才会发请求）

# 不依赖 dsh 凭据库，临时用环境变量跑在线部分
BRAVE_API_KEY=xxx npm test
```

测试覆盖：

- 映射契约：去重、实体解码、标签清理、额外摘要合并、日期透传/缺省；
- 注册契约：只注册一个 provider、`id` 正确、`available()` 不发网络请求；
- 错误契约：缺 key、调用方取消分别抛正确的 code；
- 在线冒烟：英文时效查询（检查 `publishedAt` 覆盖率）和中文查询（检查摘要非空）。

没有 key 的环境里，在线部分会自动跳过，离线单测照常跑完，所以可以直接接 CI。

发布前建议自己跑一遍：

```bash
node --check index.js && BRAVE_API_KEY=... npm test
```

---

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `configured web provider "brave-search" is not registered` | bundle 没挂载（没重启 / 装错了 profile） | 重启；`dsh --profile web --dump-config` 里找 `web-search-brave-local` |
| 搜索一直返回旧结果 | 配了 `freshness` 或用了缓存的上游 | 检查配置；换一个 query 试试 |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | key 不在四个来源中的任何一个 | 写进 `refs.BRAVE_API_KEY`，注意 YAML 缩进两个空格 |
| `WEB_PROVIDER_CREDENTIAL_INVALID` | key 错误 / 订阅未激活 / 429 之外的拒绝 | 去 Brave 控制台复制 key，确认已订阅 Search 计划 |
| `WEB_PROVIDER_RATE_LIMITED` | 超过账户速率或月额度 | 等一会儿；或去控制台看剩余额度 |
| 中文结果日期少 | Brave 的中文索引对部分站点没有 `page_age` | 正常现象，不是插件丢字段 |
| 装完搜索报 500 / provider 冲突 | 同时选了多个 provider，或 `providerId` 与 `searchProvider` 不一致 | 只留一个 `searchProvider`，两边 id 对齐 |
| 本地目录安装后重启搜索失效 | 目录被移动/删除，`link:` 失效 | 恢复目录，或改用 GitHub 安装 |

---

## 安全说明

- key 只出现在 `x-subscription-token` 请求头里，**不会**出现在插件日志、错误消息、
  搜索结果的任何字段中；错误消息只带 host 和 HTTP 状态码。
- 插件只访问你配置的 `baseURL`（默认 `api.search.brave.com`），没有遥测、没有回连。
- 推荐把 key 放凭据库（`~/.dsh/.credentials.yaml`，权限由 dsh 管理），而不是写进
  `cordis.patch.yml` 的 `apiKey`。
- 本插件与 Brave 官方无隶属关系；Brave 名称与图标归 Brave Software 所有。

---

## 卸载

```bash
dsh plugin --profile web remove dsh-web-search-brave
```

然后把 `cordis.patch.yml` 里的 `searchProvider` 改成别的已注册 provider（例如 `exa`），
或者删掉那行让 dsh 回退到默认选择。改完重启。

如果之前手工往 `cordis.patch.yml` 加过 `web-search-brave-local` 的 `insert` 行，记得一并删掉，
否则 bundle 卸载后会留下一个解析不到的行。

---

## English summary

A Brave Search provider for DeepSeek Harness. It registers `brave-search` on the official
`ctx.web` seam, so every model can use the built-in `web_search` tool without per-model
plumbing or extra token spend.

- Zero dependencies and zero host imports, so it keeps loading across dsh 0.2.x releases.
- Reuses the key already stored in `~/.dsh/.credentials.yaml` (`refs.BRAVE_API_KEY`),
  falling back to the launch environment and then `process.env`.
- Adds `publishedAt` from Brave's `page_age` (passed through unchanged, no timezone invention),
  joins `extra_snippets` into `snippet`, and paces requests at ~1.1 s with one 429 retry.
- Tested on dsh 0.2.1-rc.2 with Node 22.

Install: `dsh plugin --profile web add github:thomasly/dsh-web-search-brave`, restart dsh,
then set `web.searchProvider: brave-search` in the profile patch. Test: `npm test`
(live calls are skipped automatically when no key is available).

---

## License

[MIT](LICENSE) © 2026 thomasly
