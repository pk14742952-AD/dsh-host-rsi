// DSH host RSI — the "界面 / 记忆系统"-like status view, two surfaces (bili-style):
//
//  1) LOOPBACK dashboard (startDashboardServer): a tiny self-hosted http server on an
//     ephemeral port; the "打开 Web UI" target the user can open in a browser.
//  2) DSH-WEB SERVER routes (rsiWebserverHandler): `/rsi`, `/rsi/status.json`,
//     `/rsi/records.json` registered on DSH's OWN webserver (same-origin as the GUI),
//     so the Settings-tab can live-fetch status with no CORS + the page can be embedded.
//
// The status PAGE (DASHBOARD_HTML) is self-contained: vanilla HTML/CSS/JS, dark theme to
// match DSH, no external assets. It polls `<base>/status.json` every 5s and renders:
//   插件状态徽章(启用中/已停用/仅内存) · 教训统计(可信/隔离/轨迹/总数) · 分层分布 · 最近记录 · 存储/最近活动.
// Guarded everywhere so a bind/registration failure never disturbs the host.

import http from 'node:http';
import { snapshot, records as fetchRecords } from './status.js';

/**
 * The self-contained status page. `basePath` is prepended to the status.json fetch so the
 * same page works both on the loopback dashboard ("" → /status.json) and DSH-web routes
 * ("/rsi/" → /rsi/status.json).
 * @param {string} [basePath]
 * @returns {string}
 */
export function dashboardHtml(basePath = "") {
  const base = JSON.stringify(basePath);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH HOST RSI记忆</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --panel2:#1d212b; --line:#262b36;
          --fg:#e6e9ef; --dim:#9aa3b2; --ok:#4ade80; --warn:#facc15; --bad:#f87171;
          --accent:#6aa7ff; --chip:#232a37; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif; padding:24px; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--dim); margin:0 0 18px; font-size:12px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:14px 16px; flex:1 1 200px; }
  .card .k { color:var(--dim); font-size:12px; }
  .card .v { font-size:24px; font-weight:600; margin-top:2px; }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-size:13px; font-weight:600; }
  .badge.ok { background:rgba(74,222,128,.15); color:var(--ok); }
  .badge.warn { background:rgba(250,204,21,.15); color:var(--warn); }
  .badge.bad { background:rgba(248,113,113,.15); color:var(--bad); }
  .bars { margin:18px 0; }
  .bar { display:flex; align-items:center; gap:10px; margin:6px 0; }
  .bar .lab { width:34px; color:var(--dim); font-size:12px; }
  .bar .track { flex:1; height:8px; background:var(--panel2); border-radius:999px; overflow:hidden; }
  .bar .fill { height:100%; background:var(--accent); border-radius:999px; }
  .bar .n { width:34px; text-align:right; font-size:12px; color:var(--dim); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line);
          border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:12px; background:var(--panel2); }
  tr:last-child td { border-bottom:none; }
  .chip { display:inline-block; background:var(--chip); border-radius:6px; padding:1px 7px; font-size:11px; margin-right:5px; }
  .chip.trusted { color:var(--ok); } .chip.q { color:var(--warn); }
  .fix { color:var(--dim); font-size:12px; margin-top:3px; }
  .meta { color:var(--dim); font-size:12px; margin-top:18px; }
  .empty { color:var(--dim); padding:18px; text-align:center; }
  button { background:var(--panel2); color:var(--fg); border:1px solid var(--line); border-radius:8px;
           padding:5px 12px; cursor:pointer; font-size:12px; }
  button:hover { border-color:var(--accent); }
  .head { display:flex; justify-content:space-between; align-items:center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <h1>DSH HOST RSI记忆</h1>
      <p class="sub" id="sub">加载中…</p>
    </div>
    <button onclick="load()">刷新</button>
  </div>

  <div class="row">
    <div class="card" style="flex:0 0 180px"><div class="k">插件状态</div><div class="v" id="state">—</div></div>
    <div class="card"><div class="k">可信教训</div><div class="v" id="trusted">0</div></div>
    <div class="card"><div class="k">隔离(待证实)</div><div class="v" id="quar">0</div></div>
    <div class="card"><div class="k">轨迹</div><div class="v" id="traj">0</div></div>
    <div class="card"><div class="k">教训总数</div><div class="v" id="total">0</div></div>
  </div>

  <div class="row" style="margin-top:8px">
    <div class="card"><div class="k">触发事件</div><div class="v" id="events">0</div></div>
    <div class="card"><div class="k">注入</div><div class="v" id="injects">0</div></div>
    <div class="card"><div class="k">捕获</div><div class="v" id="captures">0</div></div>
    <div class="card"><div class="k">用户指令</div><div class="v" id="instructions">0</div></div>
    <div class="card"><div class="k">失败信号</div><div class="v" id="failures">0</div></div>
  </div>

  <div class="meta" id="runtime"></div>

  <div class="bars" id="bars"><div class="k" style="color:var(--dim)">分层分布</div></div>
  <table id="tbl">
    <thead><tr><th style="width:150px">时间</th><th style="width:90px">领域</th><th style="width:70px">层/状态</th><th>记住的内容 / 纠正</th></tr></thead>
    <tbody id="tbody"><tr><td colspan="4" class="empty">暂无记录</td></tr></tbody>
  </table>

  <div class="meta" id="meta"></div>
</div>

<script>
const BASE = ${base};
const LAYER_LABEL = { L1:"L1 已验证", L2:"L2 你确认", L3:"L3 自判", Q:"隔离 Q" };
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtTime(ms){ if(!ms) return "—"; const d=new Date(ms); const p=n=>String(n).padStart(2,"0");
  return p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()); }
