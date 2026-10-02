import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonTrivial, shouldCapture, shouldEscalate, criticBudgetOk, isDuplicate } from '../lib/policy.js';

const cfg = {
  capture: { enabled: true, maxPerSession: 20, minChars: 200, dedupeThreshold: 0.8 },
  escalate: { enabled: true, maxCriticsPerSession: 4, selfConsistency: 1, threshold: 0.6 },
};

test('non-trivial: error/failure is capture-worthy', () => {
  assert.equal(isNonTrivial({ taskText: 'fix the bug', answerText: '…Traceback (most recent…)…', toolResults: [] }), true);
});

test('non-trivial: opted-in [VERIFY] tag', () => {
  assert.equal(isNonTrivial({ taskText: 'x', answerText: 'ok [VERIFY: CONFIRMED; conf=0.5]', toolResults: [] }), true);
});

test('non-trivial: short chit-chat without tools is skipped', () => {
  assert.equal(isNonTrivial({ taskText: 'hi', answerText: 'hello there!', toolResults: [] }), false);
});

test('shouldCapture honors session budget', () => {
  const session = { captures: 20, critics: 0 };
  assert.equal(shouldCapture({ taskText: 'fix bug', answerText: 'Traceback error', toolResults: [], cfg, session }), false);
  assert.equal(shouldCapture({ taskText: 'fix bug', answerText: 'Traceback error', toolResults: [], cfg, session: { captures: 0, critics: 0 } }), true);
});

test('shouldCapture de-dups near-identical lessons', () => {
  assert.equal(shouldCapture({ taskText: 'x', answerText: 'Traceback error', toolResults: [], cfg, existingTop: { id: 'L1', overlap: 0.95 } }), false);
  assert.equal(shouldCapture({ taskText: 'x', answerText: 'Traceback error', toolResults: [], cfg, existingTop: { id: 'L1', overlap: 0.3 } }), true);
});

test('escalate: L1 resolved -> no critic', () => {
  assert.equal(shouldEscalate({ scorer: { definitive: true, passed: true }, verdict: 'CONFIRMED' }).do, false);
});

test('escalate: REFUTED / UNCERTAIN / no-tag -> auto critic', () => {
  assert.equal(shouldEscalate({ verdict: 'REFUTED', tag: {} }).do, true);
  assert.equal(shouldEscalate({ verdict: 'UNCERTAIN', tag: {} }).do, true);
  assert.equal(shouldEscalate({ verdict: undefined, tag: null }).do, true);
});

test('escalate: confident CONFIRMED -> no critic; low conf -> critic', () => {
  assert.equal(shouldEscalate({ verdict: 'CONFIRMED', conf: 0.9, tag: {}, threshold: 0.6 }).do, false);
  assert.equal(shouldEscalate({ verdict: 'CONFIRMED', conf: 0.4, tag: {}, threshold: 0.6 }).do, true);
});

test('escalate: user forces critic regardless', () => {
  assert.equal(shouldEscalate({ scorer: { definitive: true, passed: true }, userForced: true }).do, true);
});

test('critic budget caps auto rounds', () => {
  assert.equal(criticBudgetOk({ cfg, session: { critics: 0 } }), true);
  assert.equal(criticBudgetOk({ cfg, session: { critics: 4 } }), false);
});

test('isDuplicate threshold', () => {
  assert.equal(isDuplicate({ overlap: 0.85 }, cfg), true);
  assert.equal(isDuplicate({ overlap: 0.5 }, cfg), false);
});
