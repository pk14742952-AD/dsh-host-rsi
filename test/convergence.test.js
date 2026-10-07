import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRONG_STEER,
  SOFT_STEER,
  POLICY_TEXT,
  createState,
  resetState,
  isSourceEdit,
  isShellTool,
  commandOf,
  resultText,
  normalizeModels,
  isModelActive,
  observeShell,
} from '../lib/convergence.js';

test('state: create/reset are idempotent and isolate counters', () => {
  const s = createState();
  assert.equal(s.steered, false);
  assert.equal(s.passedFamilies.size, 0);
  assert.equal(s.fingerprintCounts.size, 0);
  s.passedFamilies.add('test');
  s.fingerprintCounts.set('x', 1);
  resetState(s);
  assert.equal(s.passedFamilies.size, 0);
  assert.equal(s.fingerprintCounts.size, 0);
  assert.equal(s.steered, false);
});

test('tool classification: source edits reset, shells are observed', () => {
  assert.equal(isSourceEdit('edit'), true);
  assert.equal(isSourceEdit('write'), true);
  assert.equal(isSourceEdit('pwsh'), false);
  assert.equal(isShellTool('pwsh'), true);
  assert.equal(isShellTool('bash'), true);
  assert.equal(isShellTool('edit'), false);
});

test('commandOf/resultText read DSH exec shapes', () => {
  assert.equal(commandOf({ command: 'npm test' }), 'npm test');
  assert.equal(commandOf({}), '');
  assert.equal(resultText({ content: [{ type: 'text', text: '1 passed' }, { type: 'image', url: 'x' }] }), '1 passed');
  assert.equal(resultText({ content: 'not-an-array' }), '');
});

test('normalizeModels: undefined/null means all models, [] means all, strings kept', () => {
  assert.deepEqual(normalizeModels(undefined), []);
  assert.deepEqual(normalizeModels(null), []);
  assert.deepEqual(normalizeModels([]), []);
  assert.deepEqual(normalizeModels('*27b*'), ['*27b*']);
  assert.deepEqual(normalizeModels(['*27b*', '']), ['*27b*']);
});

test('isModelActive: wildcard 27b matching, case-insensitive, fail-closed', () => {
  assert.equal(isModelActive('qwen3-27b-instruct', ['*27b*']), true);
  assert.equal(isModelActive('Qwen3-27B-MTP', ['*27b*']), true);
  assert.equal(isModelActive('deepseek-v4.1-flash', ['*27b*']), false);
  assert.equal(isModelActive('', ['*27b*']), false);
  assert.equal(isModelActive('anything', []), true);
  assert.equal(isModelActive(undefined, []), true);
});

test('observeShell: repeated passing check emits one soft steer, then stays silent', () => {
  const s = createState();
  const args = { command: 'python -m pytest tests/test_x.py -q' };
  const text = '2 passed in 0.5s';
  assert.equal(observeShell(s, commandOf(args), text, 3), null);
  assert.equal(observeShell(s, commandOf(args), text, 3), null);
  assert.equal(observeShell(s, commandOf(args), text, 3), SOFT_STEER);
  assert.equal(observeShell(s, commandOf(args), text, 3), null, 'steer is emitted only once until reset');
});

test('observeShell: two distinct passing families emit strong steer', () => {
  const s = createState();
  const pytest = { command: 'python -m pytest tests/test_a.py' };
  const build = { command: 'npm run build' };
  assert.equal(observeShell(s, commandOf(pytest), '1 passed', 3), null);
  assert.equal(observeShell(s, commandOf(build), 'Build succeeded', 3), STRONG_STEER);
  assert.equal(observeShell(s, commandOf(build), 'Build succeeded', 3), null, 'strong steer is also emitted once');
});

test('observeShell: failures and unknown commands are ignored', () => {
  const s = createState();
  assert.equal(observeShell(s, 'npm test', '1 failed', 3), null);
  assert.equal(observeShell(s, 'ls -la', 'some listing', 3), null);
  assert.equal(s.passedFamilies.size, 0);
  assert.equal(s.consecutivePassCount, 0);
});

test('observeShell: edit/write resets the convergence state', () => {
  const s = createState();
  const args = { command: 'npm test' };
  const text = '1 passed';
  observeShell(s, commandOf(args), text, 3);
  observeShell(s, commandOf(args), text, 3);
  resetState(s); // host calls this on tools/pre-execute for edit/write
  assert.equal(observeShell(s, commandOf(args), text, 3), null, 'counter restarts after a source edit');
});

test('POLICY_TEXT exists and is a stable completion policy', () => {
  assert.match(POLICY_TEXT, /TASK COMPLETION POLICY/);
  assert.match(POLICY_TEXT, /within 8000 tokens/);
});
