// DSH host RSI — file store under a human-readable data dir (Node fs only).
//
// DESIGN GOALS (from the optimization pass):
//   * NON-INTRUSIVE: every read is served from an in-memory cache; disk I/O happens only in
//     a backgrounded, DEBOUNCED flush. The agent hot path (pre-step / turn-end) never blocks
//     on disk.
//   * MINIMAL RESOURCE: index.json + termindex.json are loaded ONCE at open, then served
//     in-memory; writes are batched + coalesced; the flush timer is unref'd so it never
//     holds the process.
//   * MAX COMPATIBILITY: if the dir cannot be created/written the store DEGRADES to
//     in-memory-only (disabled=true) instead of throwing — the plugin keeps working and just
//     stops persisting. No fs call is ever uncaught.
//
// Source of truth is index.json (structured, queryable). The INVERTED INDEX (term -> ids,
// termindex.json) gives fast candidate location. lessons/ + quarantined/ are append-only,
// human-curatable .md mirrors; trajectories/ holds raw traces for later LoRA.

import fs from 'node:fs';
import path from 'node:path';
import { retrieve, tokenize } from './retrieve.js';

function slug(s, n = 40) {
  return String(s || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, n) || 'general';
}

function now() {
  return Date.now();
}

export function newId() {
  return `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function lessonTerms(lesson) {
  const t = new Set();
  for (const chunk of [lesson.domain, (lesson.tags || []).join(' '), lesson.summary, lesson.fix]) {
    for (const tok of tokenize(chunk)) t.add(tok);
  }
  return t;
}

/**
 * Normalize free text for duplicate comparison: lowercase, collapse whitespace, drop
 * punctuation. Chinese punctuation is also removed so "以后都用httpx" and
 * "以后都用 httpx！" compare the same.
 */
function dedupeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} dir data directory (human-readable, plugin-owned)
 * @param {object} [opts] { flushMs?: number } backgrounded flush debounce (ms, default 500)
 */
export function openStore(dir, opts = {}) {
  const root = path.resolve(dir);
  const lessonsDir = path.join(root, 'lessons');
  const quarDir = path.join(root, 'quarantined');
  const trajDir = path.join(root, 'trajectories');
  const indexFile = path.join(root, 'index.json');
  const termIndexFile = path.join(root, 'termindex.json');
  const flushMs = opts.flushMs ?? 500;

  // In-memory state (the cache that serves the hot path).
  const rows = []; // index.json contents
  let termIndex = new Map(); // term -> Set<id>
  let disabled = false; // dir unwritable -> in-memory-only, no persistence
  let dirty = false;
  let flushTimer = null;
  const trajBuf = []; // buffered raw trajectories
  const mirrorBuf = []; // buffered .md mirror appends { file, line }

  function rebuildTermIndex() {
    const mi = new Map();
    for (const r of rows) {
      for (const t of lessonTerms(r)) {
        if (!mi.has(t)) mi.set(t, new Set());
        mi.get(t).add(r.id);
      }
    }
    termIndex = mi;
  }

  function addTermsFor(id, lesson) {
    for (const t of lessonTerms(lesson)) {
      if (!termIndex.has(t)) termIndex.set(t, new Set());
      termIndex.get(t).add(id);
    }
  }
  function removeTermsFor(id) {
    for (const t of [...termIndex.keys()]) {
      const set = termIndex.get(t);
      set.delete(id);
      if (!set.size) termIndex.delete(t);
    }
  }

  // --- backgrounded, debounced flush ---
  function scheduleFlush() {
    dirty = true;
    if (disabled || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushSync();
    }, flushMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref(); // never hold the process
  }

  /**
   * Write all pending state to disk. Best-effort: returns true on success, keeps `dirty`
   * on failure so the next flush retries. Never throws.
   */
  function flushSync() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (disabled) {
      dirty = false;
      return false;
    }
    if (!dirty && trajBuf.length === 0 && mirrorBuf.length === 0) return false;
    let ok = true;
    try {
      fs.writeFileSync(indexFile, JSON.stringify(rows, null, 2), 'utf8');
      const out = {};
      for (const [t, ids] of termIndex) out[t] = [...ids];
      fs.writeFileSync(termIndexFile, JSON.stringify(out, null, 2), 'utf8');
    } catch {
      ok = false;
    }
    // Pop item-by-item instead of splice(0)-draining: an append failure must RETRY the
    // failed + remaining items on the next flush, not silently drop the rest of the batch.
    try {
      while (mirrorBuf.length) {
        const m = mirrorBuf[0];
        fs.mkdirSync(path.dirname(m.file), { recursive: true });
        fs.appendFileSync(m.file, m.line + '\n', 'utf8');
        mirrorBuf.shift();
      }
    } catch {
      ok = false;
    }
    try {
      while (trajBuf.length) {
        const t = trajBuf[0];
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.appendFileSync(t.file, t.body, 'utf8');
        trajBuf.shift();
      }
    } catch {
      ok = false;
    }
    if (ok) dirty = false;
    return ok;
  }

  /** Async best-effort flush (for cleanup paths that can await). */
  async function flush() {
    await new Promise((r) => setImmediate(r)); // yield so sync writes run off the hot tick
    return flushSync();
  }

  /** Tear down: flush + stop the timer. Call on plugin cleanup. */
  function close() {
    flushSync();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  const store = {
    dir: root,

    /** True when persistence is off (dir unwritable); reads/writes stay in-memory. */
    get disabled() {
      return disabled;
    },

    /**
     * Create the layout and load index.json into the in-memory cache. Never throws: on any
     * fs error it sets disabled=true and continues in-memory-only.
     */
    ensureLayout() {
      try {
        for (const d of [root, lessonsDir, quarDir, trajDir]) fs.mkdirSync(d, { recursive: true });
        if (!fs.existsSync(indexFile)) fs.writeFileSync(indexFile, '[]', 'utf8');
        const arr = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        rows.length = 0;
        if (Array.isArray(arr)) for (const r of arr) rows.push(r);
        rebuildTermIndex();
        disabled = false;
      } catch {
        disabled = true; // graceful degrade: in-memory only, no persistence
      }
    },

    /** @returns {Array<object>} a copy of all lesson rows (trusted + quarantined). */
    list() {
      return [...rows];
    },

    /**
     * Add a lesson to the in-memory cache immediately (so retrieval is instant) and stage a
     * backgrounded, debounced disk write (.md mirror + index). Untrusted -> quarantined/,
     * trusted -> lessons/. @returns {object} the row
     */
    addLesson(lesson) {
      const l = {
        id: lesson.id || newId(),
        domain: slug(lesson.domain || lesson.tags?.[0]),
        tags: Array.isArray(lesson.tags) ? lesson.tags : [],
        summary: String(lesson.summary || '').trim(),
        fix: lesson.fix ? String(lesson.fix) : null,
        layer: lesson.layer || 'Q',
        trusted: lesson.trusted !== false,
        weight: typeof lesson.weight === 'number' ? lesson.weight : 0.3,
        sourceRef: lesson.sourceRef || null,
        createdAt: lesson.createdAt || now(),
        updatedAt: now(),
      };
      rows.push(l);
      addTermsFor(l.id, l);
      if (!disabled) {
        const body = `- [${l.id}] [${l.layer}] ${l.summary}${l.fix ? ` -> fix: ${l.fix}` : ''}  ${l.sourceRef ? `(src ${l.sourceRef})` : ''}${l.trusted ? '' : '  (QUARANTINED)'}`;
        const file = path.join(l.trusted ? lessonsDir : quarDir, l.domain + '.md');
        mirrorBuf.push({ file, line: body });
      }
      scheduleFlush();
      return l;
    },

    /** @returns {Array<object>} candidate rows via the in-memory inverted index. */
    candidatesFor(task, cap = 40) {
      if (!termIndex.size) return [...rows]; // empty index: serve everything cached
      const q = tokenize(task);
      const idCount = new Map();
      for (const t of q) {
        const ids = termIndex.get(t);
        if (!ids) continue;
        for (const id of ids) idCount.set(id, (idCount.get(id) || 0) + 1);
      }
      if (!idCount.size) return [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      return [...idCount.keys()]
        .sort((a, b) => idCount.get(b) - idCount.get(a))
        .slice(0, cap)
        .map((id) => byId.get(id))
        .filter(Boolean);
    },

    /** Most similar existing lesson (in-memory term overlap) for the de-dup gate. */
    findSimilar(lesson, cap = 8) {
      if (!termIndex.size) return null;
      const q = tokenize(JSON.stringify([lesson.domain, (lesson.tags || []).join(' '), lesson.summary, lesson.fix]));
      const ids = new Set();
      for (const t of q) {
        const ids2 = termIndex.get(t);
        if (ids2) for (const id of ids2) ids.add(id);
      }
      const pool = rows.filter((r) => ids.has(r.id)).slice(0, cap);
      let best = null;
      for (const r of pool) {
        const a = lessonTerms(r);
        const common = [...q].filter((t) => a.has(t)).length;
        const overlap = q.size ? common / q.size : 0;
        if (!best || overlap > best.overlap) best = { id: r.id, overlap };
      }
      return best;
    },

    /**
     * Strong duplicate gate for high-frequency records such as user instructions.
     * Unlike findSimilar, this compares normalized full text (summary + fix) and returns
     * true when ANY existing row is at or above `thr`, so "please use httpx for HTTP" and
     * "请使用 httpx 发请求" do not pile up as near-duplicates.
     */
    hasDuplicate(lesson, thr = 0.85) {
      const qText = dedupeText(JSON.stringify([lesson.domain, (lesson.tags || []).join(' '), lesson.summary, lesson.fix]));
      const q = tokenize(qText);
      if (!q.size) return false;
      for (const r of rows) {
        if (dedupeText(r.domain) !== dedupeText(lesson.domain || '')) continue;
        const a = lessonTerms(r);
        let common = 0;
        for (const t of q) if (a.has(t)) common += 1;
        if (q.size && common / q.size >= thr) return true;
      }
      return false;
    },

    /** Promote a quarantined lesson once a stronger signal confirms it. */
    promote(id, { note = 'promoted' } = {}) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.trusted = true;
      row.layer = row.layer === 'Q' ? 'L2' : row.layer;
      row.updatedAt = now();
      addTermsFor(row.id, row);
      if (!disabled) mirrorBuf.push({ file: path.join(lessonsDir, row.domain + '.md'), line: `[PROMOTE] ${id}: ${row.summary} — ${note}` });
      scheduleFlush();
      return row;
    },

    /** Drop a lesson from the cache + inverted index (persisted on flush). */
    remove(id) {
      const keep = rows.filter((r) => r.id !== id);
      rows.length = 0;
      for (const r of keep) rows.push(r);
      removeTermsFor(id);
      scheduleFlush();
      return true;
    },

    /** Buffer a raw trace (written to trajectories/ on flush); returns the file path. */
    addTrajectory(trace) {
      const file = path.join(trajDir, `${trace.ts || now()}_${trace.id || newId()}.jsonl`);
      trajBuf.push({ file, body: JSON.stringify(trace) + '\n' });
      scheduleFlush();
      return file;
    },

    /** Fast retrieve (in-memory): inverted-index pre-filter, then retrieve() ranks + caps. */
    search(task, cfg = {}) {
      const cand = store.candidatesFor(task, cfg.candCap ?? 40);
      if (!cand.length) return null;
      return retrieve(cand, task, cfg);
    },

    // --- flush / lifecycle ---
    flushSync,
    flush,
    close,
  };

  return store;
}
