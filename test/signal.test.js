import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySignal, isInjectable, LAYERS } from '../lib/signal.js';

test('L1 definitive check wins and is trusted (pass or fail both corrective)', () => {
  assert.deepEqual(classifySignal({ scorer: { definitive: true, passed: true } }), {
    layer: 'L1', trusted: true, weight: 1.0, note: 'L1 verifiable check passed',
  });
  assert.deepEqual(classifySignal({ scorer: { definitive: true, passed: false } }), {
    layer: 'L1', trusted: true, weight: 1.0, note: 'L1 verifiable check FAILED -> corrective lesson',
  });
});

test('L3 user tap is authoritative and overrides self-verdict', () => {
  const c = classifySignal({ verdict: 'CONFIRMED', userTap: { verdict: 'REFUTED' } });
  assert.equal(c.layer, LAYERS.L3);
  assert.equal(c.trusted, false); // user said wrong
});

test('self-REFUTED becomes a trusted corrective lesson', () => {
  const c = classifySignal({ verdict: 'REFUTED' });
  assert.equal(c.layer, 'L2');
  assert.equal(c.trusted, true);
});

test('self-CONFIRMED above threshold is trusted; below threshold is quarantined', () => {
  assert.equal(classifySignal({ verdict: 'CONFIRMED', conf: 0.9, threshold: 0.6 }).trusted, true);
  assert.equal(classifySignal({ verdict: 'CONFIRMED', conf: 0.3, threshold: 0.6 }).trusted, false);
  assert.equal(classifySignal({ verdict: 'CONFIRMED', conf: 0.3, threshold: 0.6 }).layer, 'Q');
});

test('UNCERTAIN / no verdict is quarantined (not injectable)', () => {
  const c = classifySignal({ verdict: 'UNCERTAIN' });
  assert.equal(c.trusted, false);
  assert.equal(isInjectable(c), false);
  assert.equal(isInjectable(classifySignal({})), false);
});
