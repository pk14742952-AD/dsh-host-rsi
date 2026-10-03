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
import { captureFromContext, captureUserCorrection, captureUserInstruction } from './lib/capture.js';
import { outcomeSignal, shouldCapture, shouldEscalate, criticBudgetOk, isUserCorrection, isUserInstruction } from './lib/policy.js';
import { startDashboardServer, rsiWebserverHandler } from './lib/dashboard.js';
import { snapshot, records as fetchRecords, formatStatusReport } from './lib/status.js';

// Config defaults; users override via the bundle row config (cordis.patch.yml).
// Safely read a (possibly proxied) ctx service property without triggering cordis'
// "cannot get property X without inject" proxy trap. Optional chaining (?.) does NOT
// guard against proxy get-trap throws, so every ctx.<service> access must go through here.
// This keeps the plugin compatible with any DSH version regardless of which services exist.
function safeGet(obj, ...props) {
  try {
    let val = obj;
    for (const p of props) {
      if (val == null) return undefined;
      val = val[p];
    }
    return val;
  } catch {
    return undefined;
  }
}

// Config defaults; users override via the bundle row config (cordis.patch.yml).
// NOT exported: cordis resolveConfig() calls runtime.Config["~standard"].validate() which
// crashes on a plain object. By not exporting, resolveConfig sees !runtime.Config and
// returns the config as-is (no validation). This matches billion-context's pattern.
const Config = {
  defaults: {
    enabled: true, // global master switch (false = full no-op)
    dir: 'E:\\DSH\\.rsi-memory',
    flushMs: 1000, // background write debounce
    inject: {
      enabled: true,
      topK: 3,
      tokenBudget: 1000,
      candCap: 40,
      includeQuarantined: false,
      // Balanced default: first injection on task change, then only small re-injections
      // when the same task hits a real failure or repeats the same failure.
      oncePerTask: false,
      maxInjectsPerTask: 2,
      reinjectOn: ['tool-failure', 'repeated-failure'],
      compactTopK: 1,
      compactTokenBudget: 300,
    },
    capture: { enabled: true, maxPerSession: 10, minChars: 120, dedupeThreshold: 0.8, captureUserCorrections: true, captureUserInstructions: true },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
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
  return event?.task ?? event?.input?.text ?? event?.messages?.find?.((m) => m.role === 'user')?.content ?? (event?.message?.role === 'user' ? event?.message?.content : '') ?? (event?.role === 'user' ? event?.content : '') ?? '';
}
function answerText(event) {
  return event?.assistantText ?? event?.answer ?? event?.message?.content ?? event?.content ?? event?.messages?.filter?.((m) => m.role === 'assistant')?.map?.((m) => m.content).join('\n') ?? '';
}
function toolResults(event) {
  const tr = event?.toolResults ?? event?.tools ?? [];
  return Array.isArray(tr) ? tr.map((t) => ({ name: t?.name, ok: t?.ok ?? t?.success })) : [];
}

// DSH event-name fallback set. DSH releases have called the same lifecycle moments by
// different names (turn/end, agent/turn/end, chat/message, ...). We register as many as
// exist and dedupe by event object / payload digest so a single real turn never double-fires.
const PRE_STEP_EVENTS = ['agent/pre-step', 'pre-step', 'agent/step', 'session/step'];
const TURN_END_EVENTS = ['turn/end', 'agent/turn/end', 'chat/turn/end', 'session/turn/end', 'turn/finish'];
const MESSAGE_EVENTS = ['message', 'agent/message', 'chat/message', 'user/message', 'assistant/message', 'bot/message'];

export function apply(ctx, config = {}) {
  const cfg = normalize(config);
  const disposers = [];

  // Master switch off -> full no-op, zero host interaction.
  if (cfg.enabled === false) return () => {};

  const store = openStore(cfg.dir, { flushMs: cfg.flushMs });
  store.ensureLayout();

  // Live trigger diagnostics. This is what lets a user see the plugin working even
  // before the lesson table fills up: how many lifecycle events were observed, how many
  // injections/captures/failures happened, and what the last trigger was.
  const runtime = {
    startedAt: Date.now(),
    sources: {},
    eventsSeen: 0,
    turnsSeen: 0,
    injects: 0,
    reInjects: 0,
    captures: 0,
    corrections: 0,
    instructions: 0,
    failures: 0,
    critics: 0,
    taskChanges: 0,
    skippedCapture: 0,
    lastEvent: null,
    lastEventAt: null,
    lastCapture: null,
    lastCorrection: null,
    lastInstruction: null,
    lastInject: null,
    lastReason: null,
  };
  const runtimeSnapshot = () => ({ ...runtime, sources: { ...runtime.sources } });
  const recordEvent = (name) => {
    runtime.sources[name] = (runtime.sources[name] || 0) + 1;
    runtime.eventsSeen += 1;
    runtime.lastEvent = name;
    runtime.lastEventAt = Date.now();
  };
  const liveSnapshot = () => ({
    ...snapshot(store, { enabled: cfg.enabled, recent: cfg.dashboard?.recent ?? 15 }),
    runtime: runtimeSnapshot(),
  });

  // (0) Optional self-hosted LOOPBACK dashboard (the "记忆" view). Idle-cheap (one listening
  //     socket; no CPU until a request); guarded so a bind failure never disturbs the host.
  //     The live URL is surfaced by the rsi_status tool below.
  let dashUrl = null;
  let dashClose = null;
  if (cfg.dashboard?.enabled !== false) {
    startDashboardServer(store, cfg, liveSnapshot)
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
              status: liveSnapshot(),
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
          const dispose = ws.register({ kind: 'prefix', path: '/rsi', handler: rsiWebserverHandler(store, cfg, liveSnapshot) });
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch { /* /rsi already owned by another plugin -> keep the loopback dashboard */ }
      });
    } catch { /* ignore */ }
  }

  const sessions = new Map(); // sessionKey -> { captures, critics, lastTask, inject state }
  const sess = (key) => {
    if (!sessions.has(key)) {
      sessions.set(key, {
        captures: 0,
        critics: 0,
        lastTask: null,
        lastTaskInjectCount: 0,
        failureStreak: 0,
        pendingReinject: false,
        reinjectQuery: '',
        injectDispose: null,
      });
    }
    return sessions.get(key);
  };

  // Push a lesson block into the running context. If only systemPrompt.section is
  // available, reuse one key and dispose the previous section so old injections do
  // not pile up across turns.
  function pushInjection(s, event, query, opts) {
    const block = store.search(query, opts); // in-memory, budget-capped
    if (!block) return false;
    const agent = event?.agent ?? safeGet(ctx, 'agent');
    if (agent?.inject) {
      try {
        agent.inject(block);
        return true;
      } catch {
        return false;
      }
    }
    const sp = safeGet(event, 'systemPrompt') ?? systemPrompt;
    if (sp?.section) {
      try {
        if (typeof s.injectDispose === 'function') {
          s.injectDispose();
          s.injectDispose = null;
        }
        const d = sp.section({ key: 'rsi-inject', text: block });
        if (typeof d === 'function') s.injectDispose = d;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function reinjectAllowed(type) {
    return Array.isArray(cfg.inject.reinjectOn) && cfg.inject.reinjectOn.includes(type);
  }

  // Resolve a followup method (critic escalation), guarded.
  const followup = (p) => {
    const fn = safeGet(ctx, 'agent', 'followup') ?? safeGet(ctx, 'followup');
    if (fn) return fn(p);
    return undefined;
  };
  const hasFollowup = !!(safeGet(ctx, 'agent', 'followup') ?? safeGet(ctx, 'followup'));

  // Shared lifecycle helpers. These are API-shape agnostic: they read whatever field
  // DSH exposes (task / input.text / messages / content / assistantText), dedupe by
  // event object or payload digest, and no-op on any unknown shape.
  const seenEvents = new WeakSet();
  const seenDigests = new Map();
  const lastUserBySession = new Map();
  const lastAssistantBySession = new Map();
  let selfCheckDispose = null;

  function eventDigest(event, key) {
    const s = `${String(taskText(event))}\x00${String(answerText(event))}`;
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `${key}:${h}`;
  }

  function markSeen(event, key) {
    if (event && typeof event === 'object') {
      if (seenEvents.has(event)) return true;
      seenEvents.add(event);
      return false;
    }
    const d = eventDigest(event, key);
    const now = Date.now();
    if (seenDigests.has(d) && now - seenDigests.get(d) < 2500) return true;
    seenDigests.set(d, now);
    return false;
  }

  function ensureSelfCheck(event) {
    const sp = safeGet(event, 'systemPrompt') ?? systemPrompt;
    if (!sp?.section) return;
    try {
      if (typeof selfCheckDispose === 'function') selfCheckDispose();
      const d = sp.section({ key: 'rsi-selfcheck', text: buildSelfCheckInstruction() });
      if (typeof d === 'function') selfCheckDispose = d;
    } catch { /* systemPrompt.section unavailable -> no-op */ }
  }

  function handlePreStep(event, source) {
    recordEvent(source);
    try {
      const key = sessionKey(event, ctx);
      const task = taskText(event);
      const s = sess(key);
      if (!task) return;
      ensureSelfCheck(event);
      if (task !== s.lastTask) {
        s.lastTask = task;
        s.lastTaskInjectCount = 0;
        s.failureStreak = 0;
        s.pendingReinject = false;
        s.reinjectQuery = '';
        runtime.taskChanges += 1;
        const opts = cfg.inject.oncePerTask
          ? cfg.inject
          : { ...cfg.inject, topK: cfg.inject.topK, tokenBudget: cfg.inject.tokenBudget };
        if (pushInjection(s, event, task, opts)) {
          s.lastTaskInjectCount += 1;
          runtime.injects += 1;
          runtime.lastInject = task;
        }
      } else if (
        !cfg.inject.oncePerTask &&
        task &&
        s.lastTask === task &&
        s.lastTaskInjectCount < (cfg.inject.maxInjectsPerTask ?? 2)
      ) {
        const toolReinject = s.pendingReinject && reinjectAllowed('tool-failure');
        const repeatReinject = s.failureStreak >= 2 && reinjectAllowed('repeated-failure');
        if (toolReinject || repeatReinject) {
          const query = s.reinjectQuery || task;
          const opts = {
            ...cfg.inject,
            topK: cfg.inject.compactTopK ?? 1,
            tokenBudget: cfg.inject.compactTokenBudget ?? 300,
          };
          if (pushInjection(s, event, query, opts)) {
            s.lastTaskInjectCount += 1;
            s.pendingReinject = false;
            runtime.reInjects += 1;
            runtime.injects += 1;
            runtime.lastInject = task;
          }
        }
      }
    } catch {
      /* never block the waterfall */
    }
  }

  function handleMessage(event, source) {
    recordEvent(source);
    try {
      const key = sessionKey(event, ctx);
      const role = String(event?.role ?? event?.kind ?? event?.type ?? event?.message?.role ?? '').toLowerCase();
      const content = String(event?.message?.content ?? event?.content ?? event?.text ?? event?.assistantText ?? event?.answer ?? '');
      if (role && role.includes('user')) {
        const prev = lastAssistantBySession.get(key);
        const s = sess(key);
        const maxCap = cfg.capture.maxPerSession ?? 10;
        const canCapture = cfg.capture.enabled && s.captures < maxCap;
        const correctionWanted = canCapture && cfg.capture.captureUserCorrections !== false && prev && isUserCorrection({ correctionText: content });
        if (correctionWanted) {
          const rec = captureUserCorrection({ taskText: prev.task || taskText(event), correctionText: content });
          if (rec) {
            const existingTop = store.findSimilar(rec.lesson, 8);
            if (!existingTop || existingTop.overlap < (cfg.capture.dedupeThreshold ?? 0.8)) {
              store.addLesson({ ...rec.lesson, sourceRef: event?.id ?? null });
              store.addTrajectory({ ...rec.trajectory, id: event?.id ?? undefined });
              s.captures += 1;
              runtime.corrections += 1;
              runtime.captures += 1;
              runtime.lastCorrection = content;
              runtime.lastCapture = prev.task || content;
            }
          }
        }
        const instructionWanted = cfg.capture.enabled && cfg.capture.captureUserInstructions !== false && s.captures < maxCap && isUserInstruction({ instructionText: content }) && !correctionWanted;
        if (instructionWanted) {
          const rec = captureUserInstruction({ instructionText: content });
          if (rec) {
            const existingTop = store.findSimilar(rec.lesson, 8);
            if (!existingTop || existingTop.overlap < (cfg.capture.dedupeThreshold ?? 0.8)) {
              store.addLesson({ ...rec.lesson, sourceRef: event?.id ?? null });
              store.addTrajectory({ ...rec.trajectory, id: event?.id ?? undefined });
              s.captures += 1;
              runtime.instructions += 1;
              runtime.captures += 1;
              runtime.lastInstruction = content;
              runtime.lastCapture = content;
            }
          }
        }
        lastUserBySession.set(key, { task: taskText(event) || content, at: Date.now() });
        return;
      }
      const isAssistant = role.includes('assistant') || role.includes('bot') || role.includes('model') || !!event?.assistantText || !!event?.message?.content;
      if (isAssistant) {
        const last = lastUserBySession.get(key);
        const merged = { ...event, task: event?.task || last?.task || '', sessionId: event?.sessionId ?? key, assistantText: event?.assistantText ?? content, content };
        lastAssistantBySession.set(key, { task: merged.task, answer: content, at: Date.now() });
        handleTurnEnd(merged, source + ':assistant');
      }
    } catch { /* never block the event */ }
  }

  function handleTurnEnd(event, source) {
    recordEvent(source);
    const key = sessionKey(event, ctx);
    if (markSeen(event, key)) return;
    try {
      const s = sess(key);
      const task = taskText(event);
      const answer = answerText(event);
      const tools = toolResults(event);
      runtime.turnsSeen += 1;

      if (task && task === s.lastTask) {
        const sig = outcomeSignal({ taskText: task, answerText: answer, toolResults: tools });
        if (sig.hadFailure) {
          s.failureStreak += 1;
          runtime.failures += 1;
          s.pendingReinject = true;
          const failedNames = tools.filter((t) => t && t.ok === false).map((t) => t.name).filter(Boolean);
          s.reinjectQuery = [task, ...failedNames].filter(Boolean).join(' ');
        } else {
          s.failureStreak = 0;
        }
      }

      if (cfg.capture.enabled) {
        const r = captureFromContext({
          task: { text: task },
          answerText: answer,
          toolResults: tools,
          userTap: event?.userTap,
          threshold: cfg.escalate.threshold,
        });
        const sig = outcomeSignal({ taskText: task, answerText: answer, toolResults: tools });
        runtime.lastReason = sig.hasVerifyTag ? 'verify-tag' : sig.hadFailure ? 'failure' : sig.ranTools ? 'tool-run' : 'decision';
        const existingTop = store.findSimilar(r.lesson, 8);
        if (r.capture && shouldCapture({ taskText: task, answerText: answer, toolResults: tools, cfg, session: s, existingTop })) {
          store.addLesson({ ...r.lesson, sourceRef: event?.id ?? null }); // enqueues background write
          store.addTrajectory({ ...r.trajectory, id: event?.id ?? undefined });
          s.captures += 1;
          runtime.captures += 1;
          runtime.lastCapture = task;

          const esc = shouldEscalate({ scorer: r.scorer, verdict: r.tag?.verdict, conf: r.tag?.conf, tag: r.tag, threshold: cfg.escalate.threshold });
          if (esc.do && hasFollowup && criticBudgetOk({ cfg, session: s })) {
            const n = cfg.escalate.selfConsistency ?? 1;
            for (let i = 0; i < n && s.critics < (cfg.escalate.maxCriticsPerSession ?? 4); i += 1) {
              followup(criticPrompt(task, answer));
              s.critics += 1;
              runtime.critics += 1;
            }
          }
        } else if (sig.hasVerifyTag || sig.hadFailure || sig.ranTools) {
          runtime.skippedCapture += 1;
        }
      }
    } catch {
      /* capture must never crash the turn */
    }
  }

  // (1) Always-on self-check instruction (cheap; the model does the counter-reason inline).
  const systemPrompt = safeGet(ctx, 'systemPrompt');
  ensureSelfCheck({});

  // (2) Gated inject on pre-step. Default behavior is balanced: full injection on task
  //     change, then only small re-injections when the same task fails and reinjectOn
  //     enables that path. oncePerTask=true restores the old strict single-inject mode.
  if (cfg.inject.enabled && ctx?.on) {
    for (const name of PRE_STEP_EVENTS) {
      try {
        ctx.on(name, (event, next) => {
          handlePreStep(event, name);
          return next?.();
        });
      } catch { /* host may not expose this event -> no-op */ }
    }
  }

  // (3) turn/end: failure tracking for balanced injection, plus gated capture and
  //     auto-escalate. Capture is short-circuited by shouldCapture BEFORE persistence;
  //     addLesson/addTrajectory only enqueue a backgrounded flush (no blocking I/O).
  if (ctx?.on) {
    for (const name of TURN_END_EVENTS) {
      try {
        ctx.on(name, (event) => handleTurnEnd(event, name));
      } catch { /* host may not expose this event -> no-op */ }
    }
    for (const name of MESSAGE_EVENTS) {
      try {
        ctx.on(name, (event) => handleMessage(event, name));
      } catch { /* host may not expose this event -> no-op */ }
    }
  }

  // (5) Optional forced deep-verify tool (user requests it explicitly).
  const tools = safeGet(ctx, 'tools');
  if (tools?.register) {
    const d = tools.register({
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
    const sd = tools.register({
      name: 'rsi_status',
      description: 'Show DSH-host-RSI status: enabled/degraded, lesson totals (trusted/quarantined/trajectories), layer breakdown, recent records, and the live dashboard URL.',
      run: async () => {
        try {
          const snap = liveSnapshot();
          return formatStatusReport(snap, dashUrl); // bili-style: 文本报告 + "可点击仪表板/状态" 行
        } catch (e) {
          return { enabled: cfg.enabled, error: String(e && e.message) };
        }
      },
    });
    if (typeof sd === 'function') disposers.push(sd);
    const rd = tools.register({
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

    // (7) Diagnostics + demo tools. rsi_events gives a human/agent-readable view of the
    //     trigger path; rsi_demo_capture writes one sample trusted lesson so new users can
    //     immediately see the dashboard/settings page render real data (demo/testing only).
    const ed = tools.register({
      name: 'rsi_events',
      description: 'Show plugin trigger diagnostics: lifecycle event names seen, turn/inject/capture/failure counters, and the last event.',
      run: async () => runtimeSnapshot(),
    });
    if (typeof ed === 'function') disposers.push(ed);

    const dd = tools.register({
      name: 'rsi_demo_capture',
      description: 'Add one sample trusted lesson to the RSI memory (for demo/testing) so the dashboard and settings tab have visible data immediately.',
      run: async () => {
        try {
          const id = store.addLesson({
            domain: 'demo',
            tags: ['demo', 'rsi'],
            summary: 'RSI demo: plugin is running and recording data',
            fix: 'Run a real task next; trusted lessons are injected on similar future work',
            layer: 'L2',
            trusted: true,
            weight: 0.8,
          });
          store.addTrajectory({ id: id ? `${id}-demo` : undefined, ts: Date.now(), task: 'demo', domain: 'demo', lesson: 'sample demo lesson', layer: 'L2', trusted: true });
          store.flushSync();
          return { ok: true, id, note: 'sample trusted lesson added (visible in settings/dashboard)' };
        } catch (e) {
          return { ok: false, error: String(e && e.message) };
        }
      },
    });
    if (typeof dd === 'function') disposers.push(dd);
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
    seenDigests.clear();
    lastUserBySession.clear();
    lastAssistantBySession.clear();
    try { selfCheckDispose?.(); } catch { /* ignore */ }
    selfCheckDispose = null;
    try { dashClose?.(); } catch { /* ignore */ }
    try {
      store.close();
    } catch {
      /* ignore */
    }
  };
}
