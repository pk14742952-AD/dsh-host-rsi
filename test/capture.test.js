import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFromContext, captureUserCorrection, captureUserInstruction } from '../lib/capture.js';

test('self-REFUTED turn -> trusted corrective lesson with fix', () => {
  const r = captureFromContext({
    task: { text: 'off-by-one loop' },
    answerText: 'wrong bound\n[VERIFY: REFUTED; conf=0.9; lesson=use <=n; fix=for i in 0..=n; reason=loop bound]',
  });
  assert.equal(r.lesson.layer, 'L2');
  assert.equal(r.lesson.trusted, true);
  assert.equal(r.lesson.fix, 'for i in 0..=n');
  assert.equal(r.capture, true);
});

test('L1 failing test -> trusted corrective lesson (no self-tag needed)', () => {
  const r = captureFromContext({
    task: { text: 'run the suite' },
    answerText: 'done',
    toolResults: [{ name: 'jest', ok: false }],
  });
  assert.equal(r.lesson.layer, 'L1');
  assert.equal(r.lesson.trusted, true);
  assert.match(r.lesson.summary, /FAILED/);
});

test('confident self-CONFIRMED -> trusted L2; low conf -> quarantined', () => {
  const hi = captureFromContext({ task: { text: 'x' }, answerText: '[VERIFY: CONFIRMED; conf=0.9; lesson=works]' });
  assert.equal(hi.lesson.trusted, true);
  assert.equal(hi.lesson.layer, 'L2');
  const lo = captureFromContext({ task: { text: 'x' }, answerText: '[VERIFY: CONFIRMED; conf=0.2; lesson=maybe]', threshold: 0.6 });
  assert.equal(lo.lesson.trusted, false);
  assert.equal(lo.lesson.layer, 'Q');
});

test('nothing to remember -> capture=false', () => {
  const r = captureFromContext({ task: { text: 'hi' }, answerText: 'hello' });
  assert.equal(r.capture, false);
});

test('generic tool failure without a self-tag still becomes a visible quarantined lesson', () => {
  const r = captureFromContext({
    task: { text: 'query the database' },
    answerText: 'the query failed',
    toolResults: [{ name: 'sql', ok: false }],
  });
  assert.equal(r.capture, true);
  assert.equal(r.lesson.trusted, false);
  assert.equal(r.lesson.layer, 'Q');
  assert.match(r.lesson.summary, /tool failed/);
});

test('explicit user correction becomes a trusted L3 lesson', () => {
  const r = captureUserCorrection({ taskText: '用 Python 写个脚本', correctionText: '不要用 requests，改用 httpx' });
  assert.ok(r, 'user correction should capture');
  assert.equal(r.capture, true);
  assert.equal(r.lesson.layer, 'L3');
  assert.equal(r.lesson.trusted, true);
  assert.equal(r.lesson.domain, 'user-correction');
  assert.match(r.lesson.summary, /User correction/);
});

test('explicit user instruction/preference becomes a trusted L3 lesson', () => {
  const r = captureUserInstruction({ instructionText: '以后都用 httpx，不要用 requests' });
  assert.ok(r, 'user instruction should capture');
  assert.equal(r.capture, true);
  assert.equal(r.lesson.layer, 'L3');
  assert.equal(r.lesson.trusted, true);
  assert.equal(r.lesson.domain, 'user-instruction');
  assert.match(r.lesson.summary, /User instruction/);
});
