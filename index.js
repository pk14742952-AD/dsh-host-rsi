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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './lib/store.js';
import { buildSelfCheckInstruction, criticPrompt } from './lib/interrogate.js';
import { captureFromContext, captureUserCorrection, captureUserInstruction } from './lib/capture.js';
import { outcomeSignal, shouldCapture, shouldEscalate, criticBudgetOk, isUserCorrection, isUserInstruction, isDurableUserInstruction, isSystemLikeText, projectFromText } from './lib/policy.js';
import { STRONG_STEER, SOFT_STEER, POLICY_TEXT, commandOf, createState, isModelActive, isShellTool, isSourceEdit, normalizeModels, observeShell, resetState, resultText } from './lib/convergence.js';
import { classifyLoop, guardCorrectionPrompt, isFileTurn } from './lib/guard.js';
import { startDashboardServer, rsiWebserverHandler } from './lib/dashboard.js';
import { snapshot, records as fetchRecords, formatStatusReport } from './lib/status.js';

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || pkgVersion;
} catch {
  /* version display is best-effort */
}

// One /rsi route per process. DSH can re-apply a plugin without disposing the old
// instance; re-registering then leaves the previous closure serving a frozen snapshot.
// Keep a single delegating handler and swap the live store/config/snapshot on every apply.
let webRoute = null; // { dispose }
let webRouteStore = null;
let webRouteCfg = null;
let webRouteSnapshot = null;
function rsiRouteHandler(req, res) {
  if (!webRouteStore) {
    try {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('RSI route not ready');
    } catch { /* ignore */ }
    return;
  }
  rsiWebserverHandler(webRouteStore, webRouteCfg, webRouteSnapshot)(req, res);
}

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

// Default data dir follows the DSH home convention (~/.dsh, like DSH's own storages and
// billion-context's homedir-based paths) instead of a hardcoded drive letter: a hardcoded
// path creates an unexpected folder on that drive for every user who installs the plugin.
// Resolution order: DSH_HOME env (same var DSH's host.js reads) -> os.homedir().
function defaultDir() {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || os.homedir();
  return path.join(home, '.dsh', 'rsi-memory');
}
// One-time migration from the pre-0.1.12 hardcoded default. If the legacy dir has data
// and the new default dir does not exist yet, copy it over so users keep their lessons.
// RSI_LEGACY_DIR env overrides the legacy location (for testing).
function migrateLegacyDir(target) {
  const legacy = (process.env.RSI_LEGACY_DIR && process.env.RSI_LEGACY_DIR.trim()) || path.join('E:\\', 'DSH', '.rsi-memory');
  try {
    if (!fs.existsSync(legacy) || fs.existsSync(target)) return;
    if (path.resolve(legacy).toLowerCase() === path.resolve(target).toLowerCase()) return;
    fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
  } catch {
    /* migration is best-effort: store degrades gracefully on failure */
  }
}

const Config = {
  defaults: {
    enabled: true, // global master switch (false = full no-op)
    dir: null, // resolved at apply() time via defaultDir() (DSH_HOME/homedir aware)
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
      selfCheck: true,
      maxInjectsPerTask: 2,
      reinjectOn: ['tool-failure', 'repeated-failure'],
      compactTopK: 1,
      compactTokenBudget: 300,
    },
    capture: { enabled: true, maxPerSession: 10, minChars: 120, dedupeThreshold: 0.8, captureUserCorrections: true, captureUserInstructions: true },
    importRecent: { enabled: true, limit: 30, sessions: 10 },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
    dashboard: { enabled: true, host: '127.0.0.1', port: 0, recent: 15, webserver: true },
    convergence: {
      enabled: true, // ported from dsh-bonsai-fast / pi-extension-convergence
      repeatThreshold: 3,
      // Empty list = every model DSH runs (local 27B, Flash, API). Set e.g. ['*27b*']
      // only when a user wants to restrict convergence steering to specific models.
      models: [],
    },
    guard: {
      enabled: true, // L3 delivery guard from D:\ninfer 04/05 防治文档
      maxRetries: 2,
      maxPerSession: 4,
      thresholdEmpty: 400,
      thresholdFile: 2000,
      sameToolStreak: 3,
      fileTurnRe: 'file|write|create|generate|implement|fix|script|\.(?:js|ts|py|json|md|yml|yaml)|文件|创建|编写|生成|修复|脚本',
      tasksRe: 'write|create|fix|implement|optimize|design|analyze|generate|refactor|debug|test|build|migrate|check|translate|convert|编写|写|创建|修复|实现|优化|设计|分析|生成|重构|调试|测试|构建|迁移|检查|翻译|转换',
      recordTrajectory: true,
    },
  },
};

