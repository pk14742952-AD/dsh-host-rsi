import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

test('Config is not exported - cordis resolveConfig would crash on a plain object', async () => {
  const mod = await import('../index.js');
  assert.equal('Config' in mod, false);
  assert.equal(typeof mod.apply, 'function');
});

test('apply() with a minimal/unknown ctx never throws and returns a cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-idx-'));
  const cleanup = apply({ someUnknownCtx: true }, { enabled: true, dir, flushMs: 500 });
  assert.equal(typeof cleanup, 'function');
  cleanup();
});

test('apply() with enabled=false is a full no-op (data dir untouched)', () => {
  const cleanup = apply({}, { enabled: false, dir: 'C:/should-not-be-created' });
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.ok(!fs.existsSync('C:/should-not-be-created'));
});
