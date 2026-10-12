> English (default) · [中文](./README.md)

<div align="center">

# 🧠 DSH HOST RSI Memory

**A host-side plugin that makes local LLMs "get better with use" — no more death loops**

[![Version](https://img.shields.io/badge/version-v0.2.2-2F81F7)](https://github.com/pk14742952-AD/dsh-host-rsi/releases/tag/v0.2.2)
[![Tests](https://img.shields.io/badge/tests-138%20passing-2E7D32)](https://github.com/pk14742952-AD/dsh-host-rsi)
[![License](https://img.shields.io/badge/license-MIT-7B1FA2)](./LICENSE)

</div>

> **What is it?** A **host-side memory / self-evolution plugin** for DSH (DeepSeek Harness).
> It quietly watches every session — the model's self-check verdicts, tool outcomes, user
> corrections, and long-term preferences — distills high-value experience into **trusted lessons**,
> and automatically injects them when a similar task appears next time: **it gets better the more
> you use it**.

## 🎯 What problems does it solve?

| Pain point 😵 | How the plugin helps ✨ |
|---|---|
| **Death loops / stuck / thunder-thinking**: re-running already-passing checks, empty delivery, plan-only replies | Built-in **coding-loop convergence steerer** + **five-state delivery guard** inject a convergence hint and push for a complete, closed deliverable |
| **Goldfish memory**: repeating the same mistakes | High-value experience is distilled into trusted lessons and recalled on similar tasks |
| **Tuning pain**: local models behave very differently | Model-agnostic; no task-specific scorer required; works with API and local models |
| **Memory pollution**: system banners and task echoes leak into memory | Source gate + retrieval sanitization keep only genuine trusted corrections |

## ✨ Key features

- 🧠 **Self-evolution**: L1 verifiable checks / L2 self-interrogation / L3 user final tap — a reliability-weighted 3-level signal ladder
- 🔁 **Convergence steerer**: detects death loops and injects a hint so time goes back into real work
- 🛡️ **Five-state delivery guard**: catches EMPTY / TRUNCATED / FIXED_POINT / SAME_PLAN / SHELL_LOOP
- 💾 **Persistent memory**: in-memory reads + debounced background writes; crash-safe and self-healing
- 🔌 **Zero intrusion**: pure host plugin, no model-weight changes, minimal resource footprint

## 🚀 Quick start

1. **One-click install**: DSH → Settings → Plugins → install `dsh-host-rsi`
2. **Watch it work**: restart DSH → Settings → Plugins → **DSH HOST RSI Memory → Open dashboard** to see captures / injections / blocks live
3. **Try standalone** (no DSH needed): `node demo-serve.mjs` → open <http://127.0.0.1:8788>

## 📢 Release Notes

### v0.2.5 (2026-10-12) — dashboard shows the rescue metric

- **New "救回 (rescued)" card on the dashboard**: the core guard value metric — in the
  3188-round report all 206 empty batches were rescued by one correction round
  ([issue#3](https://github.com/1314521gjy/ninfer-fusion-kvmem/issues/3) §2.3). The GUI only
  showed fired / retries / undelivered before; the dashboard card and runtime summary now
  expose `guard.rescued`, with a regression test guarding it.
- Test suite: **141 passing**.

### v0.2.4 (2026-10-12) — targeted correction for budget-burned turns + comparison wrap-up

- **Targeted correction wording**: when `finish_reason=length` with empty content (reasoning
  budget burned, nothing delivered), the follow-up now tells the model it spent the previous
  turn's budget on internal reasoning and to write the deliverable directly — matching the
  guard-proxy wording validated in the 3188-round report
  ([issue#3](https://github.com/1314521gjy/ninfer-fusion-kvmem/issues/3)). Plain EMPTY keeps
  the generic wording.
- **Comparison wrap-up**: `scripts/compare-baseline.mjs` gained 4 guard calibration scenarios;
  the 20-scenario 3-column run (old baseline / working tree / installed profile) is
  line-for-line identical except the two intended calibrations vs the old baseline — no
  impact on other plugins, profile in sync with source.
- Test suite: **140 passing**.

### v0.2.3 (2026-10-12) — guard thresholds calibrated against real load

- **EMPTY no longer misfires on short dialogue**: the default now flags only a fully empty
  delivery; the old 400-char threshold wrongly caught legitimate short replies (e.g. "好的").
  Calibrated per the 3188-round SWE-bench findings in
  [ninfer-fusion-kvmem issue#3](https://github.com/1314521gjy/ninfer-fusion-kvmem/issues/3).
  File-turn deliveries still enforce the 2000-char threshold.
- **`finish_reason=length` with empty content is EMPTY, not TRUNCATED**: the dominant
  degenerate form in the report (206/3188 rounds = 6.5%, reasoning budget burned with nothing
  delivered) now gets the "budget burned, nothing delivered" correction instead of a
  truncation hint.
- Test suite: **139 passing**.

### v0.2.2 (2026-10-11) — making the plugin actually work

- **Self-pollution fixed**: system banners / `<goal_round>` / skill-catalog blocks are no longer
  captured as "user corrections" and injected into unrelated tasks.
- **User REFUTED is now trusted**: "you are wrong" is the strongest corrective signal — stored as
  trusted L3 and injected (it used to be quarantined).
- **SHELL_LOOP false positive fixed**: three distinct commands no longer look like a death loop
  (identity is compared by `name:command`).
- **Convergence detection fixed**: `3 passed; 0 failed` is no longer judged as failed; `BUILD FAILED`
  no longer slips through as passed.
- **Atomic store writes + self-heal**: `index.json` can no longer be lost on crash; a corrupt file is
  quarantined and rebuilt instead of disabling the store forever.
- **Retrieval noise filtering**: task-echo lessons dropped, CJK token cost corrected, `fix` actually
  injected beyond L1.
- Before/after comparison: [COMPARISON-0.2.2.md](./COMPARISON-0.2.2.md); test suite: 138 passing.

> Older releases in [CHANGELOG.md](./CHANGELOG.md) · GitHub Release for this version:
> <https://github.com/pk14742952-AD/dsh-host-rsi/releases/tag/v0.2.2>

## 📚 Further reading

- [PRINCIPLES.md](./PRINCIPLES.md) — technical principles: signal ladder / reflection loop / triggers & efficiency / indexing / reproduction checklist (with source line references)
- [COMPARISON-0.2.2.md](./COMPARISON-0.2.2.md) — before/after comparison tests
- [CHANGELOG.md](./CHANGELOG.md) — full changelog

> Found a bug or have an idea? Open an Issue or PR. If you find this useful, leave a ⭐ Star — thank you!

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
every 5 seconds and shows live trigger diagnostics: events seen, injections, captures, failure signals, blocked
noise, and the last event/reason.

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
  one-off task requests are only stored as quarantined `Q` records and never injected, so they cannot pollute
  future context.
- **Source gate keeps system content out of memory**: only messages with `source.kind === 'user'` are captured.
  DSH runtime banners, instructions injected by co-installed plugins, and the plugin's own self-check block are
  blocked and counted as “blocked noise”; every captured user record also carries a `sourceKind` field for
  self-audit.
- **Project-aware instruction dedupe keeps the memory clean**: user instructions are grouped by project/workspace
  when possible (from paths in the instruction or from session context; otherwise they fall back to the global group).
  Near-duplicate instructions within the same project are blocked by `hasDuplicate`; similar text in different projects
  is not merged by mistake.
- **Lessons are collected to the local plugin directory in the background**: `addLesson` / `addTrajectory`
  write to memory immediately and batch-flush to disk (`flushMs` debounce). If the directory is not writable,
  the plugin degrades to pure memory (`store.disabled`) without crashing.
- **Minimal resource usage**: `index.json` + `termindex.json` are read once at startup then kept in memory;
  writes are batched; the debounce timer is `unref`ed so it does not hold the event loop or process open.
- **Max compatibility**: the pure logic layer has zero host dependencies (covered by `npm test`);
  every DSH call on the host side is wrapped with fallback checks and try/catch. If an event shape is wrong,
  it becomes a no-op instead of throwing at the host.

## Evolution Mechanism (Reliability-Weighted Signal Ladder)

## Convergence + Delivery Guard (v0.2.0)

- **Coding-loop convergence** (ported from `dsh-bonsai-fast` / `pi-extension-convergence`): when
  the same passing check (`pytest` / `npm test` / build / API) repeats, or several check families
  have all passed, the plugin injects a strong/soft steer via `tools/post-execute` so the agent
  stops over-verifying; any `edit` / `write` resets the counter. Enabled for every model DSH
  runs by default; set `convergence.models: ["*27b*"]` if you only want 27B models steered.
- **L3 delivery guard** (from the `D:\ninfer` 04/05 prevention scheme): host-side detection of
  `EMPTY` / `TRUNCATED` / `FIXED_POINT` / `SAME_PLAN` / `SHELL_LOOP`. On a failure state it
  schedules one `agent.followup` round asking for a complete, closed deliverable; capped at
  `maxRetries` per turn and `maxPerSession` per session, then archived as a quarantined
  trajectory. Tool-backed short summaries are not length-flagged (length gates only apply to
  inline delivery with no tool runs).

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
    capture.js         # composes a turn into classified lesson + trajectory
    convergence.js     # coding-loop convergence (ported from dsh-bonsai-fast / pi-extension-convergence)
    dashboard.js       # dashboardHtml + /rsi/* webserver handler + standalone dashboard server
    guard.js           # L3 delivery guard (EMPTY/TRUNCATED/FIXED_POINT/SAME_PLAN/SHELL_LOOP)
    interrogate.js     # self-check instruction, [VERIFY] tag parsing, critic prompt, self-consistency
    policy.js          # trigger + escalation + budget gating + source/system-content filtering
    retrieve.js        # relevance ranking + token budget
    scorers.js         # L1 verifiable checks (code/math/sql/schema auto-detection)
    signal.js          # signal ladder (L1/L3/REFUTED/CONFIRMED + weights)
    store.js           # file store + inverted index (memory cache + debounced background writes + graceful degradation)
    status.js          # snapshot + records + formatStatusReport
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
dsh plugin add github:pk14742952-AD/dsh-host-rsi
```

If your DSH uses a non-default profile, append `--profile <your-profile>` as needed.
The package is **not published to npm yet**; use the GitHub install above, or run
`plugin_manager install_bundle` against a local `dsh-host-rsi/` directory.

Restart DSH after installation; no build step is needed.

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
cd dsh-host-rsi
npm test             # pure logic + data-layer suite (node --test test/*.test.js; does not touch the live-model e2e)
```

## Configuration (bundle line `config`)

See `config.default.json`:
- `enabled` (master switch; false = fully no-op), `dir` (data directory), `flushMs` (background debounce ms);
- `inject.{topK,tokenBudget,candCap,enabled,includeQuarantined,oncePerTask,selfCheck,maxInjectsPerTask,reinjectOn,compactTopK,compactTokenBudget}`;
  `selfCheck: false` skips the mandated `[VERIFY: ...]` trailer, for schema-constrained / structured-output callers;
- `capture.{enabled,maxPerSession,minChars,dedupeThreshold,captureUserCorrections,captureUserInstructions}`;
- `escalate.{enabled,maxCriticsPerSession,selfConsistency,threshold}`;
- `convergence.{enabled,repeatThreshold,models}`: repeated-pass threshold and target models;
  default `[]` = all models, or use a whitelist such as `["*27b*"]`;
- `guard.{enabled,maxRetries,maxPerSession,thresholdEmpty,thresholdFile,sameToolStreak,fileTurnRe,tasksRe,recordTrajectory}`:
  delivery-guard thresholds and retry budget;
- `embeddings` (reserved, default null; can swap in embedding neighbors at larger scale).

Defaults are conservative for local models.

## Evaluation & known limits

- **Cross-session memory** was reproduced end-to-end: 0/5 held-out tasks without the plugin,
  5/5 with it (Fisher exact p = 0.0079), so trusted lessons are demonstrably injected across
  sessions and change behavior.
- **Self-check (the `[VERIFY]` counter-reason trailer)** showed no significant accuracy gain
  in one large-N evaluation (`deepseek-v4.1-flash`, ~350 runs/arm). That result is **not a
  verdict**: the target remains a local 27B model (Qwen3.8-27B), which still needs an on-device
  replication run.
- If you use **JSON Schema / structured output**, set `inject.selfCheck` to `false` so the
  mandated trailer cannot turn a correct answer into an unparseable one (see #3 / #4).
- Original evaluation report: [issue #4](https://github.com/pk14742952-AD/dsh-host-rsi/issues/4).

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