async function load(){
  let s;
  try { const r = await fetch(BASE+"status.json", { cache:"no-store" }); s = await r.json(); }
  catch(e){ document.getElementById("sub").textContent = "仪表板后端不可用：" + e.message; return; }
  render(s);
}
function render(s){
  const st = document.getElementById("state");
  st.innerHTML = s.enabled===false ? '<span class="badge bad">已停用</span>'
    : s.degraded ? '<span class="badge warn">启用中 · 仅内存(未持久化)</span>'
    : '<span class="badge ok">启用中</span>';
  document.getElementById("sub").textContent = s.dir + (s.generatedAt ? " · 快照 " + fmtTime(s.generatedAt) : "");
  document.getElementById("trusted").textContent = s.totals.trusted;
  document.getElementById("quar").textContent = s.totals.quarantined;
  document.getElementById("traj").textContent = s.totals.trajectories;
  document.getElementById("total").textContent = s.totals.lessons;
  const rt = s.runtime || {};
  document.getElementById("events").textContent = rt.eventsSeen ?? 0;
  document.getElementById("injects").textContent = rt.injects ?? 0;
  document.getElementById("captures").textContent = rt.captures ?? 0;
  document.getElementById("instructions").textContent = rt.instructions ?? 0;
  document.getElementById("failures").textContent = rt.failures ?? 0;
  if (s.runtime) {
    document.getElementById("runtime").innerHTML =
      "触发诊断：事件 " + (rt.eventsSeen ?? 0) + " · 处理turn " + (rt.turnsSeen ?? 0) +
      " · 注入 " + (rt.injects ?? 0) + " · 捕获 " + (rt.captures ?? 0) +
      " · 纠正 " + (rt.corrections ?? 0) + " · 指令 " + (rt.instructions ?? 0) + " · 失败 " + (rt.failures ?? 0) +
      "<br>最近事件：" + esc(rt.lastEvent || "—") +
      " · 最近注入：" + esc(rt.lastInject || "—") +
      " · 最近指令：" + esc(rt.lastInstruction || "—") +
      " · 最近捕获：" + esc(rt.lastCapture || "—") +
      " · 触发原因：" + esc(rt.lastReason || "—");
  }
  const layers = ["L1","L2","L3","Q"];
  const max = Math.max(1, ...layers.map(l => s.byLayer[l] || 0));
  document.getElementById("bars").innerHTML = '<div style="color:var(--dim);font-size:12px">分层分布</div>' + layers.map(l => {
    const n = s.byLayer[l] || 0;
    return '<div class="bar"><div class="lab">'+l+'</div><div class="track"><div class="fill" style="width:'+(n/max*100)+'%"></div></div><div class="n">'+n+'</div></div>';
  }).join("");
  const rows = (s.recent || []);
  document.getElementById("tbody").innerHTML = rows.length ? rows.map(r => {
    const chip = r.trusted ? '<span class="chip trusted">可信</span>' : '<span class="chip q">隔离</span>';
    return '<tr><td>'+fmtTime(r.at)+'</td><td>'+esc(r.domain||"general")+'</td><td>'+esc(LAYER_LABEL[r.layer]||r.layer)+' '+chip+'</td>'+
           '<td>'+esc(r.summary)+(r.fix?'<div class="fix">纠正：'+esc(r.fix)+'</div>':'')+'</td></tr>';
  }).join("") : '<tr><td colspan="4" class="empty">暂无记录 — 跑几轮通用任务后，这里会开始积累。</td></tr>';
  const mb = s.storage ? (s.storage.bytes/1048576).toFixed(2)+" MB" : "—";
  document.getElementById("meta").innerHTML =
    "存储 "+esc(s.dir)+" · "+mb+" · 最近活动 "+fmtTime(s.lastActivity)+
    '<br><span style="opacity:.6">本页每 5s 自动刷新 · 数据来自插件后台记忆（只有可信教训才进入注入）。</span>';
}
load(); setInterval(load, 5000);
</script>
</body>
</html>`;
}

/**
 * node:http handler for the DSH-webserver `/rsi` prefix route (bili-style same-origin routes).
 * Serves: `/rsi` → status page HTML; `/rsi/status.json` → live snapshot; `/rsi/records.json` → recent records.
 * @param {object} store openStore() result
 * @param {object} cfg
 * @returns {(req:object,res:object)=>void}
 */
export function rsiWebserverHandler(store, cfg = {}, getSnapshot = null) {
  const d = cfg.dashboard || {};
  const html = dashboardHtml("/rsi/");
  let lastSnap = null;
  let lastAt = 0;
  const snap = () => {
    const now = Date.now();
    if (!lastSnap || now - lastAt > 3000) {
      lastSnap = getSnapshot ? getSnapshot() : snapshot(store, { enabled: cfg.enabled, recent: d.recent ?? 15 });
      lastAt = now;
    }
    return lastSnap;
  };
  return (req, res) => {
    try {
      const url = req?.url || "/rsi";
      const path = url.split("?")[0];
      if (path === "/rsi/status.json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(snap()));
        return;
      }
      if (path === "/rsi/records.json") {
        const qs = new URL(url.startsWith("http") ? url : `http://x${url}`, "http://x");
        const q = qs.searchParams;
        const out = fetchRecords(store, {
          limit: Number(q.get("limit")) || 15,
          trustedOnly: q.get("trustedOnly") === "true",
          domain: q.get("domain") || undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      try {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(String(e && e.message));
      } catch { /* ignore */ }
    }
  };
}

