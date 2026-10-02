// RSI demo "网页" — a persistent loopback dashboard (sample records) the user can open NOW
// in a browser, without restarting DSH. In DSH this same page is served by the RSI host
// bundle (loopback + /rsi same-origin routes) and opened from the Settings → RSI 记忆 tab.
//
//   node demo-serve.mjs            # http://127.0.0.1:8788
//   RSI_DEMO_PORT=9000 node demo-serve.mjs
//   RSI_DEMO_DIR=E:\DSH\.rsi-memory node demo-serve.mjs   # point at the REAL store

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './lib/store.js';
import { snapshot, records as fetchRecords } from './lib/status.js';
import { dashboardHtml } from './lib/dashboard.js';

const PORT = Number(process.env.RSI_DEMO_PORT || 8788);
const useReal = process.env.RSI_DEMO_DIR && fs.existsSync(process.env.RSI_DEMO_DIR);
const dir = useReal ? process.env.RSI_DEMO_DIR : fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-demo-'));
const store = openStore(dir, { flushMs: 0 });
store.ensureLayout();

if (!useReal) {
  // Seed sample records so the page shows something (启用中 / 可信·隔离 / 记录).
  const now = Date.now();
  store.addLesson({ summary: 'SQL 改表前先备份 schema', trusted: true, domain: 'sql', layer: 'L3', fix: 'DROP 前先 EXPORT', confidence: 0.82, createdAt: now - 86400000 });
  store.addLesson({ summary: '检索用倒排索引，避免全量扫描', trusted: true, domain: 'code', layer: 'L1', confidence: 0.9, createdAt: now - 3600000 });
  store.addLesson({ summary: '推测：该 API 在 Windows 上有编码问题（未证实）', trusted: false, domain: 'code', layer: 'Q', confidence: 0.38, createdAt: now - 60000 });
  store.addTrajectory({ task: '写一个数据库迁移脚本', answerText: '（示例轨迹：先建回滚脚本，再执行迁移）', tools: [{ name: 'pwsh', ok: true }], createdAt: now - 120000 });
  store.flushSync();
}

const cfg = { enabled: true, dashboard: { recent: 15 } };
const page = dashboardHtml('');
let lastSnap = null;
let lastAt = 0;
const snap = () => {
  const n = Date.now();
  if (!lastSnap || n - lastAt > 3000) {
    lastSnap = snapshot(store, { enabled: cfg.enabled, recent: cfg.dashboard.recent });
    lastAt = n;
  }
  return lastSnap;
};
const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  try {
    if (p === '/status.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(snap()));
    } else if (p === '/records.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(fetchRecords(store, { limit: 15 })));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e && e.message));
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('RSI 仪表板 (demo) -> http://127.0.0.1:' + server.address().port + '   store: ' + dir);
  console.log('Ctrl+C / 结束后台任务即停。');
});
