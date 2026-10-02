// DSH host RSI — plugin glue (host-only bundle).
//
// Wires the pure logic layer (policy + capture + interrogate + store) into DSH events so a
// LOCAL LLM self-improves per use, fully automatically — while being NON-INTRUSIVE:
//   * never blocks the agent: the data layer is an in-memory cache with backgrounded,
//     DEBOUNCED disk writes (lib/store.js); the hot path does no synchronous I/O.
//   * triggers only at specific moments: inject once per turn (task-change gated), capture
//     on turn/end gated by policy.js, critic auto-escalation gated by budget.
//   * degrades to in-memory-only if the data dir is unwritable (store.disabled) — it never
//     throws into the host.
//
// NOTE ON API ASSUMPTIONS: the exact `ctx` event payloads and method shapes are confirmed
// on first activation (via `cordis_inspect_query` for Event/Service). Every DSH call here
// is guarded so a wrong shape no-ops instead of throwing. The real logic lives in lib/*
// and is unit-tested independently of this glue.

import { openStore } from './lib/store.js';
import { buildSelfCheckInstruction, criticPrompt } from './lib/interrogate.js';
import { captureFromContext } from './lib/capture.js';
import { shouldCapture, shouldEscalate, criticBudgetOk } from './lib/policy.js';
import { startDashboardServer, rsiWebserverHandler } from './lib/dashboard.js';
import { snapshot, records as fetchRecords, formatStatusReport } from './lib/status.js';

// Config defaults; users override via the bundle row config (cordis.patch.yml).
export const Config = {
  defaults: {
    enabled: true, // global master switch (false = full no-op)
    dir: 'E:\\DSH\\.rsi-memory',
    flushMs: 500, // background write debounce
    inject: { topK: 4, tokenBudget: 1500, candCap: 40, enabled: true, includeQuarantined: false },
    capture: { enabled: true, maxPerSession: 20, minChars: 200, dedupeThreshold: 0.8 },
    escalate: { enabled: true, maxCriticsPerSession: 4, selfConsistency: 1, threshold: 0.6 },
    dashboard: { enabled: true, host: '127.0.0.1', port: 0, recent: 15, webserver: true },
  },
};

function normalize(config = {}) {
  const d = Config.defaults;
  const merge = (a, b) => ({ ...a, ...(b || {}) });
  return {
    enabled: config.enabled !== false,
    dir: config.dir || d.dir,
    flushMs: typeof config.flushMs === 'number' ? config.flushMs : d.flushMs,
    inject: merge(d.inject, config.inject),
    capture: merge(d.capture, config.capture),
    escalate: merge(d.escalate, config.escalate),
    dashboard: merge(d.dashboard, config.dashboard),
  };
}

// --- Defensive event field extraction (API assumptions; verify on activation) ---
function sessionKey(event, ctx) {
  return event?.sessionId ?? event?.session?.id ?? ctx?.session?.id ?? '_global';
}
function taskText(event) {
  return event?.task ?? event?.input?.text ?? event?.messages?.find?.((m) => m.role === 'user')?.content ?? '';
}
function answerText(event) {
  return event?.assistantText ?? event?.answer ?? event?.messages?.filter?.((m) => m.role === 'assistant')?.map?.((m) => m.content).join('\n') ?? '';
}
function toolResults(event) {
  const tr = event?.toolResults ?? event?.tools ?? [];
  return Array.isArray(tr) ? tr.map((t) => ({ name: t?.name, ok: t?.ok ?? t?.success })) : [];
}

