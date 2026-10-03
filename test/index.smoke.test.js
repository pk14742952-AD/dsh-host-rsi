import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { openStore } from '../lib/store.js';

test('Config is not exported - cordis resolveConfig would crash on a plain object', async () => {
  const mod = await import('../index.js');
  assert.equal('Config' in mod, false);
  assert.equal(typeof mod.apply, 'function');
});

test('apply() with a minimal/unknown ctx never throws and returns a cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-idx-'));
  const cleanup = apply({ someUnknownCtx: true }, { enabled: true, dir, flushMs: 500 });
  assert.equal(typeof cleanup, 'function');
  cleanup();
});

test('apply() with enabled=false is a full no-op (data dir untouched)', () => {
  const cleanup = apply({}, { enabled: false, dir: 'C:/should-not-be-created' });
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.ok(!fs.existsSync('C:/should-not-be-created'));
});

function makeHarness(dir, injectOverrides = {}) {
  const ctx = {
    events: {},
    injected: [],
    on(name, cb) {
      ctx.events[name] = cb;
      return () => {};
    },
    inject() {
      return () => {};
    },
    tools: {
      register() {
        return () => {};
      },
    },
  };
  const cfg = {
    enabled: true,
    dir,
    flushMs: 100000,
    dashboard: { enabled: false, webserver: false },
    inject: {
      enabled: true,
      topK: 3,
      tokenBudget: 1000,
      candCap: 40,
      includeQuarantined: false,
      oncePerTask: false,
      maxInjectsPerTask: 2,
      reinjectOn: ['tool-failure', 'repeated-failure'],
      compactTopK: 1,
      compactTokenBudget: 300,
      ...injectOverrides,
    },
    capture: { enabled: true, maxPerSession: 10, minChars: 300, dedupeThreshold: 0.8 },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
  };
  const cleanup = apply(ctx, cfg);
  return { ctx, cleanup };
}

test('balanced injection: same task can receive one compact re-inject after a tool failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-bal-'));
  const store = openStore(dir, { flushMs: 100000 });
  store.ensureLayout();
  store.addLesson({
    domain: 'sql',
    tags: ['sql', 'join'],
    summary: 'always add a join condition before scanning',
    fix: 'add WHERE before executing',
    layer: 'L1',
    trusted: true,
  });
  store.flushSync();

  const { ctx, cleanup } = makeHarness(dir);
  const agent = { inject: (block) => ctx.injected.push(block) };
  ctx.events['agent/pre-step']({ task: 'sql join', agent }, () => {});
  assert.equal(ctx.injected.length, 1);
  assert.match(ctx.injected[0], /join condition/);

  ctx.events['turn/end']({
    task: 'sql join',
    assistantText: 'query failed',
    toolResults: [{ name: 'sql', ok: false }],
  });
  ctx.events['agent/pre-step']({ task: 'sql join', agent }, () => {});
  assert.equal(ctx.injected.length, 2, 'failure should allow one compact re-inject');
  assert.match(ctx.injected[1], /join condition/);

  cleanup();
});

test('oncePerTask=true restores strict single injection for the same task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-once-'));
  const store = openStore(dir, { flushMs: 100000 });
  store.ensureLayout();
  store.addLesson({
    domain: 'sql',
    tags: ['sql'],
    summary: 'check indexes before optimizing',
    layer: 'L2',
    trusted: true,
  });
  store.flushSync();

  const { ctx, cleanup } = makeHarness(dir, { oncePerTask: true });
  const agent = { inject: (block) => ctx.injected.push(block) };
  ctx.events['agent/pre-step']({ task: 'sql tuning', agent }, () => {});
  ctx.events['turn/end']({
    task: 'sql tuning',
    assistantText: 'error again',
    toolResults: [{ name: 'sql', ok: false }],
  });
  ctx.events['agent/pre-step']({ task: 'sql tuning', agent }, () => {});
  assert.equal(ctx.injected.length, 1, 'oncePerTask mode must not re-inject on failure');

  cleanup();
});

