// Regression tests for the user-instruction source gate (#1):
//   - non-user DSH sources (system/plugin-injected) never become lessons;
//   - host/system boilerplate is blocked even when the source kind says user;
//   - genuine user messages are captured together with their sourceKind;
//   - inject.selfCheck=false removes the mandatory [VERIFY] trailer (#3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { isSystemLikeText, isDurableUserInstruction } from '../lib/policy.js';

function harness() {
  const eventHandlers = {};
  const toolRuns = {};
  const ctx = {
    events: {},
    on(name, cb) {
      eventHandlers[name] = cb;
      return () => {};
    },
    inject() {
      return () => {};
    },
    tools: {
      register(opts) {
        toolRuns[opts.name] = opts.run;
        return () => {};
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-src-'));
  const cleanup = apply(ctx, {
    enabled: true,
    dir,
    dashboard: { enabled: false, webserver: false },
    capture: { enabled: true, maxPerSession: 20, minChars: 120, dedupeThreshold: 0.8, captureUserCorrections: true, captureUserInstructions: true },
    escalate: { enabled: true, maxCriticsPerSession: 3, selfConsistency: 1, threshold: 0.6 },
  });
  return { eventHandlers, toolRuns, cleanup };
}

test('isSystemLikeText catches host banners and injected self-check blocks', () => {
  assert.equal(isSystemLikeText('Your project directory is C:\\work. Use it as your working directory for every file operation.'), true);
  assert.equal(isSystemLikeText('[rsi-selfcheck] For any non-trivial answer...'), true);
  assert.equal(isSystemLikeText('Relevant trusted lessons from prior use (most useful first):'), true);
  assert.equal(isSystemLikeText('以后都用 httpx，不要用 requests'), false);
});

test('non-user source and host boilerplate are blocked; genuine user input is captured with sourceKind', async () => {
  const { eventHandlers, toolRuns, cleanup } = harness();
  const diag = () => toolRuns.rsi_events({});
  const list = () => toolRuns.rsi_records({ limit: 20 });

  // System-origin instruction (e.g. another plugin injecting text into a user-role message).
  eventHandlers.message({
    role: 'user',
    sessionId: 's1',
    content: 'Always use httpx for HTTP calls; never use requests.',
    source: { kind: 'system' },
  });
  assert.equal((await diag()).blockedNoise, 1, 'non-user source should be blocked');
  assert.equal((await list()).length, 0, 'no lesson may be captured from a non-user source');

  // Host runtime banner arriving as a genuine user source.
  eventHandlers.message({
    role: 'user',
    sessionId: 's1',
    content: 'Your project directory is C:\\work\\demo. Use it as your working directory for every file operation.',
    source: { kind: 'user' },
  });
  assert.equal((await diag()).blockedNoise, 2, 'host boilerplate should be blocked even with user source');
  assert.equal((await list()).length, 0, 'host boilerplate must not become a lesson');

  // Real user rule -> captured, trusted, and tagged with sourceKind.
  eventHandlers.message({
    role: 'user',
    sessionId: 's1',
    content: '以后都用 httpx，不要用 requests',
    source: { kind: 'user' },
  });
  const recs = await list();
  const instruction = Array.isArray(recs) ? recs.find((r) => r.domain === 'user-instruction') : null;
  assert.ok(instruction, 'genuine user instruction should be recorded');
  assert.equal(instruction.trusted, true);
  assert.equal(instruction.layer, 'L3');
  assert.equal(instruction.sourceKind, 'user');

  cleanup();
});

test('long one-off tasks are no longer misclassified as durable standing rules', () => {
  const longTask = 'please write a python downloader that handles retries and saves files to a folder with progress bars';
  assert.ok(longTask.length >= 20, 'precondition: well over the old length threshold');
  assert.equal(isDurableUserInstruction({ instructionText: longTask }), false);
  assert.equal(isDurableUserInstruction({ instructionText: '请记住以后都用 httpx' }), true);
});

test('selfCheck=false removes the [VERIFY] trailer; the default keeps injecting it', () => {
  const mkCtx = (sections) => {
    const eventHandlers = {};
    return {
      events: {},
      on(name, cb) {
        eventHandlers[name] = cb;
        return () => {};
      },
      inject() {
        return () => {};
      },
      get(name) {
        if (name === 'systemPrompt') {
          return {
            section(s) {
              sections.push(s);
              return () => {};
            },
          };
        }
        return undefined;
      },
      tools: { register: () => () => {} },
      eventHandlers,
    };
  };

  const offSections = [];
  const offCtx = mkCtx(offSections);
  const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-sc-off-'));
  const closeOff = apply(offCtx, {
    enabled: true,
    dir: offDir,
    dashboard: { enabled: false, webserver: false },
    inject: { enabled: true, selfCheck: false },
  });
  offCtx.eventHandlers['agent/pre-step']({ task: 'write a parser' });
  assert.equal(
    offSections.some((s) => s.name === 'rsi-selfcheck' && /\[VERIFY:/.test(s.text)),
    false,
    'selfCheck=false must not inject the VERIFY trailer (the convergence policy section may still be present)'
  );
  closeOff();

  const onSections = [];
  const onCtx = mkCtx(onSections);
  const onDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-sc-on-'));
  const closeOn = apply(onCtx, {
    enabled: true,
    dir: onDir,
    dashboard: { enabled: false, webserver: false },
  });
  onCtx.eventHandlers['agent/pre-step']({ task: 'write a parser' });
  assert.ok(onSections.some((s) => s.name === 'rsi-selfcheck' && /\[VERIFY:/.test(s.text)), 'default selfCheck=true injects the self-check block');
  closeOn();
});
