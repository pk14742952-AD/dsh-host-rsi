import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';

function tmpStore(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-'));
  const store = openStore(dir, opts);
  store.ensureLayout();
  return { store, dir };
}

test('layout files/dirs are created', () => {
  const { store, dir } = tmpStore();
  for (const sub of ['lessons', 'quarantined', 'trajectories']) assert.ok(fs.existsSync(path.join(dir, sub)));
  assert.ok(fs.existsSync(path.join(dir, 'index.json')));
  void store;
});

test('addLesson mirrors to index + human md; trusted vs quarantined split', () => {
  const { store, dir } = tmpStore();
  const trusted = store.addLesson({ domain: 'python', tags: ['testing'], summary: 'use fixtures', layer: 'L2', trusted: true, weight: 0.8 });
  const quar = store.addLesson({ domain: 'css', tags: ['layout'], summary: 'maybe flex', layer: 'Q', trusted: false, weight: 0.3 });
  assert.equal(store.list().length, 2); // in-memory, immediate
  assert.equal(store.list().find((l) => l.id === quar.id).trusted, false);
  store.flushSync(); // backgrounded write -> now on disk
  assert.ok(fs.readFileSync(path.join(dir, 'lessons', 'python.md'), 'utf8').includes('use fixtures'));
  assert.ok(fs.readFileSync(path.join(dir, 'quarantined', 'css.md'), 'utf8').includes('maybe flex'));
  void trusted;
});

test('inverted index: candidatesFor returns only relevant lessons fast', () => {
  const { store } = tmpStore();
  store.addLesson({ domain: 'a', tags: ['python', 'testing'], summary: 'pytest', layer: 'L2', trusted: true });
  store.addLesson({ domain: 'b', tags: ['css'], summary: 'flexbox gap', layer: 'L2', trusted: true });
  const cands = store.candidatesFor('python pytest testing'); // in-memory, no flush needed
  assert.equal(cands.length, 1);
  assert.match(cands[0].summary, /pytest/);
});

test('findSimilar drives de-dup (high overlap) vs distinct (low overlap)', () => {
  const { store } = tmpStore();
  store.addLesson({ domain: 'python', tags: ['testing'], summary: 'use pytest fixtures for db isolation', trusted: true });
  const sim = store.findSimilar({ domain: 'python', tags: ['testing'], summary: 'pytest fixtures for db' });
  assert.ok(sim && sim.overlap > 0.5, `expected high overlap, got ${JSON.stringify(sim)}`);
  const diff = store.findSimilar({ domain: 'go', tags: ['concurrency'], summary: 'channel select deadlock' });
  assert.ok(!diff || diff.overlap < 0.5, `expected low overlap, got ${JSON.stringify(diff)}`);
});

test('hasDuplicate: same-project near-duplicate instructions are rejected', () => {
  const { store } = tmpStore();
  const first = store.addLesson({
    domain: 'user-instruction/dsh-host-rsi',
    tags: ['user-instruction', 'L3', 'project:dsh-host-rsi'],
    summary: 'User instruction: always use httpx for HTTP requests',
    fix: 'always use httpx for HTTP requests',
    layer: 'L3',
    trusted: true,
  });
  assert.equal(store.hasDuplicate({
    domain: 'user-instruction/dsh-host-rsi',
    tags: ['user-instruction', 'L3', 'project:dsh-host-rsi'],
    summary: 'User instruction: always use httpx for HTTP requests',
    fix: 'always use httpx for HTTP requests',
  }, 0.85), true, 'identical text should be a duplicate');
  assert.equal(store.hasDuplicate({
    domain: 'user-instruction/dsh-host-rsi',
    tags: ['user-instruction', 'L3', 'project:dsh-host-rsi'],
    summary: 'User instruction: please always use httpx for HTTP requests',
    fix: 'please always use httpx for HTTP requests',
  }, 0.85), true, 'near-identical same-project text should be a duplicate');
  void first;
});

