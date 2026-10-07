import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OK, GUARD_STATES, classifyLoop, guardCorrectionPrompt, extractPlanLines, isFileTurn } from '../lib/guard.js';

const base = { thresholdEmpty: 400, thresholdFile: 2000, sameToolStreak: 3 };

test('classifyLoop: a substantial deliverable is OK', () => {
  const answer = '完成。\n'.repeat(200); // > 400 chars
  assert.deepEqual(classifyLoop({ ...base, answerText: answer }), { state: OK, reason: null });
});

test('classifyLoop: empty and short prose turns are EMPTY when no tools ran', () => {
  assert.equal(classifyLoop({ ...base, answerText: '' }).state, 'EMPTY');
  assert.equal(classifyLoop({ ...base, answerText: '好的' }).state, 'EMPTY');
  assert.equal(classifyLoop({ ...base, answerText: 'x'.repeat(399) }).state, 'EMPTY');
});

test('classifyLoop: tool-backed short summaries are not length-flagged', () => {
  const verdict = classifyLoop({ ...base, answerText: '已完成，文件写入 tests/out.js', toolCalls: ['write'], ranTools: true });
  assert.equal(verdict.state, OK);
});

test('classifyLoop: file turns still require a full inline deliverable without tools', () => {
  const verdict = classifyLoop({ ...base, answerText: 'x'.repeat(500), fileTurn: true });
  assert.equal(verdict.state, 'EMPTY', '500 chars < 2000 file threshold');
  const ok = classifyLoop({ ...base, answerText: 'x'.repeat(2001), fileTurn: true });
  assert.equal(ok.state, OK);
});

test('classifyLoop: TRUNCATED on odd code fence / open svg / finish length', () => {
  assert.equal(classifyLoop({ ...base, answerText: '```js\nconst a = 1;' }).state, 'TRUNCATED');
  assert.equal(classifyLoop({ ...base, answerText: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/>' }).state, 'TRUNCATED');
  assert.equal(classifyLoop({ ...base, answerText: 'x'.repeat(500), finishReason: 'length' }).state, 'TRUNCATED');
});

test('classifyLoop: FIXED_POINT when the answer repeats the previous one verbatim', () => {
  const v = classifyLoop({ ...base, answerText: 'same output '.repeat(40), prevAnswerText: 'same output '.repeat(40) });
  assert.equal(v.state, 'FIXED_POINT');
});

test('classifyLoop: SAME_PLAN when only the plan lines repeat', () => {
  const prev = 'OPT: build the parser\nSTATUS: waiting\n\nand here is prose A '.repeat(30);
  const cur = 'OPT: build the parser\nSTATUS: waiting\n\nand here is prose B '.repeat(30);
  const v = classifyLoop({ ...base, answerText: cur, prevAnswerText: prev });
  assert.equal(v.state, 'SAME_PLAN');
});

test('classifyLoop: SHELL_LOOP when a turn only repeats one tool with no text', () => {
  const v = classifyLoop({ ...base, answerText: '', toolCalls: ['pwsh', 'pwsh', 'pwsh'] });
  assert.equal(v.state, 'SHELL_LOOP');
  const mixed = classifyLoop({ ...base, answerText: '', toolCalls: ['pwsh', 'edit', 'pwsh'] });
  assert.equal(mixed.state, 'EMPTY', 'not a same-tool streak');
});

test('extractPlanLines + isFileTurn are regex-driven and safe', () => {
  assert.deepEqual(extractPlanLines('OPT: a\nNEXT: b\n普通行'), ['opt: a', 'next: b']);
  assert.equal(isFileTurn('please write a script', 'file|write|create'), true);
  assert.equal(isFileTurn('chat about weather', 'file|write|create'), false);
  assert.equal(isFileTurn('x', '['), false, 'invalid regex must not throw');
});

test('guardCorrectionPrompt identifies state + task for the followup round', () => {
  const p = guardCorrectionPrompt('write a script', 'TRUNCATED', '```js\nbroken');
  assert.match(p, /TRUNCATED/);
  assert.match(p, /write a script/);
  assert.match(p, /complete and closed/);
});

test('GUARD_STATES matches every non-OK state the classifier can emit', () => {
  assert.deepEqual(GUARD_STATES, ['EMPTY', 'TRUNCATED', 'FIXED_POINT', 'SAME_PLAN', 'SHELL_LOOP']);
});
