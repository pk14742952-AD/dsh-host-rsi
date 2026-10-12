import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OK, GUARD_STATES, classifyLoop, guardCorrectionPrompt, extractPlanLines, isFileTurn } from '../lib/guard.js';

const base = { thresholdFile: 2000, sameToolStreak: 3 };
// NOTE: thresholdEmpty now defaults to 0 (only a fully empty answer). The old 400-char default
// misfired on legitimate short dialogue turns (see issue#3 3188-round report §2.3 calibration).

test('classifyLoop: a substantial deliverable is OK', () => {
  const answer = '完成。\n'.repeat(200); // > 400 chars
  assert.deepEqual(classifyLoop({ ...base, answerText: answer }), { state: OK, reason: null });
});

test('classifyLoop: empty texts are EMPTY, short prose turns are OK (calibrated)', () => {
  assert.equal(classifyLoop({ ...base, answerText: '' }).state, 'EMPTY');
  assert.equal(classifyLoop({ ...base, answerText: '好的' }).state, OK, 'short dialogue answer is not a failed delivery');
  assert.equal(classifyLoop({ ...base, answerText: 'x'.repeat(399) }).state, OK, '399 chars is not empty under the default 0 threshold');
  // explicit thresholdEmpty still enforces when a caller opts in (deliverable profile)
  const strict = classifyLoop({ ...base, thresholdEmpty: 400, answerText: 'x'.repeat(399) });
  assert.equal(strict.state, 'EMPTY', 'explicit thresholdEmpty=400 opt-in still gates short answers');
});

test('classifyLoop: finish_reason=length with EMPTY content is EMPTY (budget burned), with content TRUNCATED', () => {
  const empty = classifyLoop({ ...base, answerText: '', finishReason: 'length' });
  assert.equal(empty.state, 'EMPTY', 'length + no content = vacuum delivery');
  assert.match(empty.reason, /budget burned/);
  const withContent = classifyLoop({ ...base, answerText: 'x'.repeat(500), finishReason: 'length' });
  assert.equal(withContent.state, 'TRUNCATED');
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

test('classifyLoop: three DIFFERENT commands through the same tool are NOT a shell loop', () => {
  const calls = [
    { name: 'pwsh', command: 'npm test' },
    { name: 'pwsh', command: 'git status' },
    { name: 'pwsh', command: 'ls -la' },
  ];
  const v = classifyLoop({ ...base, answerText: '', toolCalls: calls });
  assert.equal(v.state, 'EMPTY', 'distinct commands = real work, not a loop');
  // ...but the SAME command repeated IS a loop.
  const loop = classifyLoop({ ...base, answerText: '', toolCalls: [
    { name: 'pwsh', command: 'npm test' },
    { name: 'pwsh', command: 'npm test' },
    { name: 'pwsh', command: 'npm test' },
  ] });
  assert.equal(loop.state, 'SHELL_LOOP');
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

test('guardCorrectionPrompt truncates an oversized rejected answer', () => {
  const p = guardCorrectionPrompt('t', 'TRUNCATED', 'x'.repeat(20000));
  assert.ok(p.length < 12000, `prompt must stay bounded, got ${p.length} chars`);
  assert.match(p, /truncated, remaining 14000 chars/);
  assert.match(p, /x{800}$/, 'tail of the rejected answer is kept');
  assert.match(p, /\(excerpt\)/);
});

test('guardCorrectionPrompt: budget-burned EMPTY gets the targeted reasoning-failure wording', () => {
  const p = guardCorrectionPrompt('write a script', 'EMPTY', '', 'finish_reason=length with empty content (budget burned, nothing delivered)');
  assert.match(p, /spent the previous turn's budget on internal reasoning/);
  assert.match(p, /output the deliverable directly/);
  // ordinary EMPTY without the burn reason keeps the generic wording
  const generic = guardCorrectionPrompt('write a script', 'EMPTY', '');
  assert.doesNotMatch(generic, /budget on internal reasoning/);
  assert.match(generic, /complete and closed/);
});

test('GUARD_STATES matches every non-OK state the classifier can emit', () => {
  assert.deepEqual(GUARD_STATES, ['EMPTY', 'TRUNCATED', 'FIXED_POINT', 'SAME_PLAN', 'SHELL_LOOP']);
});
