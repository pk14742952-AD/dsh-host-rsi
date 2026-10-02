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