test('hasDuplicate: different projects are NOT duplicates even for similar text', () => {
  const { store } = tmpStore();
  store.addLesson({
    domain: 'user-instruction/dsh-host-rsi',
    tags: ['user-instruction', 'L3', 'project:dsh-host-rsi'],
    summary: 'User instruction: always use httpx for HTTP requests',
    fix: 'always use httpx for HTTP requests',
    layer: 'L3',
    trusted: true,
  });
  assert.equal(store.hasDuplicate({
    domain: 'user-instruction/other-project',
    tags: ['user-instruction', 'L3', 'project:other-project'],
    summary: 'User instruction: always use httpx for HTTP requests',
    fix: 'always use httpx for HTTP requests',
  }, 0.85), false, 'different project should not collide');
});

test('promote flips quarantined -> trusted and logs it', () => {
  const { store, dir } = tmpStore();
  const q = store.addLesson({ domain: 'js', tags: ['promises'], summary: 'maybe await', layer: 'Q', trusted: false });
  store.promote(q.id, { note: 'confirmed by user tap' });
  const row = store.list().find((l) => l.id === q.id);
  assert.equal(row.trusted, true);
  assert.equal(row.layer, 'L2');
  store.flushSync();
  assert.ok(fs.readFileSync(path.join(dir, 'lessons', 'js.md'), 'utf8').includes('PROMOTE'));
});

test('search() = fast candidate pre-filter + retrieve ranking, budget-capped', () => {
  const { store } = tmpStore();
  for (let i = 0; i < 20; i += 1) {
    store.addLesson({ domain: 'db', tags: ['sql'], summary: `join query ${i} to avoid nulls`, trusted: true });
  }
  const out = store.search('sql join null', { topK: 5, tokenBudget: 200 });
  assert.ok(out);
  assert.match(out, /join query/);
  assert.ok(out.split('\n').length <= 6);
});

// --- optimization-pass tests ---

test('in-memory: a lesson is retrievable immediately WITHOUT a disk flush', () => {
  const { store, dir } = tmpStore({ flushMs: 100000 }); // debounce far away
  store.addLesson({ domain: 'python', tags: ['testing'], summary: 'immediate cache hit', trusted: true });
  // retrievable from cache right away
  assert.equal(store.list().length, 1);
  assert.match(store.search('python immediate cache'), /immediate cache hit/);
  // ...but nothing persisted yet (backgrounded)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).length, 0);
  store.close();
});

test('graceful disable: unwritable dir -> in-memory-only, addLesson still works, no throw', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-'));
  const asFile = path.join(base, 'a-file');
  fs.writeFileSync(asFile, 'x', 'utf8');
  const store = openStore(path.join(asFile, 'sub'), { flushMs: 100000 }); // parent is a file -> mkdir throws
  store.ensureLayout();
  assert.equal(store.disabled, true);
  const l = store.addLesson({ domain: 'x', summary: 'still remembered in memory', trusted: true });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, l.id);
  assert.equal(store.flushSync(), false); // no persistence happened
  store.close();
});

test('batched flush coalesces many writes into one disk pass', () => {
  const { store, dir } = tmpStore({ flushMs: 100000 });
  store.addLesson({ domain: 'd', tags: ['k'], summary: 'one', trusted: true });
  store.addLesson({ domain: 'd', tags: ['k'], summary: 'two', trusted: true });
  store.addLesson({ domain: 'd', tags: ['k'], summary: 'three', trusted: true });
  const idxBefore = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idxBefore.length, 0); // not written yet
  assert.equal(store.flushSync(), true);
  const idxAfter = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idxAfter.length, 3);
  store.close();
});

test('flush retry: an unwritable trajectory batch does not drop queued mirror appends', () => {
  const { store, dir } = tmpStore({ flushMs: 100000 });
  store.addLesson({ domain: 'd', tags: ['k'], summary: 'mirror must survive a failing traj', trusted: true });
  store.addTrajectory({ ts: 1, task: 't', domain: 'd', lesson: 'raw trace' });
  // Break ONLY the trajectories dir after layout creation (ensureLayout already ran with
  // a healthy layout): replace it with a file so every trajectory append throws while
  // index.json + lessons/ stay writable.
  fs.rmSync(path.join(dir, 'trajectories'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'trajectories'), 'x', 'utf8');
  store.flushSync(); // index+mirror ok, trajectory append throws
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.length, 1, 'index row persisted despite trajectory failure');
  assert.ok(
    fs.readFileSync(path.join(dir, 'lessons', 'd.md'), 'utf8').includes('mirror must survive a failing traj'),
    'mirror append persisted despite trajectory failure',
  );
  store.close();
});
