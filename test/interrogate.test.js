import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyTag, buildSelfCheckInstruction, selfConsistencyVerdicts, criticPrompt } from '../lib/interrogate.js';

test('instruction mentions counter-reason + the [VERIFY] tag + lesson field', () => {
  const s = buildSelfCheckInstruction();
  assert.match(s, /counter-reason/);
  assert.match(s, /\[VERIFY:/);
  assert.match(s, /lesson=/);
});

test('parses a full CONFIRMED tag with lesson + conf', () => {
  const t = parseVerifyTag('answer…\n[VERIFY: CONFIRMED; conf=0.8; lesson=always check edge case; reason=re-derived]');
  assert.equal(t.verdict, 'CONFIRMED');
  assert.equal(t.conf, 0.8);
  assert.equal(t.lesson, 'always check edge case');
});

test('parses REFUTED with a fix', () => {
  const t = parseVerifyTag('[VERIFY: REFUTED; conf=0.9; lesson=off-by-one; fix=use i<=n; reason=loop bound]');
  assert.equal(t.verdict, 'REFUTED');
  assert.equal(t.fix, 'use i<=n');
  assert.equal(t.lesson, 'off-by-one');
});

test('uses the LAST tag when several appear', () => {
  const t = parseVerifyTag('[VERIFY: UNCERTAIN; reason=x]\n... later ...[VERIFY: CONFIRMED; conf=0.7]');
  assert.equal(t.verdict, 'CONFIRMED');
});

test('returns null when no tag present', () => {
  assert.equal(parseVerifyTag('just a normal answer'), null);
});

test('self-consistency majority vote', () => {
  assert.equal(selfConsistencyVerdicts(['CONFIRMED', 'CONFIRMED', 'REFUTED']).verdict, 'CONFIRMED');
  assert.deepEqual(selfConsistencyVerdicts([]).verdict, 'UNCERTAIN');
});

test('critic prompt is independent and carries task + candidate', () => {
  const p = criticPrompt('compute 2+2', '4');
  assert.match(p, /strict critic/i);
  assert.match(p, /compute 2\+2/);
});