/**
 * Start the self-hosted LOOPBACK dashboard (fallback + "打开 Web UI" target).
 * @param {object} store
 * @param {object} cfg
 * @returns {Promise<{url:string, port:number, host:string, close:()=>void}>}
 */
export async function startDashboardServer(store, cfg = {}, getSnapshot = null) {
  const d = cfg.dashboard || {};
  const host = d.host ?? "127.0.0.1";
  const port = d.port ?? 0;
  const handler = rsiWebserverHandler(store, { ...cfg, _rsiRewriteRoot: true });
  // Rewrite the request URL mapping: loopback serves "/" (not "/rsi").
  let lastSnap = null;
  let lastAt = 0;
  const server = http.createServer((req, res) => {
    try {
      const path = (req.url || "/").split("?")[0];
      if (path === "/status.json" || path === "/") {
        if (path === "/status.json") {
          const now = Date.now();
          if (!lastSnap || now - lastAt > 3000) {
            lastSnap = getSnapshot ? getSnapshot() : snapshot(store, { enabled: cfg.enabled, recent: d.recent ?? 15 });
            lastAt = now;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(lastSnap));
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(dashboardHtml(""));
        }
        return;
      }
      if (path === "/records.json") {
        const q = new URL(req.url, "http://x").searchParams;
        const out = fetchRecords(store, { limit: Number(q.get("limit")) || 15, trustedOnly: q.get("trustedOnly") === "true", domain: q.get("domain") || undefined });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (e) {
      try {
        res.writeHead(500);
        res.end(String(e && e.message));
      } catch { /* ignore */ }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = server.address().port;
  if (typeof server.unref === "function") server.unref();
  return {
    url: `http://${host}:${actualPort}`,
    host,
    port: actualPort,
    close() {
      try {
        server.close();
      } catch { /* ignore */ }
    },
  };
}

export default { dashboardHtml, rsiWebserverHandler, startDashboardServer };
