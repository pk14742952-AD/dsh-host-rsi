// Status + dashboard data layer + live loopback server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { snapshot, records, collectStorage } from '../lib/status.js';
import { startDashboardServer } from '../lib/dashboard.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-dash-'));
}

test('snapshot aggregates trusted/quarantined/layer/lastActivity', () => {
  const dir = tmp();
  const store = openStore(dir, { flushMs: 500 });
  store.addLesson({ summary: 'a', domain: 'code', layer: 'L1', trusted: true, weight: 1 });
  store.addLesson({ summary: 'b', domain: 'code', layer: 'L3', trusted: false, weight: 0.4 });
  store.addLesson({ summary: 'c', domain: 'math', layer: 'Q', trusted: false, weight: 0.2, fix: 'x' });
  store.flushSync();
  const s = snapshot(store, { enabled: true, recent: 5 });
  assert.equal(s.totals.lessons, 3);
  assert.equal(s.totals.trusted, 1);
  assert.equal(s.totals.quarantined, 2);
  assert.equal(s.byLayer.L1, 1);
  assert.equal(s.byLayer.Q, 1);
  assert.equal(s.byDomain.code, 2);
  assert.equal(s.recent.length, 3);
  assert.ok(s.lastActivity);
  assert.equal(s.enabled, true);
  store.close();
});

test('records filters by trustedOnly / domain and sorts newest first', () => {
  const dir = tmp();
  const store = openStore(dir, { flushMs: 500 });
  store.addLesson({ summary: 'old', domain: 'math', layer: 'L3', trusted: false, weight: 0.3, createdAt: 1000 });
  store.addLesson({ summary: 'new', domain: 'code', layer: 'L1', trusted: true, weight: 1, createdAt: 2000 });
  store.addLesson({ summary: 'new2', domain: 'code', layer: 'L1', trusted: true, weight: 1, createdAt: 3000 });
  store.flushSync();
  const all = records(store, {});
  assert.equal(all[0].summary, 'new2'); // newest first
  const code = records(store, { domain: 'code' });
  assert.equal(code.length, 2);
  const trustedOnly = records(store, { trustedOnly: true, limit: 10 });
  assert.ok(trustedOnly.every((r) => r.trusted));
  store.close();
});

test('collectStorage counts trajectories + bytes without throwing on missing dir', () => {
  const st = collectStorage(path.join(os.tmpdir(), 'does-not-exist-rsi'));
  assert.equal(st.trajectories, 0);
  assert.equal(st.bytes, 0);
});

test('dashboard server serves / (HTML) and /status.json (live snapshot)', async () => {
  const dir = tmp();
  const store = openStore(dir, { flushMs: 500 });
  store.addLesson({ summary: 'lesson-x', domain: 'code', layer: 'L1', trusted: true, weight: 1 });
  store.flushSync();
  const h = await startDashboardServer(store, { enabled: true, dashboard: { host: '127.0.0.1', port: 0 } });
  try {
    const page = await (await fetch(h.url + '/')).text();
    assert.ok(page.includes('DSH HOST RSI记忆'));
    const js = await (await fetch(h.url + '/status.json')).json();
    assert.equal(js.totals.lessons, 1);
    assert.equal(js.recent[0].summary, 'lesson-x');
    assert.equal(js.enabled, true);
  } finally {
    h.close();
    store.close();
  }
});
