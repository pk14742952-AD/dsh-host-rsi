// DSH host RSI — L1 verifiable checks (pure, no DSH/Node deps).
//
// In GENERAL mode most tasks have no clean scorer, so we auto-detect the strongest
// available check and run it; if none is definitive, the outcome falls through to the
// self-interrogation (L2) / user-tap (L3) layers. Each scorer returns
// { definitive, passed } when it applies, or null when it does not.

/** Code / exec: trustworthy when a test or command actually ran and reported pass/fail. */
const TOOL_RE = /^(test|tests|jest|vitest|pytest|go test|cargo test|tsc|node)/i;
export const codeScorer = {
  name: 'code',
  match(c) {
    return !!(c.toolResults || []).some((r) => TOOL_RE.test(r.name || ''));
  },
  check(c) {
    const trs = (c.toolResults || []).filter((r) => TOOL_RE.test(r.name || ''));
    if (!trs.length) return null;
    const failed = trs.filter((r) => r.ok === false).length;
    return { definitive: true, passed: failed === 0 };
  },
};

/** Math / expected: trustworthy when an expected value was provided and an answer was produced. */
export const mathScorer = {
  name: 'math',
  match(c) {
    return c.expected !== undefined && c.answer !== undefined && c.expected !== '';
  },
  check(c) {
    if (!this.match(c)) return null;
    const a = String(c.answer).trim();
    const e = String(c.expected).trim();
    let passed = a === e;
    if (!passed) {
      const na = Number(a);
      const ne = Number(e);
      if (Number.isFinite(na) && Number.isFinite(ne)) passed = Math.abs(na - ne) < 1e-9;
    }
    return { definitive: true, passed };
  },
};

/** SQL: trustworthy when a golden result-set summary was supplied (rare in ad-hoc use). */
export const sqlScorer = {
  name: 'sql',
  match(c) {
    return Array.isArray(c.expectedRows);
  },
  check(c) {
    if (!this.match(c)) return null;
    const got = Array.isArray(c.actualRows) ? c.actualRows : [];
    const norm = (r) => JSON.stringify(r);
    const passed = got.length === c.expectedRows.length && c.expectedRows.every((row, i) => norm(row) === norm(got[i]));
    return { definitive: true, passed };
  },
};

/** Schema: trustworthy when a produced JSON must carry required keys. */
export const schemaScorer = {
  name: 'schema',
  match(c) {
    return Array.isArray(c.requiredKeys) && c.answer !== undefined;
  },
  check(c) {
    if (!this.match(c)) return null;
    let obj = c.answer;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch { return { definitive: true, passed: false }; }
    }
    const passed = c.requiredKeys.every((k) => obj && Object.prototype.hasOwnProperty.call(obj, k));
    return { definitive: true, passed };
  },
};

export const scorers = [codeScorer, mathScorer, sqlScorer, schemaScorer];

/**
 * Run all applicable scorers; return the first definitive result, else { definitive:false }.
 * @param {object} captureContext  { task, answer, expected?, expectedRows?, actualRows?, requiredKeys?, toolResults? }
 */
export function runScorers(captureContext) {
  for (const s of scorers) {
    try {
      if (s.match(captureContext)) {
        const r = s.check(captureContext);
        if (r && r.definitive) return { ...r, via: s.name };
      }
    } catch {
      /* a broken scorer must never break capture */
    }
  }
  return { definitive: false };
}
