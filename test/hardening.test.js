// Regression tests for the capture/retrieval hardening:
//   1. durable user instructions are stored in full (they used to be sliced to 160 chars, which
//      discarded the very rule that made the record durable);
//   2. project paths written inside Markdown backticks / quotes resolve, so the `project:` tag
//      is actually written;
//   3. retrieval ignores stopword-only overlaps and weights terms by IDF over the pool;
//   4. standing project rules win a slot by SCOPE, bypassing the lexical pre-filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { retrieve } from '../lib/retrieve.js';
import { captureUserInstruction } from '../lib/capture.js';
import { projectFromText } from '../lib/policy.js';

function tmpStore(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-'));
  const store = openStore(dir, opts);
  store.ensureLayout();
  return { store, dir };
}

// --- 1. no truncation ---------------------------------------------------------------------
test('a durable rule stated late in the message survives into the stored summary', () => {
  const preamble = 'Please read the following carefully before you begin. '.repeat(6); // ~330 chars
  const rule = 'Always use `httpx` for HTTP calls; never use `requests`.';
  assert.ok(preamble.length > 160, 'precondition: the rule starts beyond the old 160-char cut');

  const rec = captureUserInstruction({
    instructionText: preamble + rule,
    durable: true,
    project: 'myproj',
  });

  assert.ok(rec.lesson.summary.includes('httpx'), 'the rule must be present in the stored summary');
  assert.ok(rec.lesson.summary.length > 200, 'summary must not be sliced to 160 chars');
  assert.equal(rec.lesson.trusted, true);
  assert.equal(rec.lesson.layer, 'L3');
});

// --- 2. project path parsing --------------------------------------------------------------
test('projectFromText resolves paths wrapped in backticks, quotes, or trailing punctuation', () => {
  assert.equal(projectFromText('work in `C:\\work\\myproj` now'), 'myproj');
  assert.equal(projectFromText('work in "C:\\work\\myproj".'), 'myproj');
  assert.equal(projectFromText('work in C:\\work\\myproj'), 'myproj');
  assert.equal(projectFromText('work in `/home/me/myproj`'), 'myproj');
  assert.equal(projectFromText('no path anywhere in this text'), null);
});

test('a backticked project path yields a project tag on the captured instruction', () => {
  const text = 'Rule: always use orjson. Applies to the project at `C:\\work\\myproj`.';
  const rec = captureUserInstruction({ instructionText: text, durable: true, project: projectFromText(text) });
  assert.ok(rec.lesson.tags.includes('project:myproj'));
});

// --- 3. stopwords + IDF -------------------------------------------------------------------
test('retrieve returns null when the only overlap is stopwords', () => {
  const lessons = [{ id: 'x', tags: [], summary: 'the for and with a of', layer: 'L2', trusted: true }];
  assert.equal(retrieve(lessons, 'the for and with a of', { topK: 4 }), null);
});

test('a rare topical term outweighs a term common across the pool', () => {
  const mk = (id, summary, updatedAt) => ({ id, tags: [], summary, layer: 'L3', trusted: true, updatedAt });
  const pool = [
    mk('g1', 'project convention about layout', 5),
    mk('g2', 'project convention about naming', 6),
    mk('g3', 'project convention about tests', 7),
    mk('topic', 'project convention: always use httpx for HTTP calls', 1),
  ];
  const out = retrieve(pool, 'project convention httpx', { topK: 1 });
  assert.match(out, /httpx/, 'the trunk term must win despite the other lessons being newer');
});

// --- 4. standing project rules ------------------------------------------------------------
test('a standing project rule is injected first even with zero lexical overlap', () => {
  const standing = {
    id: 'p', tags: ['user-instruction', 'L3', 'project:myproj'],
    summary: 'Use orjson; never the stdlib json module.', layer: 'L3', trusted: true, updatedAt: 1,
  };
  const newer = {
    id: 'o', tags: [], summary: 'Prefer f-strings', layer: 'L3', trusted: true, updatedAt: 99,
  };
  const out = retrieve([standing, newer], 'Add a serializer module', { topK: 3, project: 'myproj' });
  assert.match(out, /orjson/);
});

test('candidatesFor includes standing project rules regardless of lexical overlap', () => {
  const { store } = tmpStore();
  store.addLesson({
    domain: 'user-instruction/myproj',
    tags: ['user-instruction', 'L3', 'project:myproj'],
    summary: 'always use orjson',
    layer: 'L3', trusted: true,
  });
  store.addLesson({ domain: 'css', tags: ['css'], summary: 'flexbox gap', layer: 'L2', trusted: true });

  assert.equal(store.candidatesFor('completely unrelated query terms').length, 0);
  const withProject = store.candidatesFor('completely unrelated query terms', 40, 'myproj');
  assert.equal(withProject.length, 1);
  assert.match(withProject[0].summary, /orjson/);
});

test('store.search threads the project through to injection', () => {
  const { store } = tmpStore();
  store.addLesson({
    domain: 'user-instruction/myproj',
    tags: ['user-instruction', 'L3', 'project:myproj'],
    summary: 'always use orjson; never the stdlib json module',
    layer: 'L3', trusted: true,
  });

  assert.equal(store.search('add a serializer', { topK: 3 }), null, 'no project -> nothing to inject');
  const injected = store.search('add a serializer', { topK: 3, project: 'myproj' });
  assert.match(injected || '', /orjson/);
});
