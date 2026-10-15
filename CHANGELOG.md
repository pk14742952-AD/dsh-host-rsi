# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.8] - 2026-10-15

### Fixed

- **CRITICAL: double-.dsh path bug in `defaultDir()`** (`index.js`): when `DSH_HOME` is set
  (as it is on all DSH installs, typically `C:\Users\X\.dsh`), the old code did
  `path.join(DSH_HOME, '.dsh', 'rsi-memory')`, producing `C:\Users\X\.dsh\.dsh\rsi-memory`
  — a double `.dsh` nesting. The store was silently created at the wrong path, invisible
  to the user and to any tool that looks in the standard `~/.dsh/rsi-memory` location.
  Fix: detect when the home dir already ends with `.dsh` and use it directly as the base.

- **Migration from double-.dsh path**: `migrateLegacyDir()` now checks for the old
  double-.dsh path first and copies it to the correct location, preserving all 614+
  captured lessons. Falls through to the E:\DSH\.rsi-memory legacy migration if the
  double-.dsh path doesn't exist.

### Changed

- `defaultDir()` resolution: `DSH_HOME` (if it already ends in `.dsh`) → direct child
  `rsi-memory/`. If `DSH_HOME` doesn't end in `.dsh`, append `.dsh/rsi-memory` as before.
  This matches how DSH's own host.js resolves its data directory.

## [0.2.7] - 2026-10-15

### Fixed

- **CRITICAL: plugin never loaded — missing `main` field in package.json** (`package.json`):
  every working DSH host plugin declares a non-empty `main` field (e.g. `"main": "index.js"`)
  so the host kernel can locate the entry point. dsh-host-rsi had `"main": ""` (empty string,
  effectively absent), so the host silently skipped the bundle patch — the plugin was installed
  in node_modules but never loaded, never registered its event handlers, never opened its
  dashboard port, and never captured or injected anything. The GUI showed the version but the
  runtime was dead. Fix: set `"main": "index.js"`. This is the single most impactful fix in
  the project's history: without it, no other feature can ever fire.

## [0.2.6] - 2026-10-12

### Added

- **Instance-level second line of defense — final chance** (`lib/guard.js`, `index.js`):
  previously, when the per-turn correction budget (`maxRetries`, `maxPerSession`) was exhausted,
  the session was marked `undelivered` and abandoned. That mirrors the report's 3/50 instances
  that finished empty-handed despite a per-turn guard. Now, right before an instance would be
  recorded as undelivered, the plugin issues **one** session-level ultimatum per session
  (`guardFinalChancePrompt`): name the rejected state, forbid tool calls / silence / repetition,
  and demand a compact real deliverable or a one-line blocker. A subsequent OK still counts as
  a rescue. The gate is soft: `guard.finalChance !== false` and only when a followup channel
  exists (`hasFollowup`); it never fires more than once per session (session flag
  `guardFinalChance`). Config: `guard.finalChance` (default `true`).
- **New telemetry cell** `runtime.guard.finalChances`, surfaced in the dashboard card
  "最后通牒" / meta line and in the status text report (`lib/dashboard.js`, `lib/status.js`).
- **Sliding-window convergence detection** (`lib/convergence.js`, `index.js`): repeated-pass
  detection now uses a ring window instead of a cumulative histogram only. The report's S1
  lesson: a ring window "cures" repeated-verification loops; a cumulative histogram only
  "interrupts". `observeShell(state, command, text, repeatThreshold, windowSize=8)` pushes each
  passing fingerprint into `state.recentPasses` and counts only hits inside the window;
  `fingerprintCounts` remains as a cumulative diagnostic. `index.js` passes
  `cfg.convergence.windowSize`; config default `windowSize: 8` — the original 3×-repeat
  contract is unchanged (three consecutive passes are always within any window ≥ 3), only
  stale repeats from long ago stop triggering SOFT_STEER.
- Tests: both behaviors covered — `test/guard.test.js` (final-chance prompt shape + boundedness),
  `test/index.smoke.test.js` (retry-budget-exhausted → one final chance → rescue on deliverable;
  and final-chance-fires-exactly-once → undelivered), `test/convergence.test.js` (window vs
  cumulative histogram: interleaved passes never trigger, cumulative count still records;
  window never shrinks the 3× contract).
- Suite: **146 passing / 0 failing**; 3-column comparison harness
  (`scripts/compare-baseline.mjs`) re-run: **19/19 scenarios identical** vs the v0.2.5 baseline
  (workspace and installed profile both match), confirming zero behavioral regression.

