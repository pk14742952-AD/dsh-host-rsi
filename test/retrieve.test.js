import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, estimateTokens } from '../lib/retrieve.js';

const lessons = [
  { id: 'a', tags: ['python', 'testing'], summary: 'use pytest fixtures for db', layer: 'L2', trusted: true, updatedAt: 1 },
  { id: 'b', tags: ['css'], summary: 'flexbox gap', layer: 'L2', trusted: true, updatedAt: 2 },
  { id: 'c', tags: ['python', 'testing'], summary: 'quarantined idea', layer: 'Q', trusted: false, updatedAt: 3 },
];

test('retrieve excludes quarantined by default', () => {
  const out = retrieve(lessons, 'python testing pytest', { topK: 5 });
  assert.match(out, /pytest fixtures/);
  assert.doesNotMatch(out, /quarantined idea/);
});

test('retrieve returns null when nothing is relevant', () => {
  assert.equal(retrieve([{ id: 'x', tags: ['css'], summary: 'flexbox', trusted: true }], 'quantum chromodynamics', { topK: 4 }), null);
});

test('includeQuarantined surfaces quarantined rows', () => {
  const out = retrieve(lessons, 'python testing', { topK: 5, includeQuarantined: true });
  assert.match(out, /quarantined idea/);
});

test('stronger layer ranks first on ties', () => {
  const l2 = [{ id: 'q', tags: ['x'], summary: 'shared term', layer: 'L2', trusted: true, updatedAt: 1 }];
  const l1 = [{ id: 'p', tags: ['x'], summary: 'shared term', layer: 'L1', trusted: true, updatedAt: 1 }];
  const out = retrieve([...l1, ...l2], 'x', { topK: 5 });
  assert.ok(out.indexOf('[L1]') < out.indexOf('[L2]'));
});

test('estimateTokens is a rough length/4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
});

test('CJK: space-free Chinese query matches a space-separated Chinese lesson', () => {
  const zh = [
    { id: 'z1', tags: ['python'], summary: '写一个 Python 下载脚本时用 httpx 不要用 requests', layer: 'L2', trusted: true, updatedAt: 1 },
    { id: 'z2', tags: ['css'], summary: 'flexbox gap', layer: 'L2', trusted: true, updatedAt: 2 },
  ];
  // Query has NO spaces between Chinese words; lesson summary uses spaces around latin.
  const out = retrieve(zh, '写python下载脚本用httpx', { topK: 5 });
  assert.ok(out && out.includes('httpx'), 'CJK unigram tokenize must let a space-free query hit a spaced lesson');
  assert.doesNotMatch(out, /flexbox/);
});
