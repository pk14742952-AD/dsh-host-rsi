> English (default) · [中文](./README.md)

# DSH HOST RSI Memory

**A model-agnostic DSH host plugin, tuned by default for local LLMs: primarily Qwen3.8-27B and lightweight local models such as Qwen3.8 Flash, while also working with API models.**
It is a DSH **host plugin** that adds a host-side **continual self-improvement memory layer on every use**.
Each run starts with a counter-reasoning self-check: the model interrogates its own answer before committing.
**Trusted lessons are saved and injected into the next run.** If the cheap method does not resolve the issue,
deeper critic rounds **automatically escalate**. No task-specific scorer is required for the general pattern.

Repository: <https://github.com/pk14742952-AD/dsh-host-rsi>

> **Plugin summary**: a DSH memory / self-evolution plugin. It gathers
> successes, failures, user corrections, and long-term preferences in the background,
> turns high-value experience into trusted lessons, and injects them automatically the
> next time a similar task appears. Changelog: [CHANGELOG.md](./CHANGELOG.md).

> **Want the technical principles or a local reproduction?** Read [PRINCIPLES.md](./PRINCIPLES.md)
> (dedicated docs: signal ladder / reflection loop / triggers and efficiency / indexing / AREX-2 mapping / reproduction checklist, with source line references).

## Principle Source (Acknowledgments)

The core ideas of this project are drawn from and credit the following public work:

- **AREX-2** (arXiv:2609.38288, BAAI 2026), a self-evolving agent framework. This project lands it as a
  "local, incremental, usable-now" DSH host plugin; the point-by-point mapping is in [PRINCIPLES.md](./PRINCIPLES.md).
- **Recursive Self-Improvement (RSI) and Continual Learning**: each run condenses success and failure into
  retrievable, refutable, automatically escalating lesson entries. Trusted lessons are injected into later
  contexts, so the model gets better with use. This is the basis for the memory signal ladder and escalation strategy.

> **GUI note:** this project previously had no GUI and now includes one. The dashboard display pattern
> ("click from Settings to open a web page") references the billion-context DSH plugin (MIT) **only for its
> presentation approach**. The code was independently rewritten, not copied. See [client.js](./client.js) and
> [lib/dashboard.js](./lib/dashboard.js).

## Dashboard / GUI

After restarting DSH, open **Settings > Plugins > DSH HOST RSI Memory** and click **Open dashboard** to inspect
plugin status (enabled/degraded, trusted/quarantined/trajectory, recent records). The page polls `status.json`
every 3 seconds and shows live trigger diagnostics: events seen, injections, captures, failure signals, and the
last event/reason.

You can also run the standalone demo locally without DSH:

```bash
node demo-serve.mjs                # loopback and sample records (default port 8788)
RSI_DEMO_PORT=9000 node demo-serve.mjs
```

## Design Goals

- **No impact on the model or DSH**: all reads go through in-memory cache; disk I/O only happens during
  debounced background writes. Hot paths (`pre-step` / `turn-end`) never block.
- **Stronger automatic triggering**: the host listens for common lifecycle event names across DSH releases
  (`agent/pre-step`, `turn/end`, `message`, `chat/message`, etc.), uses whichever exists, and dedupes by event
  object/content so a real turn never fires twice.
- **Immediate visible feedback**: the settings tab and dashboard show live trigger counters (events/injects/
  captures/failures). Even before a trusted lesson exists, ordinary tool failures leave a visible quarantined
  record, so users can confirm the plugin is actually watching.
- **Diagnostic and demo tools**: call `rsi_events` to inspect live trigger state, or `rsi_demo_capture` to add
  one sample trusted lesson for a quick dashboard/settings check.
