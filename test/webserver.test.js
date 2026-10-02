// DSH host RSI — bili-style DSH-webserver integration + __RSI__ global injection.
// node --test test/webserver.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { rsiWebserverHandler, dashboardHtml } from '../lib/dashboard.js';
import { apply } from '../index.js';

function storeWithData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-web-'));
  const store = openStore(dir, { flushMs: 0 });
  store.ensureLayout();
  store.addLesson({ summary: 'SQL 先备份', trusted: true, domain: 'sql', layer: 'L3', createdAt: 1 });
  store.addLesson({ summary: '可信教训', trusted: true, domain: 'code', layer: 'L1', createdAt: 2 });
  store.addLesson({ summary: '待证实', trusted: false, domain: 'code', layer: 'Q', createdAt: 3 });
  return store;
}
function fakeRes() {
  return {
    status: null,
    body: null,
    writeHead(code) { this.status = code; },
    end(body) { this.body = body; },
  };
}

test('dashboardHtml() is self-contained + embeds the fetch base', () => {
  const html = dashboardHtml('/rsi/');
  assert.ok(html.includes('DSH HOST RSI记忆'));
  assert.ok(html.includes('const BASE = "/rsi/";'));
});

test('rsiWebserverHandler serves /rsi -> status page HTML', () => {
  const store = storeWithData();
  const h = rsiWebserverHandler(store, { enabled: true, dashboard: { recent: 5 } });
  const res = fakeRes();
  h({ url: '/rsi/' }, res);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('DSH HOST RSI记忆'));
});

test('rsiWebserverHandler serves /rsi/status.json -> snapshot JSON', () => {
  const store = storeWithData();
  const h = rsiWebserverHandler(store, { enabled: true });
  const res = fakeRes();
  h({ url: '/rsi/status.json' }, res);
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.enabled, true);
  assert.equal(j.totals.lessons, 3);
  assert.equal(j.totals.trusted, 2);
  assert.ok(Array.isArray(j.recent));
});

test('rsiWebserverHandler serves /rsi/records.json -> newest-first records', () => {
  const store = storeWithData();
  const h = rsiWebserverHandler(store, { enabled: true });
  const res = fakeRes();
  h({ url: '/rsi/records.json?limit=2&trustedOnly=true' }, res);
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.length, 2);
  assert.ok(j.every((r) => r.trusted));
});

test('apply() injects __RSI__ global + registers /rsi prefix route on the webserver', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-apply-'));
  const indexRows = [];
  const registers = [];
  const ctx = {
    on(event, cb) {
      if (event === 'webserver/index-inject') {
        cb({ push: (r) => indexRows.push(r) }); // simulate one index.html render
      }
      return () => {};
    },
    inject(names, cb) {
      if (Array.isArray(names) && names.includes('webServer')) {
        cb({ webServer: { register(opts) { registers.push(opts); return () => {}; } } });
      }
      return () => {};
    },
    systemPrompt: undefined,
    tools: undefined,
    agent: undefined,
  };
  const dispose = apply(ctx, { enabled: true, dir });
  const rsiRow = indexRows.find((r) => r.name === '__RSI__');
  assert.ok(rsiRow, '__RSI__ global row was pushed to index-inject');
  assert.equal(rsiRow.kind, 'global');
  assert.equal(rsiRow.value.basePath, '/rsi/');
  assert.ok(rsiRow.value.status && typeof rsiRow.value.status.totals === 'object', '__RSI__ carries a status snapshot');
  assert.ok(registers.some((o) => o.kind === 'prefix' && o.path === '/rsi'), 'a /rsi prefix route was registered on the DSH webserver');
  dispose();
});

test('apply() 在无 webServer 服务且 index-inject 不触发时仍完成、核心工具照常注册、绝不崩（不导致宿主瘫痪）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-nowebsrv-'));
  let toolCalls = 0;
  const ctx = {
    on: () => () => {}, // 事件可订阅但 index-inject 永不触发 → 不注入 __RSI__
    inject(_names, cb) { cb({}); return () => {}; }, // 空 scope → 宿主无 webServer 服务
    tools: { register: () => { toolCalls += 1; } },
    agent: undefined,
  };
  let dispose;
  assert.doesNotThrow(() => { dispose = apply(ctx, { enabled: true, dir }); });
  assert.ok(typeof dispose === 'function', 'apply() 返回 disposer');
  assert.ok(toolCalls >= 1, `核心工具（rsi_verify/rsi_status/rsi_records）在 webserver 缺失时仍被注册（got ${toolCalls}）`);
  dispose?.();
});
