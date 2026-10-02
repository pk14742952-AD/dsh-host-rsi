// DSH host RSI — client half (the Settings "RSI 记忆" tab). Proves client.js calls
// window.__ModuleLoader__.load, registers a settings.plugins.tab entry id="rsi", and the
// tab component renders against window.__RSI__ without throwing.
// node --test test/client.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

test('client registers a settings.section "rsi" entry + component renders against __RSI__', async () => {
  const pkg = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../package.json', import.meta.url), 'utf8')));
  let capturedSpec = null;
  globalThis.window = globalThis; // client.js is a browser IIFE
  globalThis.__ModuleLoader__ = { load: (spec) => { capturedSpec = spec; } };
  await import('../client.js');

  assert.ok(capturedSpec, 'client.js called window.__ModuleLoader__.load');
  assert.equal(capturedSpec.id, pkg.name);
  assert.equal(typeof capturedSpec.factory, 'function');

  // The factory builds the module with a require() that the DSH client loader provides.
  const mockReact = {
    createElement() { return { mock: true }; },
    useState(v) { return [v, () => {}]; },
    useEffect() {},
  };
  const mod = capturedSpec.factory((name) => (name === 'react' ? mockReact : {}));
  assert.deepEqual(mod.inject, ['slots', 'locale']);

  // Capture the settings.section registration.
  let injectedName = null;
  let registeredOpts = null;
  let registeredComp = null;
  const ctx = {
    locale: {
      bind: () => (k) => k,
      register: () => {},
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (name, cb) => { injectedName = name; cb(); },
      register: (opts, comp) => { registeredOpts = opts; registeredComp = comp; return () => {}; },
      entries: () => [],
      getVersion: () => 0,
      subscribe: () => () => {},
    },
    effect: (fn) => { if (typeof fn === 'function') fn(); },
  };
  mod.apply(ctx);

  assert.equal(injectedName, 'settings.section', 'the tab is injected into the settings section');
  assert.ok(registeredOpts, 'a tab row was registered');
  assert.equal(registeredOpts.id, 'rsi');
  assert.equal(registeredOpts.name, 'settings.section');
  assert.equal(typeof registeredOpts.label, 'function');
  assert.equal(typeof registeredOpts.label(), 'string', 'label resolves to a locale string');

  // The tab component renders against window.__RSI__ (host-injected) without throwing.
  globalThis.__RSI__ = {
    url: 'http://127.0.0.1:8788',
    basePath: '/rsi/',
    status: {
      enabled: true,
      degraded: false,
      totals: { lessons: 3, trusted: 2, quarantined: 1, trajectories: 1 },
      recent: [{ at: 1, domain: 'code', layer: 'L1', summary: '可信教训', trusted: true }],
    },
  };
  const rendered = registeredComp(); // mock React -> {mock:true}
  assert.ok(rendered, 'the RSI 记忆 tab component renders');
  delete globalThis.__RSI__;
});
