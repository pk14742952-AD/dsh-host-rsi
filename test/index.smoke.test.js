import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, Config } from '../index.js';

test('Config.defaults carries the optimization knobs', () => {
  assert.equal(Config.defaults.enabled, true);
  assert.ok(typeof Config.defaults.flushMs === 'number' && Config.defaults.flushMs > 0);
  assert.equal(Config.defaults.inject.enabled, true);
  assert.equal(Config.defaults.capture.enabled, true);
});

test('apply() with a minimal/unknown ctx never throws and returns a cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-idx-'));
  // A ctx missing every documented host API -> all hooks no-op safely (max compatibility).
  const cleanup = apply({ someUnknownCtx: true }, { enabled: true, dir, flushMs: 500 });
  assert.equal(typeof cleanup, 'function');
  cleanup(); // store.close() flush; must not throw
});

test('apply() with enabled=false is a full no-op (data dir untouched)', () => {
  const cleanup = apply({}, { enabled: false, dir: 'C:/should-not-be-created' });
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.ok(!fs.existsSync('C:/should-not-be-created'));
});