function normalize(config = {}) {
  const d = Config.defaults;
  const merge = (a, b) => ({ ...a, ...(b || {}) });
  return {
    enabled: config.enabled !== false,
    dir: config.dir || defaultDir(),
    flushMs: typeof config.flushMs === 'number' ? config.flushMs : d.flushMs,
    inject: merge(d.inject, config.inject),
    capture: merge(d.capture, config.capture),
    importRecent: merge(d.importRecent, config.importRecent),
    escalate: merge(d.escalate, config.escalate),
    dashboard: merge(d.dashboard, config.dashboard),
    convergence: {
      ...d.convergence,
      ...(config.convergence || {}),
      models: config.convergence?.models === undefined ? d.convergence.models : normalizeModels(config.convergence.models),
    },
    guard: merge(d.guard, config.guard),
  };
}

// --- Defensive event field extraction (API assumptions; verify on activation) ---
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    return typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : '';
  }
  return '';
}

function eventData(event) {
  return event?.data && typeof event.data === 'object' ? event.data : {};
}

function eventMessage(event) {
  const data = eventData(event);
  if (data.message && typeof data.message === 'object') return data.message;
  if (event?.message && typeof event.message === 'object') return event.message;
  if (data && typeof data === 'object' && (data.content || data.role || data.source)) return data;
  return null;
}

function eventRole(event) {
  const m = eventMessage(event);
  return String(event?.role ?? event?.kind ?? event?.type ?? event?.message?.role ?? m?.role ?? '').toLowerCase();
}

function eventType(event) {
  return String(event?.type ?? event?.kind ?? event?.role ?? event?.message?.type ?? '').toLowerCase();
}

