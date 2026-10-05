// DSH host RSI — lesson retrieval (pure, no DSH/Node deps).
//
// Ranks + budget-caps the most relevant TRUSTED lessons for a task. The store feeds this a
// small candidate set (pre-filtered by the inverted index); retrieve does the final scoring.

import { LAYER_ORDER } from './signal.js';

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  // Latin/ASCII words + digit runs (space/punct separated).
  for (const w of s.split(/[^a-z0-9]+/)) if (w) tokens.add(w);
  // CJK: split by single chars so "写一个 Python 下载脚本" and "写 python 下载脚本"
  // share unigram hits even with no spaces between Chinese words.
  const cjk = s.match(/[\u4e00-\u9fff]+/g);
  if (cjk) for (const run of cjk) for (const ch of run) tokens.add(ch);
  return tokens;
}

function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

function relevance(lesson, qTokens) {
  let score = 0;
  score += 2 * overlap(tokenize((lesson.tags || []).join(' ')), qTokens);
  score += overlap(tokenize(lesson.summary || ''), qTokens);
  if (lesson.fix) score += overlap(tokenize(lesson.fix), qTokens);
  return score;
}

// Rough token estimate (~4 chars/token) for a budget cap.
export function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

/**
 * @param {Array<object>} lessons   candidate rows: {id, tags[], summary, layer, trusted, weight, updatedAt, fix?}
 * @param {string} task             the current task/goal text
 * @param {object} cfg             { topK, tokenBudget, preferTrusted, includeQuarantined }
 * @returns {string|null}          formatted prompt block, or null if nothing to inject
 */
export function retrieve(lessons, task, cfg = {}) {
  const topK = cfg.topK ?? 4;
  const budget = cfg.tokenBudget ?? 1500;
  if (!Array.isArray(lessons) || !lessons.length) return null;

  const q = tokenize(task);
  const pool = lessons.filter((l) =>
    cfg.includeQuarantined ? true : cfg.preferTrusted === false ? true : l.trusted !== false,
  );
  const scored = pool
    .map((l) => ({ l, s: relevance(l, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      const lo = (LAYER_ORDER[a.l.layer] ?? 9) - (LAYER_ORDER[b.l.layer] ?? 9); // stronger layer first
      if (lo !== 0) return lo;
      return b.l.updatedAt - a.l.updatedAt; // then newer
    });
  const picked = scored.slice(0, topK);
  if (!picked.length) return null;

  const lines = picked.map(({ l }) => {
    const body = l.layer === 'L1' && l.fix ? `${l.summary} -> fix: ${l.fix}` : `${l.summary}`;
    return `- [${l.layer || '?'}] ${body}`;
  });
  let text = 'Relevant trusted lessons from prior use (most useful first):';
  let used = estimateTokens(text);
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    text += '\n' + line;
    used += cost;
  }
  return text;
}
