// DSH host RSI — trigger + escalation policy (pure, no DSH/Node deps).
//
// Two goals:
//   (1) AUTOMATIC: the deep "critic round" is NOT a manual opt-in. It auto-escalates
//       whenever the cheap methods (L1 verifiable check, inline self-interrogation) did
//       not resolve a non-trivial turn — or when the user forces it.
//   (2) EFFICIENT + REASONABLE TRIGGERING: the plugin no-ops when nothing matters.
//       Capture fires on *outcome* signals (a tool ran / an error appeared / an artifact
//       was produced / the model opted in with a [VERIFY] tag), tuned by threshold, and
//       is de-duplicated so the same lesson is not captured repeatedly.

const ERROR_RE = /error|fail|wrong|bug|exception|traceback|assertion|panic|denied|undefined|null pointer|cannot|does not/i;
const DECISION_RE = /should|recommend|fix|implement|optimize|design|algorithm|proof|theorem|debug|approach|solution/i;

/** Does the turn carry an *outcome* signal worth evolving from? */
export function outcomeSignal({ taskText, answerText, toolResults } = {}) {
  const a = String(answerText || '');
  const t = String(taskText || '');
  const ranTools = (toolResults || []).length > 0;
  const hadFailure = toolResults.some((r) => r && r.ok === false) || ERROR_RE.test(a);
  const hasCode = /```|function |def |for \(|const |class |SELECT |return /i.test(a + t);
  return { hasVerifyTag: /\[VERIFY:/.test(a), ranTools, hadFailure, hasCode };
}

/**
 * REASONABLE capture trigger (default). A turn is evolution-worthy when it carries an
 * outcome signal — an error/failure, a produced artifact, a tool run, an opted-in tag,
 * or a substantive decision — and the answer is non-trivial. Tunable via cfg.capture.
 */
export function isNonTrivial({ taskText, answerText, toolResults, cfg } = {}) {
  const s = outcomeSignal({ taskText, answerText, toolResults });
  if (s.hasVerifyTag) return true; // model explicitly opted in
  if (s.hadFailure) return true; // something went wrong -> high-value recovery lesson
  const strongText = DECISION_RE.test(String(taskText || '') + ' ' + String(answerText || ''));
  const minChars = cfg?.capture?.minChars ?? 120;
  // Any tool-backed turn is worth recording; the actual lesson may be quarantined
  // until a stronger signal arrives, but the user can see the plugin is active.
  if (s.ranTools) return true;
  if (s.hasCode && String(answerText || '').length >= minChars) return true; // code-shaped answer
  if (String(answerText || '').length >= minChars && strongText) return true; // substantive decision
  // Fallback: a long, deliberate answer to a non-tiny task is also evolution-worthy.
  return String(taskText || '').length >= 6 && String(answerText || '').length >= minChars * 2;
}

/**
 * De-dup gate: skip re-capturing when a very similar lesson already exists.
 * @param {object} existingTop  store.findSimilar(lesson) -> { id, overlap } (0..1)
 * @param {object} cfg
 * @returns {boolean} true = treat as duplicate, skip capture
 */
export function isDuplicate(existingTop, cfg) {
  if (!existingTop) return false;
  const thr = cfg?.capture?.dedupeThreshold ?? 0.8;
  return existingTop.overlap >= thr;
}


/**
 * Capture gate: only evolution-worthy, non-duplicate turns, within the per-session budget.
 * @returns {boolean}
 */
export function shouldCapture({ taskText, answerText, toolResults, cfg, session, existingTop } = {}) {
  const capture = cfg.capture || {};
  if (capture.enabled === false) return false;
  if (session && typeof session.captures === 'number' && session.captures >= (capture.maxPerSession ?? 20)) return false;
  if (!isNonTrivial({ taskText, answerText, toolResults, cfg })) return false;
  if (isDuplicate(existingTop, cfg)) return false;
  return true;
}

/**
 * Escalation gate: should we auto-open the (heavier) critic round?
 * Auto-escalates when no definitive L1 check resolved it and the cheap self-interrogation
 * came back unresolved (refuted / uncertain / missing / low-conf), or when the user forces it.
 * Skipped when L1 or a confident self-CONFIRMED already resolved it (efficiency).
 *
 * @returns {{do:boolean, why:string}}
 */
export function shouldEscalate({ scorer, verdict, conf, tag, userForced = false, threshold = 0.6 } = {}) {
  // A user explicitly requesting deep-verify always wins.
  if (userForced) return { do: true, why: 'user requested deep-verify' };
  // A definitive L1 check already resolved it -> no critic needed (efficiency).
  if (scorer && scorer.definitive) return { do: false, why: 'L1 verifiable check already resolved it' };
  if (!tag) return { do: true, why: 'non-trivial turn had no self-check tag; auto critic round' };
  if (verdict === 'REFUTED') return { do: true, why: 'self-refuted; independent re-derivation to verify the fix' };
  if (verdict === 'UNCERTAIN') return { do: true, why: 'still uncertain; auto critic round' };
  if (verdict === 'CONFIRMED') {
    const c = conf == null ? 1 : Number(conf);
    if (Number.isFinite(c) && c < threshold) return { do: true, why: `low self-conf ${c}; auto critic round` };
    return { do: false, why: 'self-confirmed above threshold' };
  }
  return { do: true, why: 'default: escalate unresolved non-trivial turn' };
}

/**
 * Budget gate for critic rounds (auto or forced).
 * @returns {boolean}
 */
export function criticBudgetOk({ cfg, session } = {}) {
  const esc = cfg.escalate || {};
  if (session && typeof session.critics === 'number' && session.critics >= (esc.maxCriticsPerSession ?? 4)) return false;
  if (esc.enabled === false) return false;
  return true;
}