test('apply registers DSH event aliases + rsi_events/rsi_demo_capture diagnostic tools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-fallback-'));
  const eventNames = [];
  const toolNames = [];
  const ctx = {
    events: {},
    on(name, cb) {
      eventNames.push(name);
      ctx.events[name] = cb;
      return () => {};
    },
    inject() {
      return () => {};
    },
    tools: {
      register(opts) {
        toolNames.push(opts.name);
        return () => {};
      },
    },
  };
  const cleanup = apply(ctx, {
    enabled: true,
    dir,
    dashboard: { enabled: false, webserver: false },
    capture: { enabled: true, maxPerSession: 10, minChars: 120, dedupeThreshold: 0.8 },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
  });

  for (const name of ['agent/pre-step', 'pre-step', 'turn/end', 'agent/turn/end', 'message', 'agent/message', 'chat/message']) {
    assert.ok(eventNames.includes(name), `expected fallback event ${name}`);
  }
  assert.ok(toolNames.includes('rsi_events'), 'rsi_events diagnostic tool should be registered');
  assert.ok(toolNames.includes('rsi_demo_capture'), 'rsi_demo_capture tool should be registered');

  cleanup();
});

test('user correction after an assistant reply is captured as a trusted L3 lesson', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-correction-'));
  const eventHandlers = {};
  const toolRuns = {};
  const ctx = {
    events: {},
    on(name, cb) {
      eventHandlers[name] = cb;
      return () => {};
    },
    inject() {
      return () => {};
    },
    tools: {
      register(opts) {
        toolRuns[opts.name] = opts.run;
        return () => {};
      },
    },
  };
  const cleanup = apply(ctx, {
    enabled: true,
    dir,
    dashboard: { enabled: false, webserver: false },
    capture: { enabled: true, maxPerSession: 10, minChars: 120, dedupeThreshold: 0.8, captureUserCorrections: true },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
  });

  eventHandlers.message({ role: 'user', sessionId: 's1', content: '写一个 Python 下载脚本' });
  eventHandlers.message({ role: 'assistant', sessionId: 's1', content: '给你一个 requests 实现' });
  eventHandlers.message({ role: 'user', sessionId: 's1', content: '不要用 requests，改用 httpx' });

  const recs = await toolRuns.rsi_records({ limit: 10 });
  const correction = Array.isArray(recs) ? recs.find((r) => r.domain === 'user-correction') : null;
  assert.ok(correction, 'user correction lesson should be recorded');
  assert.equal(correction.trusted, true);
  assert.equal(correction.layer, 'L3');

  cleanup();
});

test('explicit user instruction/preference is captured as a trusted L3 lesson', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-instruction-'));
  const eventHandlers = {};
  const toolRuns = {};
  const ctx = {
    events: {},
    on(name, cb) {
      eventHandlers[name] = cb;
      return () => {};
    },
    inject() {
      return () => {};
    },
    tools: {
      register(opts) {
        toolRuns[opts.name] = opts.run;
        return () => {};
      },
    },
  };
  const cleanup = apply(ctx, {
    enabled: true,
    dir,
    dashboard: { enabled: false, webserver: false },
    capture: { enabled: true, maxPerSession: 10, minChars: 120, dedupeThreshold: 0.8, captureUserInstructions: true },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
  });

  eventHandlers.message({ role: 'user', sessionId: 's2', content: '以后都用 httpx，不要用 requests' });

  const recs = await toolRuns.rsi_records({ limit: 10 });
  const instruction = Array.isArray(recs) ? recs.find((r) => r.domain === 'user-instruction') : null;
  assert.ok(instruction, 'user instruction lesson should be recorded');
  assert.equal(instruction.trusted, true);
  assert.equal(instruction.layer, 'L3');

  cleanup();
});