- **User corrections and long-term instructions are remembered**: when a user gives an explicit correction or
  new instruction after an assistant reply (for example “don't use requests, use httpx”), the plugin records it
  as a trusted **L3** lesson. Explicit durable preferences/rules (for example `always use httpx` or
  `please remember to use concise bullet lists`) are stored as `user-instruction` trusted lessons too;
  one-off task requests are not written to memory.
- **Project-aware instruction dedupe keeps the memory clean**: user instructions are grouped by project/workspace
  when possible (from paths in the instruction or from session context; otherwise they fall back to the global group).
  Near-duplicate instructions within the same project are blocked by `hasDuplicate`; similar text in different projects
  is not merged by mistake.
- **Lessons are collected to the local plugin directory in the background**: `addLesson` / `addTrajectory`
  write to memory immediately and batch-flush to disk (`flushMs` debounce). If the directory is not writable,
  the plugin degrades to pure memory (`store.disabled`) without crashing.
- **Minimal resource usage**: `index.json` + `termindex.json` are read once at startup then kept in memory;
  writes are batched; the debounce timer is `unref`ed so it does not hold the event loop or process open.
- **Max compatibility**: the pure logic layer has zero host dependencies (covered by `node --test`);
  every DSH call on the host side is wrapped with fallback checks and try/catch. If an event shape is wrong,
  it becomes a no-op instead of throwing at the host.

## Evolution Mechanism (Reliability-Weighted Signal Ladder)

```text
task + answer
  |-- L1  verifiable check available? (code test / math == / SQL match / schema valid)
  |        -> run it. L1 failure = high-value corrective lesson. (decisive -> stop)
  `-- no L1 -> inline counter-reason: model emits
             [VERIFY: CONFIRMED|REFUTED|UNCERTAIN; conf=..; lesson=..; fix=..; reason=..]
              |-- CONFIRMED and conf >= threshold     -> trusted L2, stop (no critic)
              |-- REFUTED                             -> automatic critic round (retry fix) -> corrective lesson
              |-- UNCERTAIN / no tag / low confidence -> automatic critic round
              `-- user forces rsi_verify              -> automatic critic round
             still uncertain after critic -> quarantine (promoted to trusted only after stronger signal)
```

**Automatic but efficient:** every heavy path is gated. When there is nothing relevant it is a no-op. Capture
only happens on turns with outcome signals (error / tool run / artifact / decision / self-chosen tag). Critics
only start after the cheap method fails, and per-session cost is capped.

## Directory Layout

```text
dsh-host-rsi/          # plugin package (code)
  index.js             # DSH host entry: apply() + rsi_status tool + __RSI__ injection + /rsi/* routes
  client.js            # browser client: "DSH HOST RSI Memory" settings section (inspired by billion-context, code independently rewritten)
  demo-serve.mjs       # standalone demo (no DSH, loopback + example records)
  cordis.patch.yml     # DSH host bundle patch (inserts dsh-host-rsi)
  config.default.json  # default config
  icon.svg             # settings icon
  lib/                 # pure logic (unit-testable, no host dependency)
    spine.js           # turn lifecycle + task-change detection
    retrieve.js        # relevance ranking + token budget
    inject.js          # injection text generation
    interrogate.js     # self-check instruction, [VERIFY] tag parsing, critic prompt, self-consistency
    signal.js          # signal ladder (L1/L3/REFUTED/CONFIRMED + weights)
    scorers.js         # L1 verifiable checks (code/math/sql/schema auto-detection)
    capture.js         # composes a turn into classified lesson + trajectory
    policy.js          # trigger + escalation + budget gating
    store.js           # file store + inverted index (memory cache + debounced background writes + graceful degradation)
    status.js          # snapshot + records + formatStatusReport
    dashboard.js       # dashboardHtml + /rsi/* webserver handler + standalone dashboard server
  locale/              # settings i18n (zh/en)
  test/                # node:test suite (including webserver/client host integration tests)
~/.dsh/rsi-memory/     # data directory (human-readable source of truth; DSH_HOME env overrides)
  index.json  termindex.json
  lessons/<domain>.md    # trusted, human-curatable
  quarantined/<domain>.md # unverified, promoted later
  trajectories/*.jsonl   # raw trajectories (for future LoRA distillation)
```

## Quick Start / DSH Install Tutorial

### Local quick demo (no DSH required)

```bash
git clone https://github.com/pk14742952-AD/dsh-host-rsi
cd dsh-host-rsi
node demo-serve.mjs
```

Open the loopback URL printed in the console to see the dashboard with sample memory.

### Install in DSH

Host-specific bundle. Install from GitHub:

```bash
dsh plugin --profile web add github:pk14742952-AD/dsh-host-rsi
```

After publishing to npm, you can also install it directly:

```bash
dsh plugin --profile web add dsh-host-rsi
```

Or use the plugin manager to `install_bundle` from the local `dsh-host-rsi/` directory. Restart DSH after
installation; no build step is needed.

### Model compatibility

The plugin is **model-agnostic host logic** and does not depend on a model's parameter count. In practice any model
DSH can drive should work:

- Local 27B models (for example Qwen3.8-27B): the current defaults are tuned for this class and it is the primary
  validation target.
- Lightweight local/Flash models (for example Qwen3.8 Flash): works fine; lower `inject.topK` / `inject.tokenBudget`
  / `capture.maxPerSession` if the context window is tight.
- API/cloud models: works too, because the plugin injects and reads text only and never modifies model weights.
  Larger-context models can use higher `inject.topK` / `inject.tokenBudget` for fuller memory reuse.

If your model's context or cost profile differs, adjust the injection budgets in `config.default.json` instead of
changing plugin code.

## First-Run Verification

In `index.js`, the event payload shape is "document name + defensive assumptions" (`agent/pre-step`,
`turn/end`, `agent.followup`). On first run, use `cordis_inspect_query` (Event/Service) to confirm:

- `turn/end` events expose the task, assistant text, and tool results the glue layer needs;
- whether `agent.followup` / `agent.inject` exists in your profile (missing paths safely no-op).

Then run:

```bash
cd E:\DSH\dsh-host-rsi
node --test          # pure logic + data-layer suite (auto-discovers test/*.test.js)
```

## Configuration (bundle line `config`)

See `config.default.json`:
- `enabled` (master switch; false = fully no-op), `dir` (data directory), `flushMs` (background debounce ms);
- `inject.{topK,tokenBudget,candCap,enabled,includeQuarantined,oncePerTask,maxInjectsPerTask,reinjectOn,compactTopK,compactTokenBudget}`;
- `capture.{enabled,maxPerSession,minChars,dedupeThreshold,captureUserCorrections,captureUserInstructions}`;
- `escalate.{enabled,maxCriticsPerSession,selfConsistency,threshold}`;
- `embeddings` (reserved, default null; can swap in embedding neighbors at larger scale).

Defaults are conservative for local models.

## License Compliance

- This project (`dsh-host-rsi`) is MIT, see [LICENSE](./LICENSE).
- DSH (`@deepseek-ai`, MIT, Copyright 2026 DeepSeek) is the host. This project is a host plugin for DSH;
  it does not modify or redistribute DSH source. It uses DSH host APIs (`ctx.on` / `ctx.inject` /
  `webServer.register` / page injection). MIT permits third-party plugins to coexist and publish independently.
  This project does not copy DSH code, so attaching DSH copyright notice is not required, but it is acknowledged here.
- billion-context (MIT, Copyright 2026 ranxianglei): only its settings-page embedded web display pattern is
  referenced; the code is independently rewritten (not copied line-for-line), with an MIT-style acknowledgment here.

> **Conclusion:** DSH uses MIT and supports third-party plugins, so this project can be released compliantly.
> This project is also MIT and explicitly credits DSH and billion-context.

## Optional Next Step: Weight-Level Evolution

`trajectories/` plus trusted lessons form a clean training set. Periodically export it and run small LoRA
distillation on Qwen3.8-27B, with loss only on "forward-looking decisions" so the meta-skill is baked into
weights. This is the batch, safer complement to the runtime memory loop.
