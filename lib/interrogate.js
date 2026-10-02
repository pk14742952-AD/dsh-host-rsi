// DSH host RSI — self-interrogation (反问) engine (pure, no DSH/Node deps).
//
// Two paths:
//   1. INLINE (default, cheap): a fixed instruction injected into the prompt makes the
//      model, before finalizing a non-trivial answer, counter-reason (re-derive, find a
//      counterexample/edge case, check assumptions) and close with a single machine-parseable
//      [VERIFY: ...] tag. REFUTED carries a `fix` (a high-value corrective lesson).
//   2. CRITIC (optional escalation): a strict-critic prompt re-derives independently;
//      run it N times and majority-vote (self-consistency) when the task is uncertain/stakes.

const VERDICTS = ['CONFIRMED', 'REFUTED', 'UNCERTAIN'];

export function buildSelfCheckInstruction() {
  return [
    '[rsi-selfcheck]',
    'For any non-trivial answer (a result, conclusion, fix, or plan), before you finalize it do a quick counter-reason pass:',
    '  1) re-derive the result from scratch; 2) find one concrete counterexample or edge case; 3) name the key assumptions and check they hold.',
    'Then end the turn with a SINGLE line, using ; as the field separator, exactly one of:',
    '   [VERIFY: CONFIRMED; conf=<0..1>; lesson=<one line: what to remember>; reason=<short>]',
    '   [VERIFY: REFUTED; conf=<0..1>; lesson=<one line: the mistake to avoid>; fix=<corrected answer>; reason=<short>]',
    '   [VERIFY: UNCERTAIN; conf=<0..1>; lesson=<one line: what is still open>; reason=<short>]',
    'Keep `lesson` to a single concrete, reusable line (a gotcha, a rule, a working approach). Omit the tag on trivial or chit-chat turns. When unsure, prefer UNCERTAIN over a false CONFIRMED.',
  ].join('\n');
}

/**
 * Parse the LAST [VERIFY: ...] tag in a string.
 * @param {string} text
 * @returns {({verdict:string, conf:(number|null), reason:(string|null), fix:(string|null)})|null}
 */
export function parseVerifyTag(text) {
  if (!text) return null;
  const all = String(text).match(/\[VERIFY:[^\]]*\]/g);
  if (!all) return null;
  const raw = all[all.length - 1].replace(/^\[VERIFY:/, '').replace(/\]$/, '');
  const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
  const out = { verdict: 'UNCERTAIN', conf: null, reason: null, fix: null, lesson: null };
  for (const p of parts) {
    const eq = p.indexOf('=');
    const key = (eq === -1 ? p : p.slice(0, eq)).trim().toLowerCase();
    const val = (eq === -1 ? '' : p.slice(eq + 1)).trim();
    if (key === 'verdict') {
      out.verdict = (val || 'UNCERTAIN').toUpperCase();
    } else if (VERDICTS.includes(key.toUpperCase())) {
      // bare verdict token, e.g. "CONFIRMED" with no "verdict=" prefix
      out.verdict = key.toUpperCase();
    } else if (key === 'conf') {
      out.conf = val === '' ? null : Number(val);
    } else if (key === 'reason') {
      out.reason = val || null;
    } else if (key === 'fix') {
      out.fix = val || null;
    } else if (key === 'lesson') {
      out.lesson = val || null;
    }
  }
  // The first token is often the bare verdict ("CONFIRMED") with no "verdict=" key.
  if (parts[0] && VERDICTS.includes(parts[0].toUpperCase()) && !parts[0].toLowerCase().includes('=')) {
    out.verdict = parts[0].toUpperCase();
  }
  return out;
}

/** Strict-critic prompt (escalation path). Re-derives independently; outputs the same [VERIFY] tag. */
export function criticPrompt(task, candidateAnswer) {
  return [
    'You are a strict critic. Independently check the candidate answer below. Do NOT trust it.',
    'Steps: (1) re-derive the answer from scratch; (2) find any counterexample or edge case; (3) test the main assumptions; (4) check it against the task constraints.',
    'Then output ONE line, ; separated: [VERIFY: CONFIRMED|REFUTED|UNCERTAIN; conf=<0..1>; reason=<short>; fix=<corrected, only if REFUTED>]',
    '',
    'TASK:',
    String(task ?? ''),
    '',
    'CANDIDATE ANSWER:',
    String(candidateAnswer ?? ''),
  ].join('\n');
}

/**
 * Majority vote over N self/critic verdicts (self-consistency).
 * @param {string[]} verdicts  each in CONFIRMED|REFUTED|UNCERTAIN
 * @returns {{verdict:string, ratio:number, tally:Object}}
 */
export function selfConsistencyVerdicts(verdicts) {
  const arr = (verdicts || []).filter((v) => VERDICTS.includes(v));
  if (!arr.length) return { verdict: 'UNCERTAIN', ratio: 0, tally: {} };
  const tally = {};
  for (const v of arr) tally[v] = (tally[v] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return { verdict: top[0], ratio: top[1] / arr.length, tally };
}

export { VERDICTS };
