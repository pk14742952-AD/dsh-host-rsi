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
const USER_CORRECTION_RE = /不对|错了|错误|改正|纠正|不要|别再|应该|请改|改成|正确|不是这样|reconsider|correct|wrong|don't|instead|change|must not|should not|please adjust|not that/i;
const USER_INSTRUCTION_RE = /记住|请记住|记得|以后|下次|务必|必须|禁止|不要|避免|请务必|请使用|请用|please remember|remember to|always|never|must|should|prefer|don't|please use/i;
const RULE_NOUN_RE = /偏好|规则|约束|约定|规定|标准|规范|preference|rule|constraint|standard|convention/i;
const USER_TASK_RE = /写|创建|实现|修复|优化|设计|分析|解释|列出|总结|转换|翻译|生成|check|write|create|fix|optimize|design|analyze|explain|list|summarize|translate|generate/i;

/**
 * Detect a user correction / explicit instruction after an assistant reply. These are
 * high-value signals: the user is teaching the model what to do differently next time.
 * A short chit-chat acknowledgement ("ok", "thanks") is not a correction.
 */
export function isUserCorrection({ correctionText } = {}) {
  const c = String(correctionText || '').trim();
  if (!c || c.length < 3) return false;
  if (/^\s*(ok|好的|谢谢|可以|yes|no|收到)\s*$/i.test(c)) return false;
  return USER_CORRECTION_RE.test(c) || c.length >= 20;
}

/**
 * Detect a user instruction / preference / constraint worth remembering. This is broader
 * than a correction: it also remembers the user's stated rules for future work, such as
 * "以后都用 httpx" or "请使用异步方式". Chit-chat acknowledgements are excluded.
 */
export function isUserInstruction({ instructionText } = {}) {
  const t = String(instructionText || '').trim();
  if (!t || t.length < 4) return false;
  if (/^\s*(ok|好的|谢谢|可以|收到|yes|no)\s*$/i.test(t)) return false;
  if (USER_INSTRUCTION_RE.test(t)) return true;
  if (RULE_NOUN_RE.test(t) && t.length >= 10) return true;
  return false;
}

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
