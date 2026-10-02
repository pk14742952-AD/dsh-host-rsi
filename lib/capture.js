// DSH host RSI — capture orchestration (pure, no DSH/Node deps).
//
// Turns a finished turn (task + model's closing text + tool results) into a classified
// lesson plus a raw trajectory record. This is the heart of "per-use evolution":
//   task/answer  ->  parse the model's [VERIFY] self-interrogation  ->
//   run any L1 verifiable check  ->  classify on the signal ladder  ->
//   store (trusted => inject later; uncertain => quarantine).

import { parseVerifyTag } from './interrogate.js';
import { classifySignal } from './signal.js';
import { runScorers } from './scorers.js';

/**
 * @param {object} p
 * @param {object}  p.task            { text, domain?, tags? }  what the user asked
 * @param {string}  p.answerText      the model's closing assistant message (may carry a [VERIFY] tag)
 * @param {Array<{name:string, ok:boolean}>} [p.toolResults]
 * @param {*}  [p.expected]          expected value (math L1)
 * @param {Array} [p.expectedRows] / [p.actualRows]  (sql L1)
 * @param {Array<string>} [p.requiredKeys]  (schema L1)
 * @param {object} [p.userTap]       final user feedback { verdict } when provided
 * @param {number} [p.threshold]     min self-conf to trust a self-CONFIRMED
 * @returns {{ lesson: object, tag: object, scorer: object, cls: object, capture: boolean }}
 */
export function captureFromContext(p = {}) {
  const { task, answerText, userTap, threshold } = p;
  const ctx = {
    task: task?.text,
    answer: answerText,
    toolResults: p.toolResults || [],
    expected: p.expected,
    expectedRows: p.expectedRows,
    actualRows: p.actualRows,
    requiredKeys: p.requiredKeys,
  };

  const tag = parseVerifyTag(answerText);
  const scorer = runScorers(ctx);
  const verdict = tag?.verdict ?? 'UNCERTAIN';
  const cls = classifySignal({ verdict, conf: tag?.conf ?? null, scorer, userTap, threshold });

  // A lesson is only worth storing when there is something to remember.
  const capture = !!(tag?.lesson || tag?.fix || scorer.definitive);
  const lesson = {
    domain: task?.domain || (scorer.via ? `l1-${scorer.via}` : 'general'),
    tags: [
      ...(task?.tags || []),
      ...(scorer.via ? [`l1-${scorer.via}`] : []),
      `verdict-${verdict.toLowerCase()}`,
    ],
    summary: tag?.lesson || tag?.reason || (scorer.definitive ? `L1 ${scorer.via} check ${scorer.passed ? 'passed' : 'FAILED'}` : ''),
    fix: tag?.fix ?? (scorer.definitive && !scorer.passed ? 'L1 check failed; see trajectory' : null),
    layer: cls.layer,
    trusted: cls.trusted,
    weight: cls.weight,
    note: cls.note,
  };

  const trajectory = {
    ts: Date.now(),
    task: task?.text || null,
    domain: lesson.domain,
    verdict,
    conf: tag?.conf ?? null,
    lesson: tag?.lesson || null,
    fix: tag?.fix || null,
    scorer: { via: scorer.via || null, definitive: scorer.definitive, passed: scorer.definitive ? scorer.passed : null },
    layer: cls.layer,
    trusted: cls.trusted,
  };

  return { lesson, tag, scorer, cls, trajectory, capture };
}
