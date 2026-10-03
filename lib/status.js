// DSH host RSI — status / records data contract (mechanism-agnostic).
//
// Feeds ANY surface DSH offers to show plugin status (a host tool the user can call,
// a settings card, a self-hosted status page, a tray/CLI read): the same `snapshot()`
// drives them all. Built only from the public store API (list/disabled/dir) + a cheap
// fs walk of the data dir, so it never touches the hot capture/inject path.

import fs from 'node:fs';
import path from 'node:path';

/** Count raw traces + total bytes under dir (best-effort; never throws). */
export function collectStorage(dir) {
  const out = { dir, trajectories: 0, bytes: 0 };
  try {
    const trajDir = path.join(dir, 'trajectories');
    if (fs.existsSync(trajDir)) {
      for (const f of fs.readdirSync(trajDir)) out.trajectories += 1;
    }
    walkDir(dir, (p) => {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) out.bytes += st.size;
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* dir unreadable: keep zeros */
  }
  return out;
}

function walkDir(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, onFile);
    else onFile(p);
  }
}

/**
 * @param {object} store openStore() result
 * @param {object} [cfg] { enabled?, recent? }
 * @returns a plain, JSON-serializable status snapshot for the UI.
 */
export function snapshot(store, cfg = {}) {
  const rows = store.list();
  let trusted = 0;
  const byLayer = {};
  const byDomain = {};
  let lastActivity = 0;
  for (const r of rows) {
    if (r.trusted) trusted += 1;
    byLayer[r.layer] = (byLayer[r.layer] || 0) + 1;
    byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;
    const ts = r.updatedAt || r.createdAt || 0;
    if (ts > lastActivity) lastActivity = ts;
  }
  const quarantined = rows.length - trusted;
  const recent = [...rows]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, cfg.recent ?? 10)
    .map((r) => ({
      id: r.id,
      summary: r.summary,
      fix: r.fix || undefined,
      layer: r.layer,
      trusted: r.trusted,
      domain: r.domain,
      at: r.createdAt || r.updatedAt || 0,
    }));
  const storage = collectStorage(store.dir);
  return {
    enabled: cfg.enabled !== false,
    degraded: !!store.disabled, // dir unwritable -> in-memory only, not persisted
    dir: store.dir,
    totals: {
      lessons: rows.length,
      trusted,
      quarantined,
      trajectories: storage.trajectories,
    },
    byLayer,
    byDomain,
    recent,
    lastActivity: lastActivity || null,
    storage: { dir: storage.dir, trajectories: storage.trajectories, bytes: storage.bytes },
    generatedAt: Date.now(),
  };
}

/**
 * @param {object} store openStore() result
 * @param {object} [q] { limit?, trustedOnly?, domain? }
 * @returns record rows for the "展示记录" list (newest first).
 */
export function records(store, q = {}) {
  let rows = store.list();
  if (q.trustedOnly) rows = rows.filter((r) => r.trusted);
  if (q.domain) rows = rows.filter((r) => r.domain === q.domain);
  rows = rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (q.limit) rows = rows.slice(0, q.limit);
  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    fix: r.fix || undefined,
    layer: r.layer,
    trusted: r.trusted,
    domain: r.domain,
    weight: r.weight,
    at: r.createdAt || r.updatedAt || 0,
  }));
}

/**
 * bili-style human-readable "文字总结报告" for the rsi_status tool: 状态 + 统计 + 分层/领域
 * + 最近记录(内联) + 仪表板链接 + 数据目录. The model relays this; the URL is the clickable
 * "Web UI 链接" analog of billion-context's /acp-cache.
 * @param {object} snap  snapshot() result
 * @param {string|null} [dashboardUrl]
 * @returns {string}
 */
export function formatStatusReport(snap, dashboardUrl = null) {
  const state = snap.enabled === false
    ? '已停用'
    : snap.degraded
      ? '启用中 · 仅内存(未持久化,目录不可写)'
      : '启用中（正常）';
  const layers = ['L1', 'L2', 'L3', 'Q']
    .map((l) => (snap.byLayer[l] ? `${l}=${snap.byLayer[l]}` : null))
    .filter(Boolean).join(' ') || '—';
  const domains = Object.entries(snap.byDomain || {}).map(([d, n]) => `${d}=${n}`).join(' ') || '—';
  const lines = [
    '【DSH HOST RSI记忆 · 运行状态】',
    `状态：${state}`,
    `教训：${snap.totals.lessons}（可信 ${snap.totals.trusted} / 隔离 ${snap.totals.quarantined}） · 轨迹 ${snap.totals.trajectories}`,
    `分层：${layers}   领域：${domains}`,
  ];
  if (snap.runtime) {
    lines.push(`触发诊断：事件 ${snap.runtime.eventsSeen ?? 0} · 处理turn ${snap.runtime.turnsSeen ?? 0} · 注入 ${snap.runtime.injects ?? 0} · 捕获 ${snap.runtime.captures ?? 0} · 失败 ${snap.runtime.failures ?? 0}`);
    lines.push(`最近事件：${snap.runtime.lastEvent ?? '—'}${snap.runtime.lastReason ? ` · 触发原因：${snap.runtime.lastReason}` : ''}`);
  }
  if (snap.recent?.length) {
    lines.push('最近记录：');
    for (const r of snap.recent.slice(0, 5)) {
      lines.push(`  • [${r.trusted ? '可信' : '隔离'}] ${r.domain}: ${r.summary}${r.fix ? ` → ${r.fix}` : ''}`);
    }
  } else {
    lines.push('最近记录：暂无 — 跑几轮通用任务后会开始积累。');
  }
  if (dashboardUrl) lines.push(`仪表板：${dashboardUrl}   ← 打开查看完整界面（每 5s 自动刷新）`);
  lines.push(`数据目录：${snap.dir}`);
  return lines.join('\n');
}
