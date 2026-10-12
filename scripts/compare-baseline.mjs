// DSH host RSI — before/after comparison harness (对照测试).
//
// Usage:  node scripts/compare-baseline.mjs <libDir> [<libDir> ...]
//
// Each <libDir> is a directory that contains lib/*.js (a git baseline, the working
// tree, or the installed profile's node_modules/dsh-host-rsi/lib). The same battery
// of scenarios is run against every libDir and a markdown comparison table is
// printed, so "before" and "after" behaviors can be read side by side.
//
// Scenarios are defensive: a throwing scenario records its error message rather than
// aborting (e.g. the old outcomeSignal TypeError is itself a measured difference).
//
// Pure ESM, no DSH dependencies — every lib module under test is importable by path.

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

async function loadLib(libDir) {
  const dir = resolve(libDir);
  if (!existsSync(join(dir, 'policy.js')) && !existsSync(join(dir, 'lib', 'policy.js'))) {
    throw new Error(`no lib found under ${libDir}`);
  }
  const base = existsSync(join(dir, 'policy.js')) ? dir : join(dir, 'lib');
  const mod = {};
  for (const name of ['policy', 'store', 'retrieve', 'convergence', 'guard', 'signal', 'scorers', 'util']) {
    const file = join(base, `${name}.js`);
    if (!existsSync(file)) continue;
    try {
      mod[name] = await import(pathToFileURL(file).href);
    } catch (e) {
      mod[name] = { __loadError: String(e && e.message || e) };
    }
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Scenario battery. Each scenario: { name, run(api) => value|throws }
// Values are normalized to short strings by the harness.
// ---------------------------------------------------------------------------

const scenarios = [
  {
    name: 'F1 isSystemLikeText gate: <goal_round> boilerplate',
    run: (a) => a.policy.isSystemLikeText('<goal_round> Objective: "x" Round: 1/256 Continue working…'),
  },
  {
    name: 'F1 isUserCorrection: neutral 22-char sentence',
    run: (a) => a.policy.isUserCorrection('please use the other approach next time'),
  },
  {
    name: 'F6 outcomeSignal: toolResults missing (must not throw)',
    run: (a) => a.policy.outcomeSignal ? JSON.stringify(a.policy.outcomeSignal({})) : 'no export',
  },
  {
    name: 'F2 hasDuplicate: identical text across correction/instruction kinds',
    run: (a) => {
      const { openStore } = a.store;
      const dir = mkdtempSync(join(os.tmpdir(), 'rsi-cmp-'));
      try {
        const s = openStore(dir, { flushMs: 100000 });
        s.ensureLayout();
        s.addLesson({
          domain: 'user-instruction/d', tags: ['user-instruction', 'L3'],
          summary: 'User instruction: 创建一个完整独立HTML文件，禁止使用子代理',
          fix: '创建一个完整独立HTML文件，禁止使用子代理', layer: 'L3', trusted: true,
        });
        const dup = s.hasDuplicate({
          domain: 'user-correction/d', tags: ['user-correction', 'L3'],
          summary: 'User correction: 创建一个完整独立HTML文件，禁止使用子代理',
          fix: '创建一个完整独立HTML文件，禁止使用子代理',
        }, 0.85);
        const crossProject = s.hasDuplicate({
          domain: 'user-correction/other', tags: ['user-correction', 'L3'],
          summary: 'User correction: 创建一个完整独立HTML文件，禁止使用子代理',
          fix: '创建一个完整独立HTML文件，禁止使用子代理',
        }, 0.85);
        return JSON.stringify({ sameProjectCrossKind: dup, crossProject: crossProject });
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    },
  },
  {
    name: 'F5 corrupt index.json self-heal (disabled stays false)',
    run: (a) => {
      const { openStore } = a.store;
      const dir = mkdtempSync(join(os.tmpdir(), 'rsi-cmp-'));
      try {
        writeFileSync(join(dir, 'index.json'), 'not json {{{', 'utf8');
        const s = openStore(dir, { flushMs: 100000 });
        s.ensureLayout();
        const disabled = s.disabled;
        const healed = existsSync(join(dir, 'index.json'));
        s.addLesson({ domain: 'x', summary: 'after heal', trusted: true });
        const ok = s.flushSync();
        return JSON.stringify({ disabled, indexExists: healed, flushAfter: ok });
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    },
  },
  {
    name: 'F4 looksPassed: "3 passed; 0 failed" (test family)',
    run: (a) => a.convergence.looksPassed('3 passed; 0 failed; 0 ignored', 'test'),
  },
  {
    name: 'F4 looksPassed: "BUILD FAILED in 2.1s" (build family)',
    run: (a) => a.convergence.looksPassed('BUILD FAILED in 2.1s', 'build'),
  },
  {
    name: 'F7 estimateTokens: 20 CJK chars (old ~5, CJK-aware ~14)',
    run: (a) => a.retrieve.estimateTokens('中文内容测试一二三四五六七八九十二十'),
  },
  {
    name: 'F7 fix injection + F3 task-echo filter (end-to-end via retrieve())',
    run: (a) => {
      // Echo row: body "please check the rsi project repository" (≥4 tokens, 100% covered by
      // the task) -> must be DROPPED in the fixed code. Fix row: relevant L2 lesson with a
      // distinct fix -> fix must be injected in the fixed code.
      const rows = [
        { id: 'a', domain: 'd', layer: 'L2', trusted: true, summary: 'lesson text', fix: 'the fix detail', tags: ['k'], ts: 1 },
        { id: 'b', domain: 'd', layer: 'L3', trusted: true, summary: 'User instruction: please check the rsi project repository', fix: '', tags: ['rsi'], ts: 2 },
        { id: 'c', domain: 'd', layer: 'L2', trusted: true, summary: 'check the rsi project use the harness', fix: 'run compare-baseline.mjs first', tags: ['rsi', 'harness'], ts: 3 },
      ];
      const task = 'please check the rsi project repository';
      const out = a.retrieve.retrieve(rows, task, { project: 'x', tokenBudget: 2000, topK: 4 });
      if (!out) return 'null';
      const hasEcho = out.includes('please check the rsi project repository');
      const hasFix = out.includes('run compare-baseline.mjs first');
      return JSON.stringify({ echoDropped: !hasEcho, fixInjected: hasFix, lines: out.split('\n').slice(1, 4) });
    },
  },
  {
    name: 'SHELL_LOOP: three DIFFERENT pwsh commands, no text',
    run: (a) => a.guard.classifyLoop({
      thresholdEmpty: 400, thresholdFile: 2000, sameToolStreak: 3,
      answerText: '', toolCalls: [
        { name: 'pwsh', command: 'npm test' },
        { name: 'pwsh', command: 'git status' },
        { name: 'pwsh', command: 'ls -la' },
      ],
    }).state,
  },
  {
    name: 'SHELL_LOOP: same pwsh command x3, no text (must still catch)',
    run: (a) => a.guard.classifyLoop({
      thresholdEmpty: 400, thresholdFile: 2000, sameToolStreak: 3,
      answerText: '', toolCalls: [
        { name: 'pwsh', command: 'npm test' },
        { name: 'pwsh', command: 'npm test' },
        { name: 'pwsh', command: 'npm test' },
      ],
    }).state,
  },
  {
    name: 'signal: userTap REFUTED -> trusted?',
    run: (a) => {
      const c = a.signal.classifySignal({ verdict: 'CONFIRMED', userTap: { verdict: 'REFUTED' } });
      return JSON.stringify({ layer: c.layer, trusted: c.trusted, note: c.note });
    },
  },
  {
    name: 'scorers: bare node with ok:true -> definitive?',
    run: (a) => {
      const r = a.scorers.runScorers({ toolResults: [{ name: 'node', ok: true }] });
      return JSON.stringify({ definitive: r.definitive, via: r.via || null, passed: r.passed });
    },
  },
  {
    name: 'scorers: ok:false pytest -> passed?',
    run: (a) => {
      const r = a.scorers.runScorers({ toolResults: [{ name: 'pytest', ok: false }] });
      return JSON.stringify({ definitive: r.definitive, via: r.via || null, passed: r.passed });
    },
  },
  {
    name: 'guard: 20k-char rejected answer excerpt is bounded',
    run: (a) => {
      if (!a.guard.guardCorrectionPrompt) return 'no export (old baseline)';
      const out = a.guard.guardCorrectionPrompt('x'.repeat(20000), 'the task');
      return `len=${out.length}`;
    },
  },
];

// ---------------------------------------------------------------------------

function norm(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

async function runBattery(api) {
  const out = [];
  for (const s of scenarios) {
    try {
      out.push(norm(await s.run(api)));
    } catch (e) {
      out.push(`THROW: ${String(e && e.message || e).slice(0, 80)}`);
    }
  }
  return out;
}

const libDirs = process.argv.slice(2);
if (libDirs.length < 1) {
  console.error('usage: node scripts/compare-baseline.mjs <libDir> [<libDir> ...]');
  process.exit(2);
}

const apis = [];
for (const d of libDirs) {
  try { apis.push({ dir: d, api: await loadLib(d) }); }
  catch (e) { apis.push({ dir: d, api: { __loadError: String(e.message) } }); }
}

const results = [];
for (const a of apis) {
  if (a.api.__loadError) {
    results.push({ dir: a.dir, cells: scenarios.map(() => `LOAD ERR: ${a.api.__loadError}`) });
  } else {
    results.push({ dir: a.dir, cells: await runBattery(a.api) });
  }
}

// markdown table
const header = ['#', ...results.map((r, i) => `${i + 1} ${basename(r.dir)}`)];
const rows = scenarios.map((s, i) => [s.name, ...results.map((r) => r.cells[i])]);
const w = (s, n) => String(s).padEnd(n);
const widths = [0, ...results.map((r) => basename(r.dir).length + 2)];
for (const row of rows) widths[0] = Math.max(widths[0], row[0].length);
console.log('| ' + header.map((h, i) => w(h, widths[i])).join(' | ') + ' |');
console.log('|' + widths.map((x) => '-'.repeat(x + 2)).join('|') + '|');
for (const row of rows) {
  console.log('| ' + row.map((c, i) => w(c, widths[i])).join(' | ') + ' |');
}

function basename(p) {
  const clean = String(p).replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  let name = parts[parts.length - 1] || clean;
  if (name === 'lib' || name === 'node_modules' || name === 'dsh-host-rsi') {
    name = parts[parts.length - 2] || name;
  }
  return name.length > 24 ? name.slice(0, 22) + '…' : name;
}

// machine-readable JSON for a caller that wants to diff
if (process.env.COMPARE_JSON) {
  console.log('\n' + JSON.stringify({
    scenarios: scenarios.map((s) => s.name),
    results: results.map((r) => ({ dir: r.dir, cells: r.cells })),
  }, null, 2));
}