## [0.2.5] - 2026-10-12

### Fixed

- **Dashboard surfaces the guard rescue metric** (`lib/dashboard.js`): the GUI showed
  fired / retries / undelivered but omitted the "救回 (rescued)" counter — the single most
  important value metric in the 3188-round report (206/3188 empty batches, 100% rescued via
  one correction round). The status text report already had it; the dashboard card and the
  runtime meta line now include `guard.rescued` too.
- Test: `test/webserver.test.js` asserts the dashboard HTML contains the rescued card, the
  render binding, and the meta-line label, so the metric cannot silently regress again.
- Suite: **141 passing / 0 failing**.

## [0.2.4] - 2026-10-12

### Fixed

- **Targeted correction for budget-burned EMPTY** (`lib/guard.js`, `index.js`): when the guard
  trips on `finish_reason=length` with empty content, the follow-up prompt now explicitly says
  the previous turn spent its budget on internal reasoning and tells the model to write the
  deliverable directly — mirroring the guard proxy wording validated in the 3188-round report
  ([ninfer-fusion-kvmem issue#3] §2.3). Ordinary EMPTY keeps the generic wording.
- `guardCorrectionPrompt(task, state, rejectedAnswer, reason)` gained the `reason` parameter;
  callers pass `verdict.reason` (index.js:543). Bounded-excerpt output unchanged
  (len=20457 for 20k input — verified in the 3-column comparison).
- Comparison harness (`scripts/compare-baseline.mjs`) gained 4 guard calibration scenarios;
  full 20-scenario run confirms the working tree and the installed profile are line-for-line
  identical and the old baseline (v0.2.2) differs only on the two intended calibrations.
- Suite: **140 passing / 0 failing**.

## [0.2.3] - 2026-10-12

### Fixed

- **EMPTY guard calibrated to real field data** (`lib/guard.js`): the 400-char `thresholdEmpty`
  default misfired on legitimate short dialogue turns ("好的", thumb replies). Per the
  3188-round SWE-bench findings reported in [ninfer-fusion-kvmem issue#3]
  (https://github.com/1314521gjy/ninfer-fusion-kvmem/issues/3, §2.3 calibration lesson),
  the default is now `0` — only a fully empty answer is EMPTY; a non-zero threshold is an
  explicit opt-in (deliverable profile). File turns still enforce `thresholdFile` (2000).
- **`finish_reason=length` + empty content is EMPTY, not TRUNCATED** (`lib/guard.js`): the
  report's dominant degenerate form (206/3188 rounds: reasoning budget burned, content empty)
  is now classified EMPTY ("budget burned, nothing delivered") so the correction asks for
  content; length-with-content stays TRUNCATED.
- Tests: `test/guard.test.js` updated to the calibrated semantics (short prose → OK; explicit
  `thresholdEmpty:400` opt-in still gates; length+empty → EMPTY). Suite: **139 passing / 0 failing**.

## [0.2.2] - 2026-10-11

### Fixed

- **Self-pollution gate closed** (`lib/policy.js`): `SYSTEM_BOILERPLATE_RE` now also matches
  `<goal_round>` round frames, `Current runtime context` snapshots, `<system-reminder>`
  skill-catalog blocks, and `Objective:"…" Round: N/M` lines — the 11 rows of plugin-written
  system text (10.5% of the trusted memory) that were being captured as trusted L3 "user
  corrections/instructions" and re-injected into unrelated tasks are now blocked. The
  `isUserCorrection` length fallback was raised 20 → 40 chars and now also requires the text
  to pass `isSystemLikeText`, so a neutral 22–40 char sentence is no longer stored verbatim.
- **Cross-kind instruction dedupe** (`lib/store.js` `hasDuplicate`): identical user text
  captured as both a correction and an instruction (observed: 22% of the real store) is now
  detected as a duplicate — the comparison strips only the `user-correction` /
  `user-instruction` domain prefix, so projects stay isolated.
- **Convergence false-negative** (`lib/convergence.js` `looksPassed`): `"3 passed; 0 failed"`
  was judged as FAILED because the negative check looked for the bare substring `failed`;
  the check is now zero-count aware (`fail(?:ed|ure)?` with a `0`-count token on either side),
  and the build family additionally rejects any literal `fail(ed|ure)` so `BUILD FAILED`
  never slips through.
- **Non-atomic store write + permanent disable** (`lib/store.js`): `index.json` /
  `termindex.json` are now written atomically (tmp file + rename); a corrupt index is
  quarantined as `.corrupt-<ts>` and rebuilt instead of disabling the store forever.
  A disabled store now also drains its trajectory/mirror buffers so a degraded session does
  not leak memory.
- **Retrieval noise filtering** (`lib/retrieve.js`): lessons that merely echo the current
  task text (≥80% token overlap with the task after stripping the capture prefix) are
  dropped; the estimateTokens CJK cost is now ~1.5 chars/token instead of a uniform /4
  (undercounting Chinese by ~3×); non-L1 lessons with a distinct `fix` now actually inject
  it (`-> fix: …`) instead of silently dropping it.
- **User REFUTED now trusted** (`lib/signal.js`): a user tap that says the answer is wrong
  is the single strongest corrective signal there is — it is classified L3 trusted weight 1.0
  and injected, instead of being quarantined while the weaker L2 self-REFUTED was trusted.
- **SHELL_LOOP false positive** (`lib/guard.js`): the loop detector compared only bare tool
  names, so three different `pwsh` commands were misjudged as a loop; it now compares the
  full tool identity (name + command), and a genuinely repeated identical command is still
  caught.
- **Scorer soundness** (`lib/scorers.js`): bare `node` is no longer a test command
  (`node --test` is), and a tool result with `ok: undefined` no longer counts as a pass
  without at least one explicit `ok: true` or a fully unshaped result.
- **Bounded rejected-answer excerpt** (`lib/guard.js`): the correction prompt that re-feeds a
  REJECTED answer into the model now truncates to head 6000 + tail 800 chars with a marker
  instead of passing the whole (potentially 20k+) turn.
- `outcomeSignal` no longer throws when `toolResults` is missing (TypeError on `.some`).

### Added

- `scripts/compare-baseline.mjs` — before/after comparison harness (对照测试): runs the same
  scenario battery against an old baseline, the working tree, and the installed profile, and
  prints a side-by-side table. Report: `COMPARISON-0.2.2.md`.
- Regression tests for every fix above (policy, store, convergence, retrieve, guard, signal,
  scorers). Full suite: **138 passed / 0 failed** (was 121).

## [0.2.1] - 2026-10-07

### Changed

- README (zh/en) now opens with a "problem it solves" note: the plugin targets local LLM
  death loops / getting stuck / 雷霆大思考 (repeatedly re-verifying a passing check, empty
  delivery, plan-only replies, pure tool loops, truncated output) with the coding-loop
  convergence steerer and the five-state delivery guard.

## [0.2.0] - 2026-10-07

### Added

- Coding-loop convergence (ported from `dsh-bonsai-fast` / `pi-extension-convergence`): repeated
  passing tests / build / API checks no longer get re-run endlessly. The plugin watches
  `tools/post-execute`, resets the counter on any `edit` / `write`, and steers the model to
  converge: a soft steer after the same check repeats, a strong steer as soon as multiple check
  families have all passed. Enabled for **every model** by default; users can restrict steering
  to a whitelist such as `["*27b*"]` via `convergence.models`, and the completion policy
  section is injected only for the same active set.
- L3 delivery guard (from the `D:\ninfer` 04/05 卡死与循环防治方案): host-side five-state
  detection of `EMPTY` / `TRUNCATED` / `FIXED_POINT` / `SAME_PLAN` / `SHELL_LOOP` after an
  assistant turn. A rejected turn schedules a correction round via `agent.followup` instead of
  being recorded as a lesson; after `maxRetries` per turn / `maxPerSession` per session it is
  archived as a quarantined trajectory. Tool-backed short summaries are not length-flagged, so
  normal "write files then summarize" turns are not disturbed.
- Live diagnostics for both features: dashboard cards and `rsi_status` / `rsi_events` now show
  convergence steers (strong/soft) and guard fired / retries / rescued / undelivered counters.
- New config: `convergence.{enabled,repeatThreshold,models}` and
  `guard.{enabled,maxRetries,maxPerSession,thresholdEmpty,thresholdFile,sameToolStreak,fileTurnRe,tasksRe,recordTrajectory}`.

### Changed

- `rsi-guard` follow-up prompts are treated as system content (never captured as user lessons).

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
- README (zh/en) documents the round-2 evaluation and known limits (issue #4): cross-session
  memory was reproduced (0/5 -> 5/5), while the self-check showed no significant gain on one
  strong API model and still awaits the target local 27B replication run.

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