export function apply(ctx, config = {}) {
  const cfg = normalize(config);
  const disposers = [];

  // Master switch off -> full no-op, zero host interaction.
  if (cfg.enabled === false) return () => {};

  const store = openStore(cfg.dir, { flushMs: cfg.flushMs });
  store.ensureLayout();

  // (0) Optional self-hosted LOOPBACK dashboard (the "记忆" view). Idle-cheap (one listening
  //     socket; no CPU until a request); guarded so a bind failure never disturbs the host.
  //     The live URL is surfaced by the rsi_status tool below.
  let dashUrl = null;
  let dashClose = null;
  if (cfg.dashboard?.enabled !== false) {
    startDashboardServer(store, cfg)
      .then((h) => { dashUrl = h.url; dashClose = h.close; })
      .catch(() => {}); // bind failure -> dashboard simply unavailable, plugin still works
  }

  // (0b) bili-style DSH integration — surface RSI state in DSH's OWN web app:
  //   a) inject window.__RSI__ (Settings client tab reads it for the "打开 Web UI" URL + a
  //      live status snapshot), via the `webserver/index-inject` event.
  //   b) register /rsi + /rsi/status.json + /rsi/records.json on DSH's webserver (SAME origin
  //      as the GUI, no CORS) so the Settings tab can live-fetch status + the page embeds.
  //     All guarded: a missing service or an already-claimed /rsi route no-ops (the loopback
  //     dashboard still works independently).
  if (ctx?.on && cfg.dashboard?.webserver !== false) {
    try {
      ctx.on('webserver/index-inject', (table) => {
        try {
          table.push({
            kind: 'global',
            name: '__RSI__',
            value: {
              url: dashUrl ?? undefined, // loopback dashboard (the "Web UI" the button opens)
              basePath: '/rsi/', // same-origin DSH-webserver base (for live status fetch)
              status: snapshot(store, { enabled: cfg.enabled, recent: 5 }),
            },
          });
        } catch { /* never break index.html injection */ }
      });
    } catch { /* host may not expose webserver/index-inject -> no-op */ }
  }
  if (ctx?.inject && cfg.dashboard?.webserver !== false) {
    try {
      ctx.inject(['webServer'], (sub) => {
        const ws = sub?.webServer;
        if (!ws?.register) return; // service absent -> no-op
        try {
          const dispose = ws.register({ kind: 'prefix', path: '/rsi', handler: rsiWebserverHandler(store, cfg) });
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch { /* /rsi already owned by another plugin -> keep the loopback dashboard */ }
      });
    } catch { /* ignore */ }
  }

  const sessions = new Map(); // sessionKey -> { captures, critics, lastTask }
  const sess = (key) => {
    if (!sessions.has(key)) sessions.set(key, { captures: 0, critics: 0, lastTask: null });
    return sessions.get(key);
  };

  // Resolve a followup method (critic escalation), guarded.
  const followup = (p) => {
    if (ctx?.agent?.followup) return ctx.agent.followup(p);
    if (ctx?.followup) return ctx.followup(p);
    return undefined;
  };
  const hasFollowup = !!(ctx?.agent?.followup ?? ctx?.followup);

  // (1) Always-on self-check instruction (cheap; the model does the counter-reason inline).
  if (ctx?.systemPrompt?.section) {
    const d = ctx.systemPrompt.section({ key: 'rsi-selfcheck', text: buildSelfCheckInstruction() });
    if (typeof d === 'function') disposers.push(d);
  }

  // (2) Gated inject on pre-step — ONCE PER TURN (task-change gated) to avoid re-doing the
  //     search/inject on every step of a multi-step turn. In-memory only; no disk I/O here.
  if (cfg.inject.enabled && ctx?.on) {
    ctx.on('agent/pre-step', (event, next) => {
      try {
        const key = sessionKey(event, ctx);
        const task = taskText(event);
        const s = sess(key);
        if (task && task !== s.lastTask) {
          s.lastTask = task;
          const block = store.search(task, cfg.inject); // in-memory, budget-capped
          if (block) {
            const agent = event?.agent ?? ctx?.agent;
            if (agent?.inject) agent.inject(block);
            else if (ctx?.systemPrompt?.section) {
              const d = ctx.systemPrompt.section({ key: `rsi-inject-${key}`, text: block });
              if (typeof d === 'function') disposers.push(d);
            }
          }
        }
      } catch {
        /* never block the waterfall */
      }
      return next?.(); // forward the waterfall unless we own the decision
    });
  }

  // (3) Gated capture + (4) auto-escalate critic on turn/end.
  //     capture is short-circuited by shouldCapture (policy.js) BEFORE any persistence;
  //     addLesson/addTrajectory only enqueue a backgrounded flush (no blocking I/O).
  if (cfg.capture.enabled && ctx?.on) {
    ctx.on('turn/end', (event) => {
      try {
        const key = sessionKey(event, ctx);
        const s = sess(key);
        const task = taskText(event);
        const answer = answerText(event);
        const tools = toolResults(event);
        const r = captureFromContext({
          task: { text: task },
          answerText: answer,
          toolResults: tools,
          userTap: event?.userTap,
          threshold: cfg.escalate.threshold,
        });
        if (shouldCapture({ taskText: task, answerText: answer, toolResults: tools, cfg, session: s, existingTop: store.findSimilar(r.lesson, 8) })) {
          if (r.capture) {
            store.addLesson({ ...r.lesson, sourceRef: event?.id ?? null }); // enqueues background write
            store.addTrajectory({ ...r.trajectory, id: event?.id ?? undefined });
            s.captures += 1;
          }
          const esc = shouldEscalate({ scorer: r.scorer, verdict: r.tag?.verdict, conf: r.tag?.conf, tag: r.tag, threshold: cfg.escalate.threshold });
          if (esc.do && hasFollowup && criticBudgetOk({ cfg, session: s })) {
            const n = cfg.escalate.selfConsistency ?? 1;
            for (let i = 0; i < n && s.critics < (cfg.escalate.maxCriticsPerSession ?? 4); i += 1) {
              followup(criticPrompt(task, answer));
              s.critics += 1;
            }
          }
        }
      } catch {
        /* capture must never crash the turn */
      }
    });
  }

  // (5) Optional forced deep-verify tool (user requests it explicitly).
  if (ctx?.tools?.register) {
    const d = ctx.tools.register({
      name: 'rsi_verify',
      description: 'Force an independent critic round to re-check the current answer (deep-verify).',
      run: async (event) => {
        try {
          const key = sessionKey(event, ctx);
          const s = sess(key);
          if (!criticBudgetOk({ cfg, session: s })) return { ok: false, why: 'critic budget exhausted this session' };
          if (!hasFollowup) return { ok: false, why: 'critic unavailable in this profile' };
          followup(criticPrompt(taskText(event), answerText(event)));
          s.critics += 1;
          return { ok: true, why: 'critic round scheduled' };
        } catch {
          return { ok: false, why: 'critic unavailable in this profile' };
        }
      },
    });
    if (typeof d === 'function') disposers.push(d);

    // (6) Status + records tools -> let the user (or model) read live plugin state and get the
    //     dashboard URL. Read-only, cheap (in-memory snapshot; no capture-side effect).
    const sd = ctx.tools.register({
      name: 'rsi_status',
      description: 'Show DSH-host-RSI status: enabled/degraded, lesson totals (trusted/quarantined/trajectories), layer breakdown, recent records, and the live dashboard URL.',
      run: async () => {
        try {
          const snap = snapshot(store, { enabled: cfg.enabled, recent: 8 });
          return formatStatusReport(snap, dashUrl); // bili-style: 文本报告 + "可点击仪表板/状态" 行
        } catch (e) {
          return { enabled: cfg.enabled, error: String(e && e.message) };
        }
      },
    });
    if (typeof sd === 'function') disposers.push(sd);
    const rd = ctx.tools.register({
      name: 'rsi_records',
      description: 'List recent RSI memory records (lessons). Args: { limit?, trustedOnly?, domain? }. Newest first.',
      run: async (event) => {
        try {
          const q = event?.args ?? event?.input ?? event ?? {};
          return fetchRecords(store, { limit: q.limit ?? 15, trustedOnly: q.trustedOnly, domain: q.domain });
        } catch (e) {
          return { error: String(e && e.message) };
        }
      },
    });
    if (typeof rd === 'function') disposers.push(rd);
  }

  // cleanup: best-effort background flush + stop timers; never throw into the host.
  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    disposers.length = 0;
    sessions.clear();
    try { dashClose?.(); } catch { /* ignore */ }
    try {
      store.close();
    } catch {
      /* ignore */
    }
  };
}
