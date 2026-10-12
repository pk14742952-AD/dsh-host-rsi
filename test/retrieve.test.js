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

test('estimateTokens: CJK text is token-heavier than raw character count/4', () => {
  // 16 CJK chars ≈ ceil(16/1.5)=11 tokens (old flat len/4 gave 4); latin still ~1/4.
  assert.equal(estimateTokens('中文内容测试一二三四五六七八九十'), 11);
  assert.equal(estimateTokens('hello world'), 3);
});

test('retrieve injects fix for non-L1 lessons when the fix is not redundant', () => {
  const rows = [
    { id: 'l2fix', tags: ['python'], summary: 'NInfer 的 kv-dtype k8v4 会导致 2-token 静默崩溃', fix: '始终加 -ctk r8kv4 -ctv r8kv4', layer: 'L2', trusted: true, updatedAt: 2 },
  ];
  const out = retrieve(rows, 'k8v4 崩溃', { topK: 5 });
  assert.ok(out && out.includes('NInfer'), 'lesson body still injected');
  assert.ok(out.includes('始终加 -ctk'), 'non-L1 fix is now included (was dropped before)');
});

test('retrieve: a lesson that merely echoes the task is filtered out', () => {
  const task = '检查完本地的dsh host rsi 项目，1 看看有没有需要优化的 2 用户反应安装以后在e盘生成文件夹，能否跟其它插件一样';
  const rows = [
    { id: 'echo', tags: ['rsi'], summary: `User correction: ${task}`, layer: 'L3', trusted: true, updatedAt: 2, project: 'dsh-host-rsi' },
    { id: 'real', tags: ['rsi'], summary: 'User instruction: 迁移逻辑只读不创建旧目录，重启桌面端自动搬走', layer: 'L3', trusted: true, updatedAt: 3, project: 'dsh-host-rsi' },
  ];
  const out = retrieve(rows, task, { topK: 5 });
  assert.ok(out && out.includes('迁移逻辑'), 'real lesson still injected');
  assert.doesNotMatch(out, /检查完本地的dsh/, 'task echo must not be re-injected');
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
