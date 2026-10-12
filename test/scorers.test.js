import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScorers, mathScorer, codeScorer } from '../lib/scorers.js';

test('math scorer: exact and numeric match', () => {
  assert.deepEqual(runScorers({ expected: '4', answer: '4' }), { definitive: true, passed: true, via: 'math' });
  assert.deepEqual(runScorers({ expected: '4.0', answer: '4' }), { definitive: true, passed: true, via: 'math' });
  assert.equal(runScorers({ expected: '4', answer: '5' }).passed, false);
});

test('code scorer: failing tool result means not passed', () => {
  const r = runScorers({ toolResults: [{ name: 'pytest', ok: false }] });
  assert.equal(r.definitive, true);
  assert.equal(r.via, 'code');
  assert.equal(r.passed, false);
});

test('code scorer: bare `node` is not a test command', () => {
  const r = runScorers({ toolResults: [{ name: 'node', ok: true }] });
  assert.equal(r.definitive, false, 'running a plain node script proves nothing');
});

test('code scorer: node --test IS a test command and explicit ok=true passes', () => {
  const r = runScorers({ toolResults: [{ name: 'node --test', ok: true }] });
  assert.equal(r.definitive, true);
  assert.equal(r.passed, true);
});

test('code scorer: ok:undefined alone still counts as an executed check (pass)', () => {
  const r = runScorers({ toolResults: [{ name: 'jest', ok: undefined }] });
  assert.equal(r.definitive, true);
  assert.equal(r.passed, true);
});

test('no applicable scorer -> not definitive', () => {
  assert.deepEqual(runScorers({ task: 'write a poem' }), { definitive: false });
});

test('a broken scorer never throws and does not block others', () => {
  // feed math scorer something that would NaN -> still definitive with passed
  const r = mathScorer.check({ expected: 'abc', answer: 'xyz' });
  assert.equal(r.definitive, true);
  assert.equal(r.passed, false);
});
