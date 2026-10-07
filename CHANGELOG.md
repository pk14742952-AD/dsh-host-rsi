# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.14] - 2026-10-07

### Fixed

- User-instruction capture pollution (issue #1): messages whose DSH `source.kind` is not
  `user`, plus host/system-injected boilerplate (runtime-context banners, other plugins'
  injected instructions, the plugin's own self-check block), are now blocked at the source
  gate instead of being recorded as user lessons. Blocked noise is counted and visible in
  the dashboard / `rsi_status` / `rsi_events` diagnostics, and captured records now carry a
  `sourceKind` field so users can verify where each lesson came from.
- Durable-rule judgement was too loose: any instruction of 20+ characters was trusted as a
  standing L3 rule even when it was just a long one-off task. It now requires explicit rule
  phrasing (`永远/记得/必须/always/never/please use`...) or a rule noun.
- `inject.selfCheck` config gate: when set to `false`, the mandatory `[VERIFY: ...]`
  trailer is no longer injected, so schema-constrained/structured-output callers are not
  forced into an unparseable trailing line. It defaults to `true` (previous behaviour).
- The `/rsi/*` webserver route no longer keeps serving the first instance's frozen snapshot
  after the plugin is re-applied in the same process: the route is registered once and its
  live store/config/snapshot state is swapped on every apply.
- Packaging/doc drift (issue #3): `test/**` is included in the published package, the
  README verification command uses the scoped `node --test test/*.test.js` / `npm test`, the
  directory layout no longer lists nonexistent `lib/inject.js` / `lib/spine.js`, and the
  npm install instructions clearly state the package is not published yet (GitHub install
  is the supported path; the hardcoded `--profile web` was removed).

### Changed

- Merged capture/retrieval hardening (PR #2): durable user instructions are stored in full
  instead of being sliced to 160 chars, project paths written inside backticks/quotes
  resolve to a `project:` tag, retrieval now filters stopwords and ranks by IDF, and
  standing project rules are injected first by scope.
- README (zh/en) now opens with a welcome note inviting Issues/PRs and a star.

## [0.1.13] - 2026-10-05

### Fixed

- Chinese retrieval was effectively broken: a space-free CJK string ("写一个Python下载脚本")
  was tokenized as ONE giant term, so queries sharing only single Chinese characters scored
  zero overlap. `tokenize()` now also emits CJK unigrams, fixing both the inverted-index
  candidate step and the relevance ranking for Chinese lessons. Regression test added.
- `codeScorer` had a `match`/`check` regex mismatch (match accepted `tsc|node`, check did
  not), which made those tool names match but never count as definitive L1 checks.
  Unified both on the same tool set.

### Changed

- `collectStorage` (data-dir walk) is now cached for 5s, so the dashboard's status poll
  and the settings tab no longer re-stat the whole data dir on every fetch.
- Added a `test` npm script (`node --test test/*.test.js`) so `npm test` runs the full
  unit suite; the model-dependent e2e stays behind `npm run test:e2e`.

## [0.1.12] - 2026-10-05

### Fixed

- The default data `dir` no longer hardcodes a drive letter (`E:\DSH\.rsi-memory`), which
  created an unexpected folder on the E: drive for every user who installed the plugin.
  The default now follows the DSH home convention: `~/.dsh/rsi-memory`, overridable via the
  `DSH_HOME` environment variable (the same var DSH's host reads) or an explicit `dir` in
  the bundle row config.
- One-time migration: when the legacy `E:\DSH\.rsi-memory` still exists and the new default
  dir does not, its lessons/index/trajectories are copied over on first activation
  (best-effort; `RSI_LEGACY_DIR` env overrides the legacy location for testing).

## [0.1.11] - 2026-10-03

### Fixed

- Real DSH `systemPrompt` sections now use the correct `name` / `order` shape required by
  `@deepseek-ai/dsh-system-prompt`. The previous `key: ...` shape was silently rejected by
  DSH, which is why lessons were recorded but never injected.

## [0.1.10] - 2026-10-03

### Fixed

- Injection no longer waits only for a DSH `pre-step` event that may not expose the current
  user task. When a `user/message` arrives, the plugin now triggers the same task-change
  injection path directly, so trusted lessons can be injected even on hosts where pre-step
  is just a lifecycle tick without payload text.

## [0.1.9] - 2026-10-03

### Added

- Project-aware instruction dedupe: user instructions and corrections are grouped by a
  best-effort project/workspace key (from paths in the text or session context) before
  similarity gating, so repeated instructions do not flood the memory store and similar
  instructions in different projects are not merged by mistake.
- `store.hasDuplicate()` exposes a stronger normalized full-text duplicate gate for
  high-frequency user signals; the existing `dedupeThreshold` config is reused for it.
- `importRecent` block now appears in `config.default.json` (`enabled`, `limit`, `sessions`).

### Changed

- Documentation now clearly states that the plugin is model-agnostic host logic: tuned
  for local 27B models (Qwen3.8-27B), compatible with lightweight local Flash models,
  and also usable with API/cloud models by adjusting injection budgets.
- `projectFromText()` extracts a stable project key from Windows or Unix path tokens for
  project-scoped dedupe.

## [0.1.8] - 2026-10-03

### Fixed

- 兼容 DSH NEXT / DSH 主机 `user/message` 的真实数据形状：
  - 部分 DSH 版本把用户消息正文放在 `event.data.content`（文本块数组），而不是 `event.data.message.content`。
  - 事件解析现在同时兼容 `data.message.content`、`event.message.content` 与 `data.content` 三种结构，确保不同 DSH 版本都能读取用户指令。
- 清理本地调试临时文件，插件不再往记忆目录写会话调试日志。

## [0.1.7] - 2026-10-03

### Added

- 启动时自动导入 DSH 现有实时会话里的近期用户指令：
  - 通过 `ctx.sessions` 只读扫描最近会话，把旧对话里已经存在的用户输入补录进记忆，避免“安装前已有的聊天永远进不了记忆”的问题。
  - 默认最多导入最近 10 个会话、30 条非闲聊输入；持久规则仍记为可信 `L3`，一次性任务记为隔离 `Q`。
  - 每次启动去重，不会重复写入同一句话；扫描只在 `session` 服务存在时运行，失败不阻塞 DSH。

## [0.1.6] - 2026-10-03

### Fixed

- 修复用户在 DSH 里输入指令仍然不记录的问题：
  - DSH 主机插件通过 `session/event` 接收会话生命周期事件，之前插件只监听了 `user/message` / `turn/end` 这类旧别名，导致真实用户输入没有进入记忆管线。
  - 新增 `ctx.on('session/event')` 订阅，并按 `event.type` 路由到用户消息、助手消息和回合结束处理逻辑。
  - 用户消息现在会立即落库，不再依赖“后置判断”或回合结束时的辅助信息。

### Changed

- 普通用户指令一律记录：
  - 明确持久规则 / 偏好（例如“以后都用 httpx”）仍记为可信 `L3` 教训，可注入类似任务。
  - 一次性任务请求（例如“帮我写一个 Python 下载脚本”）也会记录为隔离 `Q` 记录，方便用户在仪表板看到输入确实被捕获，同时避免污染未来注入。

### Added

- 新增 `isDurableUserInstruction` 判定，区分“持久规则”和“普通任务请求”。
- 新增 `session/event` 事件订阅测试，覆盖普通用户输入落库。

## [0.1.5] - 2026-10-03

### Fixed

- 修复 DSH 真实事件结构兼容：
  - DSH 的 `user/message` / `assistant/message` / `turn/end` 事件内容位于 `event.data.message.content`，之前插件只读了 `event.message.content`，导致“事件有计数但没有捕获/没有注入”。
  - 新增 `event.data.message.content`、文本块数组（`[{type:"text",text:...}]`）与 `event.data` 消息解析。
  - `pre-step` 注入查询现在会回退到最近一条用户任务，避免 DSH 事件形状不同导致注入为空。

### Added

- 新增 DSH `data.message` 事件结构测试，覆盖用户纠正与长期指令两类捕获。
- 仪表板、设置页和 `rsi_status` 文本报告显示插件版本号。

## [0.1.4] - 2026-10-03

### Added

- 用户指令 / 长期偏好记忆：
  - 新增 `captureUserInstructions` 配置项，默认开启。
  - 当用户给出明确的长期约束或偏好（例如“以后都用 httpx”“请记住输出用简洁列表”）时，自动记录为可信 `L3 user-instruction` 教训。
  - 普通一次性任务请求不会写入记忆，避免噪音。
- 触发与诊断：
  - `rsi_events` 返回值、仪表板和 DSH 设置页新增 `instructions` 与 `lastInstruction` 诊断字段。
  - 更清楚地展示“纠正”与“指令”两类用户信号的累计计数。
- README 补充插件简介、更新日志链接、一键部署 / DSH 安装教程，并明确支持 Qwen3.8 Flash。

### Changed

- 记忆触发策略参考成熟记忆插件的写入门控：纠正立即落库，长期偏好 / 规则按显式关键词落库。
- `isUserInstruction` 改为更严格的长期指令识别，避免把普通任务请求当记忆。

## [0.1.3] - 2026-10-02

### Added

- 初版 DSH host RSI 插件：
  - 本地大模型每次使用后的持续自进化。
  - L1 可验证检查、L2 自判、L3 用户纠正信号阶梯。
  - 可信教训自动注入类似任务上下文。
  - 设置页、仪表板、`rsi_events` / `rsi_records` / `rsi_demo_capture` 工具。
