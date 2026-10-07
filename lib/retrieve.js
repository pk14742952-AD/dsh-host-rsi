// DSH host RSI — lesson retrieval (pure, no DSH/Node deps).
//
// Ranks + budget-caps the most relevant TRUSTED lessons for a task. The store feeds this a
// small candidate set (pre-filtered by the inverted index); retrieve does the final scoring.
//
// HARDENED (evaluation round 2) — three changes, each fixing a measured defect:
//   1. stopword filtering + light suffix stemming, so ranking is not driven by "the"/"for";
//   2. IDF weighting over the candidate pool, so a rare topical term (httpx) outweighs a
//      common one (project/always) — a raw overlap count cannot express that;
//   3. standing project rules (raw tag `project:<slug>`) are injected FIRST, because they
//      apply by scope. Previously they had to win a lexical lottery against the current
//      task's wording, and a terse task lost the rule entirely.

import { LAYER_ORDER } from './signal.js';
import { projectSlug } from './capture.js';

// Function words carry no topical signal. Without this, an unrelated lesson is retrievable
// purely on "the" overlap — which is how host boilerplate reached the injected block.
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just',
  'me', 'mine', 'more', 'most', 'my', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'to', 'too', 'under', 'until', 'up', 'us', 'use', 'used', 'uses', 'using', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours',
]);

// Very light suffix folding. Deliberately conservative: it only bridges the plural/verb "s"
// that separated "convention" from "conventions", and it protects "ss"/"us" endings so
// "css" and "status" are left alone.
function stem(w) {
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  // Latin/ASCII words + digit runs (space/punct separated).
  for (const w of s.split(/[^a-z0-9]+/)) {
    if (!w || STOPWORDS.has(w)) continue;
    tokens.add(stem(w));
  }
  // CJK: split by single chars so "写一个 Python 下载脚本" and "写 python 下载脚本"
  // share unigram hits even with no spaces between Chinese words.
  // CJK characters are never stopword-filtered: the English list does not apply to them.
  const cjk = s.match(/[\u4e00-\u9fff]+/g);
  if (cjk) for (const run of cjk) for (const ch of run) tokens.add(ch);
  return tokens;
}

// Rough token estimate (~4 chars/token) for a budget cap.
export function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

/** Inverse document frequency over the candidate pool. Rare terms dominate common ones. */
function idfWeight(df, N) {
  return Math.log(1 + N / (1 + df));
}

/** Document frequency per term across the pool (a term counts once per lesson). */
function buildDf(pool) {
  const df = new Map();
  for (const l of pool) {
    const terms = new Set();
    for (const t of tokenize((l.tags || []).join(' '))) terms.add(t);
    for (const t of tokenize(l.summary || '')) terms.add(t);
    if (l.fix) for (const t of tokenize(l.fix)) terms.add(t);
    for (const t of terms) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

function relevance(lesson, qTokens, df, N) {
  const tagT = tokenize((lesson.tags || []).join(' '));
  const sumT = tokenize(lesson.summary || '');
  const fixT = lesson.fix ? tokenize(lesson.fix) : new Set();
  let score = 0;
  for (const t of qTokens) {
    const w = idfWeight(df.get(t) || 0, N);
    if (tagT.has(t)) score += 2 * w;
    if (sumT.has(t)) score += w;
    if (fixT.has(t)) score += w;
  }
  return score;
}

/** Raw tag match — `project:<slug>` must NOT be tokenized (tokenize splits on ':'). */
function isStandingFor(lesson, slug) {
  if (!slug) return false;
  return (lesson.tags || []).includes(`project:${slug}`);
}

function compare(a, b) {
  if (b.s !== a.s) return b.s - a.s;
  const lo = (LAYER_ORDER[a.l.layer] ?? 9) - (LAYER_ORDER[b.l.layer] ?? 9); // stronger layer first
  if (lo !== 0) return lo;
  return (b.l.updatedAt || 0) - (a.l.updatedAt || 0); // then newer
}

/**
 * @param {Array<object>} lessons   candidate rows: {id, tags[], summary, layer, trusted, weight, updatedAt, fix?}
 * @param {string} task             the current task/goal text
 * @param {object} cfg             { topK, tokenBudget, preferTrusted, includeQuarantined, project }
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
  if (!pool.length) return null;

  const N = pool.length;
  const df = buildDf(pool);
  const slug = cfg.project ? projectSlug(cfg.project) : null;

  const scored = pool.map((l) => ({ l, s: relevance(l, q, df, N) }));

  // Standing project rules take the first slots by scope. Everything else competes on
  // relevance. Without this split a rule stored for this very project could be outranked
  // by unrelated lessons that merely happen to share the task's generic vocabulary.
  const standing = slug ? scored.filter((x) => isStandingFor(x.l, slug)) : [];
  const standingIds = new Set(standing.map((x) => x.l.id));
  const rest = scored.filter((x) => !standingIds.has(x.l.id) && x.s > 0);

  standing.sort(compare);
  rest.sort(compare);
  const picked = [...standing, ...rest].slice(0, topK);
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
