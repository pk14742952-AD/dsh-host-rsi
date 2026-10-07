// DSH host RSI — capture orchestration (pure, no DSH/Node deps).
//
// Turns a finished turn (task + model's closing text + tool results) into a classified
// lesson plus a raw trajectory record. This is the heart of "per-use evolution":
//   task/answer  ->  parse the model's [VERIFY] self-interrogation  ->
//   run any L1 verifiable check  ->  classify on the signal ladder  ->
//   store (trusted => inject later; uncertain => quarantine).
//
// HARDENED (evaluation round 2): user instructions / corrections are no longer truncated.
// Durability is decided by scanning the WHOLE message (isDurableUserInstruction), so slicing
// the stored copy to 160 chars silently discarded the very rule that made the record durable —
// a rule stated after a normal task preamble was remembered as "Your project directory is …".
// Injection length is bounded at injection time by retrieve()'s tokenBudget instead.

import { parseVerifyTag } from './interrogate.js';
import { classifySignal } from './signal.js';
import { runScorers } from './scorers.js';

export function projectSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const leaf = raw.split(/[\\/]/).filter(Boolean).pop() || raw;
  const slug = String(leaf).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

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
  // Failures are also worth surfacing: even when the model did not provide a
  // [VERIFY] lesson or an L1 check could not run, we keep a quarantine record so
  // the dashboard/settings page shows the plugin is actively watching real turns.
  const failureText = /error|fail|exception|traceback|assertion|panic|denied|cannot|does not/i.test(String(answerText || ''));
  const toolFail = (p.toolResults || []).some((t) => t && t.ok === false);
  const hadFailureSignal = failureText || toolFail;
  const capture = !!(tag?.lesson || tag?.fix || scorer.definitive || hadFailureSignal);
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

  // Failure fallback: turn into a visible, quarantined record so users can see the
  // trigger firing even before a strong L1/L2 signal exists.
  if (capture && hadFailureSignal && !tag?.lesson && !tag?.fix && !scorer.definitive) {
    const shortAnswer = String(answerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const shortTask = String(task?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    lesson.summary = lesson.summary || (toolFail ? `tool failed: ${shortTask || shortAnswer}` : `observed failure: ${shortAnswer || shortTask}`);
    lesson.fix = lesson.fix || (toolFail ? 'verify tool input/output before continuing' : 're-derive and verify before finalizing');
    lesson.layer = cls.layer || 'Q';
    lesson.trusted = false; // quarantine until a stronger signal confirms it
    trajectory.layer = lesson.layer;
    trajectory.trusted = lesson.trusted;
  }

  return { lesson, tag, scorer, cls, trajectory, capture };
}

/**
 * Capture an explicit user correction / new instruction after an assistant reply.
 * This is the most trustworthy memory signal available: the user just told the model
 * what to do differently, so we record it as a trusted L3 lesson immediately.
 *
 * @param {object} p
 * @param {string} [p.taskText]      the last task/goal before the correction
 * @param {string} [p.correctionText] the user's correction/instruction
 * @param {string} [p.project]        best-effort project/workspace key for per-project dedupe
 * @returns {{ lesson: object, trajectory: object, capture: boolean }|null}
 */
export function captureUserCorrection({ taskText, correctionText, project } = {}) {
  const text = String(correctionText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const p = projectSlug(project);
  const domain = p ? `user-correction/${p}` : 'user-correction';
  const projectTag = p ? `project:${p}` : null;
  return {
    capture: true,
    lesson: {
      domain,
      tags: projectTag ? ['user-correction', 'L3', projectTag] : ['user-correction', 'L3'],
      summary: `User correction: ${text}`,
      fix: text,
      layer: 'L3',
      trusted: true,
      weight: 1.0,
    },
    trajectory: {
      ts: Date.now(),
      task: taskText || null,
      domain,
      project: project || null,
      lesson: text,
      fix: text,
      layer: 'L3',
      trusted: true,
    },
  };
}

/**
 * Capture a user instruction / task before an answer. Durable rules/preferences are
 * stored as trusted L3 and injected later. Generic one-off tasks are still recorded for
 * visibility/analytics, but quarantined so they do not pollute future injection.
 */
export function captureUserInstruction({ instructionText, durable = false, project } = {}) {
  const text = String(instructionText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const layer = durable ? 'L3' : 'Q';
  const p = projectSlug(project);
  const domain = p ? `user-instruction/${p}` : 'user-instruction';
  const projectTag = p ? `project:${p}` : null;
  return {
    capture: true,
    lesson: {
      domain,
      tags: projectTag ? ['user-instruction', layer, projectTag] : ['user-instruction', layer],
      // Full text, deliberately untruncated: see the header note.
      summary: `User instruction: ${text}`,
      fix: text,
      layer,
      trusted: durable,
      weight: durable ? 1.0 : 0.15,
    },
    trajectory: {
      ts: Date.now(),
      task: text,
      domain,
      project: project || null,
      lesson: text,
      fix: text,
      layer,
      trusted: durable,
    },
  };
}