function eventSourceKind(event) {
  const data = eventData(event);
  const m = eventMessage(event);
  const raw =
    safeGet(m, 'source', 'kind') ??
    safeGet(data, 'source', 'kind') ??
    safeGet(event, 'source', 'kind') ??
    safeGet(event, 'message', 'source', 'kind') ??
    safeGet(data, 'message', 'source', 'kind');
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

function sessionKey(event, ctx) {
  return event?.sessionId ?? event?.session?.id ?? event?.data?.sessionId ?? event?.data?.session?.id ?? eventMessage(event)?.sessionId ?? ctx?.session?.id ?? '_global';
}
function systemPromptService(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const sp = ctx.get('systemPrompt');
      if (sp && typeof sp === 'object') return sp;
    }
  } catch {
    /* fall through to safe property read */
  }
  return safeGet(ctx, 'systemPrompt');
}
function agentModelOf(agent) {
  if (!agent || typeof agent !== 'object') return undefined;
  const session = safeGet(agent, 'session');
  if (session && typeof session.requestContext === 'function') {
    try {
      return session.requestContext()?.model;
    } catch {
      /* fall through to static model fields */
    }
  }
  return safeGet(agent, 'model') ?? safeGet(agent, 'session', 'model');
}
function eventProject(event, fallbackText = '') {
  const direct =
    safeGet(event, 'project') ??
    safeGet(event, 'workspace') ??
    safeGet(event, 'cwd') ??
    safeGet(event, 'projectId') ??
    safeGet(event, 'data', 'project') ??
    safeGet(event, 'data', 'workspace') ??
    safeGet(event, 'data', 'cwd') ??
    safeGet(event, 'session', 'project') ??
    safeGet(event, 'session', 'workspace') ??
    safeGet(event, 'session', 'cwd');
  if (direct) return String(direct).trim() || null;
  return projectFromText(fallbackText);
}
function taskText(event) {
  const role = eventRole(event);
  const type = eventType(event);
  const m = eventMessage(event);
  const direct = typeof event?.task === 'string' ? event.task : typeof event?.input?.text === 'string' ? event.input.text : typeof event?.prompt === 'string' ? event.prompt : '';
  if (direct) return direct;
  if (role.includes('user') || type.includes('user')) {
    return contentText(m?.content) || contentText(event?.content) || contentText(event?.text) || (event?.messages?.find?.((x) => x?.role === 'user') ? contentText(event.messages.find((x) => x.role === 'user').content) : '');
  }
  return '';
}
function answerText(event) {
  const role = eventRole(event);
  const type = eventType(event);
  const m = eventMessage(event);
  const content = contentText(m?.content) || contentText(event?.content);
  if (typeof event?.assistantText === 'string' && event.assistantText) return event.assistantText;
  if (typeof event?.answer === 'string' && event.answer) return event.answer;
  if (role.includes('assistant') || type.includes('assistant') || type.includes('bot') || role.includes('bot') || role.includes('model')) return content;
  if (m?.content || event?.message?.content) return content;
  return event?.messages?.filter?.((x) => x?.role === 'assistant')?.map?.((x) => contentText(x.content)).filter(Boolean).join('\n') || '';
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
const SESSION_EVENT = 'session/event';

export function apply(ctx, config = {}) {
  const cfg = normalize(config);
  const disposers = [];

  // Master switch off -> full no-op, zero host interaction.
  if (cfg.enabled === false) return () => {};

  // Migration must run BEFORE openStore: openStore creates the dir layout, and
  // migrateLegacyDir skips copying when the target already exists. Only skip when the
  // user chose an explicit dir in config — a DSH_HOME-set default is still auto-migrated.
  if (!config.dir) migrateLegacyDir(cfg.dir);
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
    blockedNoise: 0,
    convergence: { steers: 0, strong: 0, soft: 0 },
    guard: { fired: 0, retries: 0, rescued: 0, undelivered: 0 },
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
    ...snapshot(store, { enabled: cfg.enabled, recent: cfg.dashboard?.recent ?? 15, version: pkgVersion }),
    runtime: runtimeSnapshot(),
  });
  importRecentInstructions();

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
          // Always refresh the shared route state so a re-applied instance stops serving
          // the first instance's frozen snapshot; register only once per process.
          webRouteStore = store;
          webRouteCfg = cfg;
          webRouteSnapshot = liveSnapshot;
          if (!webRoute) {
            const dispose = ws.register({ kind: 'prefix', path: '/rsi', handler: rsiRouteHandler });
            webRoute = { dispose: typeof dispose === 'function' ? dispose : null };
          }
          if (webRoute.dispose) disposers.push(webRoute.dispose);
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
        guardRetries: 0,
        guardAwaiting: null,
        prevAnswer: '',
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
    const sp = safeGet(event, 'systemPrompt') ?? systemPromptService(ctx);
    if (sp?.section) {
      try {
        if (typeof s.injectDispose === 'function') {
          s.injectDispose();
          s.injectDispose = null;
        }
        const d = sp.section({ name: 'rsi-inject', order: 320, text: block });
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

  // Convergence state is per-agent: the same agent carries the pass/fingerprint history
  // across tool steps until an edit/write resets it (same model as dsh-bonsai-fast).
  const convergenceStates = new WeakMap();
  const convergenceStateOf = (agent) => {
    let st = convergenceStates.get(agent);
    if (!st) {
      st = createState();
      convergenceStates.set(agent, st);
    }
    return st;
  };
  const convergenceActiveFor = (agent) => {
    if (cfg.convergence.enabled === false) return false;
    return isModelActive(agentModelOf(agent), cfg.convergence.models);
  };
  let convergencePolicyDispose = null;
  function registerConvergencePolicy() {
    if (cfg.convergence.enabled === false) return;
    const sp = systemPromptService(ctx);
    if (!sp?.section) return;
    try {
      if (typeof convergencePolicyDispose === 'function') convergencePolicyDispose();
      const d = sp.section({
        name: 'rsi-convergence-policy',
        order: 350,
        text: (assembleCtx) => (convergenceActiveFor(assembleCtx?.scope ?? assembleCtx?.agent) ? POLICY_TEXT : ''),
      });
      if (typeof d === 'function') convergencePolicyDispose = d;
    } catch { /* host may not support dynamic sections -> no-op */ }
  }

  // L3 delivery guard: before capture, decide whether the turn actually delivered a
  // usable answer. On a failure state the plugin asks the model to immediately re-output
  // a complete, closed deliverable instead of recording a broken lesson. Retry budget is
  // per turn (maxRetries) and per session (maxPerSession); after exhaustion the rejected
  // turn is logged as a quarantined trajectory so the user still sees what happened.
  function guardEligible(task, tools) {
    if (tools.length > 0) return true; // tool loops always worth watching
    const re = cfg.guard?.tasksRe;
    if (!re) return true;
    try {
      return new RegExp(re, 'i').test(String(task || ''));
    } catch {
      return false;
    }
  }
  function runGuard(s, event, task, answer, tools) {
    const g = cfg.guard || {};
    if (g.enabled === false) return false;
    if (!guardEligible(task, tools)) return false;
    const verdict = classifyLoop({
      answerText: answer,
      prevAnswerText: s.prevAnswer || '',
      toolCalls: tools.map((t) => t?.name).filter(Boolean),
      ranTools: tools.length > 0,
      finishReason: safeGet(event, 'finishReason') ?? safeGet(event, 'stopReason') ?? safeGet(event, 'data', 'finishReason') ?? '',
      fileTurn: isFileTurn(task, g.fileTurnRe),
      thresholdEmpty: g.thresholdEmpty,
      thresholdFile: g.thresholdFile,
      sameToolStreak: g.sameToolStreak,
    });
    if (verdict.state === 'OK') {
      if (s.guardAwaiting) {
        s.guardAwaiting = null;
        runtime.guard.rescued += 1;
        runtime.lastReason = 'guard-rescued';
      }
      return false;
    }
    runtime.guard.fired += 1;
    const maxPerSession = g.maxPerSession ?? 4;
    const maxRetries = g.maxRetries ?? 2;
    const attempt = s.guardAwaiting?.attempts || 0;
    const canRetry = hasFollowup && s.guardRetries < maxPerSession && attempt < maxRetries;
    if (canRetry) {
      s.guardAwaiting = { state: verdict.state, attempts: attempt + 1 };
      s.guardRetries += 1;
      runtime.guard.retries += 1;
      runtime.lastReason = `guard:${verdict.state}`;
      followup(guardCorrectionPrompt(task, verdict.state, answer));
      return true;
    }
    runtime.guard.undelivered += 1;
    s.guardAwaiting = null;
    runtime.lastReason = `guard-unresolved:${verdict.state}`;
    if (g.recordTrajectory !== false) {
      try {
        store.addTrajectory({
          id: event?.id ? `guard-${event.id}` : undefined,
          ts: Date.now(),
          task,
          answer,
          state: verdict.state,
          reason: verdict.reason,
          domain: 'guard',
          layer: 'Q',
          trusted: false,
          sourceKind: 'guard',
          summary: `delivery guard unresolved (${verdict.state}): ${verdict.reason}`,
        });
      } catch { /* trajectory write is best-effort */ }
    }
    return true;
  }

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
    if (cfg.inject.selfCheck === false) {
      if (selfCheckDispose) {
        try { selfCheckDispose(); } catch { /* ignore */ }
        selfCheckDispose = null;
      }
      return;
    }
    const sp = safeGet(event, 'systemPrompt') ?? systemPromptService(ctx);
    if (!sp?.section) return;
    try {
      if (typeof selfCheckDispose === 'function') selfCheckDispose();
      const d = sp.section({ name: 'rsi-selfcheck', order: 340, text: buildSelfCheckInstruction() });
      if (typeof d === 'function') selfCheckDispose = d;
    } catch { /* systemPrompt.section unavailable -> no-op */ }
  }

  function handlePreStep(event, source) {
    recordEvent(source);
    try {
      const key = sessionKey(event, ctx);
      const task = taskText(event) || lastUserBySession.get(key)?.task || '';
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
        const opts = {
          ...cfg.inject,
          topK: cfg.inject.topK,
          tokenBudget: cfg.inject.tokenBudget,
          // Scoping hint: lets the store/retrieve surface standing rules for THIS project
          // even when the task wording shares no vocabulary with them.
          project: eventProject(event, task),
        };
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
            project: eventProject(event, query),
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

  // DSH does not always expose a useful pre-step event with the current user task. To keep
  // injection reliable across DSH versions, also trigger at the user message itself. This
  // matches the durable "task change" gate: only the first time a task text appears.
  function maybeInjectOnUserMessage(key, content, event) {
    if (!cfg.inject.enabled || !content) return;
    try {
      const s = sess(key);
      if (content === s.lastTask) return;
      s.lastTask = content;
      s.lastTaskInjectCount = 0;
      s.failureStreak = 0;
      s.pendingReinject = false;
      s.reinjectQuery = '';
      runtime.taskChanges += 1;
      // The project key must be derived HERE as well. This is the path that fires for a user
      // message — and for a subagent's prompt — so passing bare `cfg.inject` meant
      // store.search() saw project === null, project-scoped standing rules were never
      // candidates, and memory injection silently never happened (runtime.injects stayed 0)
      // even though capture had tagged the lesson with the right project.
      const opts = { ...cfg.inject, project: eventProject(event, content) };
      if (pushInjection(s, event, content, opts)) {
        s.lastTaskInjectCount += 1;
        runtime.injects += 1;
        runtime.lastInject = content;
      }
    } catch {
      /* never block the message event */
    }
  }

  function handleMessage(event, source) {
    recordEvent(source);
    if (markSeen(event, `message:${source}`)) return;
    try {
      const key = sessionKey(event, ctx);
      const role = eventRole(event);
      const m = eventMessage(event);
      const content = contentText(m?.content) || String(event?.message?.content ?? event?.content ?? event?.text ?? event?.assistantText ?? event?.answer ?? '');
      if (role && role.includes('user')) {
        const sourceKind = eventSourceKind(event);
        // Source gate: only genuine user messages are memory signals. DSH system banners and
        // co-installed plugins can emit user-role content, and that noise must never become a
        // lesson (or drive task-change injection). Unknown source stays compatible with DSH
        // releases that do not expose source.kind.
        const genuineUser = !sourceKind || sourceKind === 'user';
        if (!genuineUser || isSystemLikeText(content)) {
          runtime.blockedNoise += 1;
          return;
        }
        const prev = lastAssistantBySession.get(key);
        const s = sess(key);
        const maxCap = cfg.capture.maxPerSession ?? 10;
        const canCapture = cfg.capture.enabled && s.captures < maxCap;
        const correctionWanted = canCapture && cfg.capture.captureUserCorrections !== false && prev && isUserCorrection({ correctionText: content });
        if (correctionWanted) {
          const rec = captureUserCorrection({ taskText: prev.task || taskText(event), correctionText: content, project: eventProject(event, content), sourceKind });
          if (rec) {
            if (!store.hasDuplicate(rec.lesson, cfg.capture.dedupeThreshold ?? 0.85)) {
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
          const durable = isDurableUserInstruction({ instructionText: content });
          const rec = captureUserInstruction({ instructionText: content, durable, project: eventProject(event, content), sourceKind });
          if (rec) {
            if (!store.hasDuplicate(rec.lesson, cfg.capture.dedupeThreshold ?? 0.85)) {
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
        maybeInjectOnUserMessage(key, content, event);
        lastUserBySession.set(key, { task: taskText(event) || content, at: Date.now() });
        return;
      }
      const isAssistant = role.includes('assistant') || role.includes('bot') || role.includes('model') || eventType(event).includes('assistant') || eventType(event).includes('bot') || !!event?.assistantText || (!!m?.content && (role.includes('assistant') || role.includes('bot'))) || (!!event?.message?.content && role.includes('assistant'));
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
      const task = taskText(event) || lastUserBySession.get(key)?.task || '';
      const answer = answerText(event) || lastAssistantBySession.get(key)?.answer || '';
      const tools = toolResults(event);
      runtime.turnsSeen += 1;

      const guardRejected = runGuard(s, event, task, answer, tools);
      s.prevAnswer = answer;
      if (guardRejected) {
        return; // rejected turn is corrected before it becomes a lesson
      }

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

  // DSH host plugins receive session lifecycle through `session/event`, not through
  // `ctx.on('user/message')` in every release. Register both for compatibility; dedupe
  // is handled by markSeen above.
  function handleSessionEvent(session, event) {
    if (!event || typeof event !== 'object') return;
    const type = String(event.type || '').toLowerCase();
    const source = `session/${type}`;
    const merged = { ...event, sessionId: event?.sessionId ?? session?.id };
    if (type === 'user/message' || type === 'assistant/message' || type === 'message' || type === 'bot/message') {
      handleMessage(merged, source);
    } else if (type === 'turn/end' || type === 'agent/turn/end' || type === 'chat/turn/end' || type === 'session/turn/end' || type === 'turn/finish') {
      handleTurnEnd(merged, source);
    } else if (type === 'pre-step' || type === 'agent/pre-step') {
      handlePreStep(merged, source);
    }
  }

  // First-run / boot import: DSH can already hold many chats before this plugin is
  // installed. Instead of forcing the user to "do something" before the plugin proves
  // useful, scan the live session store once and record recent user instructions as
  // normal memory rows. Guards every host call; never blocks or throws into DSH.
  function extractUserMessages(events) {
    const out = [];
    if (!Array.isArray(events)) return out;
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      if (!String(event.type || '').toLowerCase().includes('user')) continue;
      const data = eventData(event);
      const m = eventMessage(event);
      const content = contentText(m?.content) || contentText(event?.message?.content) || contentText(event?.content) || contentText(event?.text);
      const source = m?.source ?? data?.source;
      const sourceKind = source && typeof source === 'object' ? (typeof source.kind === 'string' ? source.kind.toLowerCase() : null) : null;
      if (sourceKind && sourceKind !== 'user') continue;
      const text = String(content || '').replace(/\s+/g, ' ').trim();
      if (!text || isSystemLikeText(text)) continue;
      out.push({ seq: event.seq, text, sourceKind });
    }
    return out;
  }

  function importRecentInstructions() {
    if (!cfg.importRecent?.enabled || !ctx?.inject) return;
    try {
      ctx.inject(['sessions', 'sessionPersistence'], (sub) => {
        const sessionStore = sub?.sessions;
        const persistence = sub?.sessionPersistence;
        const limit = cfg.importRecent.limit ?? 30;
        const sessionLimit = cfg.importRecent.sessions ?? 10;
        const seen = new Set();
        const seenIds = new Set();
        let collected = 0;
        const ingest = (sessionId, events) => {
          if (!events || !Array.isArray(events)) return;
          for (const { text, sourceKind } of extractUserMessages(events)) {
            if (collected >= limit) return;
            if (seen.has(text) || !isUserInstruction({ instructionText: text })) continue;
            const durable = isDurableUserInstruction({ instructionText: text });
            const rec = captureUserInstruction({ instructionText: text, durable, project: projectFromText(text), sourceKind });
            if (!rec) continue;
            if (store.hasDuplicate(rec.lesson, cfg.capture.dedupeThreshold ?? 0.85)) {
              seen.add(text);
              continue;
            }
            store.addLesson({ ...rec.lesson, sourceRef: sessionId ?? null });
            store.addTrajectory({ ...rec.trajectory, id: sessionId ? `${sessionId}-${collected}` : undefined });
            seen.add(text);
            collected += 1;
            runtime.instructions += 1;
            runtime.captures += 1;
            runtime.lastInstruction = text;
          }
        };
        const readStored = async (id) => {
          try {
            if (!persistence) return [];
            if (typeof persistence.readFrom === 'function') {
              const r = await persistence.readFrom(id, 0);
              return r?.events ?? [];
            }
            if (typeof persistence.open === 'function') {
              const handle = await persistence.open(id, 'read');
              try {
                const r = await handle.read(0);
                return r?.events ?? [];
              } finally {
                await handle.close();
              }
            }
          } catch {
            /* unreadable session; skip */
          }
          return [];
        };
        void (async () => {
          if (sessionStore && typeof sessionStore.list === 'function') {
            const sessions = sessionStore.list();
            if (Array.isArray(sessions)) {
              for (const session of sessions.slice(-sessionLimit)) {
                if (!session?.id) continue;
                seenIds.add(session.id);
                let events = [];
                if (typeof session?.snapshotEvents === 'function') {
                  try { events = session.snapshotEvents(); } catch { events = []; }
                }
                ingest(session.id, events);
                if (collected >= limit) break;
              }
            }
          }
          if (persistence && typeof persistence.list === 'function') {
            let headers;
            try { headers = await persistence.list(); } catch { headers = []; }
            if (Array.isArray(headers)) {
              const sorted = [...headers].sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0));
              for (const h of sorted.slice(0, sessionLimit)) {
                const id = h?.id ?? h?.sessionId;
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);
                const events = await readStored(id);
                ingest(id, events);
                if (collected >= limit) break;
              }
            }
          }
          if (collected > 0) store.flushSync();
        })();
      });
    } catch {
      /* host may not expose sessions/inject -> no-op */
    }
  }

  // (1) Always-on self-check instruction (cheap; the model does the counter-reason inline).
  ensureSelfCheck({});
  // (1b) Completion policy for coding-loop convergence (all models by default).
  registerConvergencePolicy();

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
    try {
      ctx.on(SESSION_EVENT, handleSessionEvent);
    } catch { /* host may not expose session/event -> no-op */ }
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

  // (4) Coding-loop convergence (ported from dsh-bonsai-fast / pi-extension-convergence):
  //     detect repeated passing checks and steer the model to converge instead of
  //     over-verifying; reset on any edit/write. All models by default; users can
  //     restrict with `convergence.models`.
  if (cfg.convergence.enabled !== false && ctx?.on) {
    try {
      ctx.on('tools/pre-execute', (exec, next) => {
        try {
          if (exec?.agent && isSourceEdit(exec.name) && convergenceActiveFor(exec.agent)) resetState(convergenceStateOf(exec.agent));
        } catch { /* never block the tool waterfall */ }
        return next?.();
      });
    } catch { /* host may not expose this event -> no-op */ }
    try {
      ctx.on('tools/post-execute', async (exec, result, next) => {
        let steer = null;
        try {
          if (exec?.agent && isShellTool(exec.name) && result?.isError !== true && convergenceActiveFor(exec.agent)) {
            steer = observeShell(convergenceStateOf(exec.agent), commandOf(exec.arguments), resultText(result), cfg.convergence.repeatThreshold);
          }
        } catch { /* never block the tool waterfall */ }
        const downstream = await next?.();
        if (!steer) return downstream;
        runtime.convergence.steers += 1;
        if (steer === STRONG_STEER) runtime.convergence.strong += 1;
        else if (steer === SOFT_STEER) runtime.convergence.soft += 1;
        const context = {
          content: [{ type: 'text', text: steer }],
          source: { kind: 'dsh-host-rsi', form: 'notice', summary: 'convergence' },
        };
        return {
          ...downstream,
          additionalContexts: [context, ...(downstream?.additionalContexts ?? [])],
        };
      });
    } catch { /* host may not expose this event -> no-op */ }
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
    try { convergencePolicyDispose?.(); } catch { /* ignore */ }
    convergencePolicyDispose = null;
    try { dashClose?.(); } catch { /* ignore */ }
    webRouteStore = null;
    webRouteCfg = null;
    webRouteSnapshot = null;
    webRoute = null;
    try {
      store.close();
    } catch {
      /* ignore */
    }
  };
}
