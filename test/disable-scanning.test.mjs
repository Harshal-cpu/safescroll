import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('master switch disconnects page scanning and reconnects it when enabled', async () => {
  const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '');
  const events = {};
  const settings = { enabled: false, scope: 'all', pausedHosts: [] };
  const counts = { units: 0, observe: 0, disconnect: 0, intersections: 0, registered: 0 };
  const body = { isConnected: true };
  const document = {
    readyState: 'loading', body, documentElement: body,
    addEventListener: (name, listener) => { events[name] = listener; },
    querySelectorAll: () => [], getElementById: () => null
  };
  const window = { innerHeight: 800, addEventListener() {} };
  const chrome = {
    storage: {
      sync: { get: async () => ({ ...settings }) },
      onChanged: { addListener: listener => { events.storageChanged = listener; } }
    },
    runtime: { onMessage: { addListener() {} } }
  };
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; events.intersection = callback; }
    observe() { counts.intersections++; }
    unobserve() {}
    disconnect() { counts.disconnect++; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; events.mutation = callback; }
    observe() { counts.observe++; }
    disconnect() { counts.disconnect++; }
  }
  const deps = {
    pickAdapter: () => ({
      siteId: 'generic', key: () => 'same', units: () => { counts.units++; return []; }
    }),
    PROFILES: { image: { enabled: true }, ocr: { enabled: true }, lexicon: { enabled: true } },
    createAnimatedMediaScanner: () => ({ observeRoot() {}, reset() {}, stop() {}, onVerdict() {} }),
    sendRuntimeMessage() {}, createBlurShield() {},
    keyFor: () => null, get: () => null, cachedVerdict: () => null,
    createShield: () => null, setIdentity() {},
    register: () => { counts.registered++; return null; },
    isHostPaused: () => false,
    onExtensionContextInvalidated() {},
    showLoadingBanner() {}, hideLoadingBanner() {}, waitForModels: async () => true,
    clearAll() {}, prune() {}, isScrollLocked: () => false
  };
  const create = new Function('deps', 'document', 'window', 'chrome', 'location',
    'IntersectionObserver', 'MutationObserver',
    `const { ${Object.keys(deps).join(', ')} } = deps;\n${source}\nreturn { stopContentScript, registerUnit };`);
  const app = create(deps, document, window, chrome, { hostname: 'example.com' },
    IntersectionObserver, MutationObserver);

  events.DOMContentLoaded();
  await Promise.resolve();
  assert.equal(counts.observe, 0, 'saved off state must not attach a page observer');

  settings.enabled = true;
  events.storageChanged({ enabled: { newValue: true } }, 'sync');
  assert.equal(counts.observe, 1);
  assert.equal(counts.units, 1);

  settings.enabled = false;
  events.storageChanged({ enabled: { newValue: false } }, 'sync');
  assert.equal(counts.disconnect, 2, 'both page observers must disconnect');
  events.mutation([{ type: 'childList', target: body, addedNodes: [body], removedNodes: [] }]);
  events.intersection([{ target: body, isIntersecting: true }]);
  assert.equal(counts.units, 1, 'late observer callbacks must not scan the page');

  settings.enabled = true;
  events.storageChanged({ enabled: { newValue: true } }, 'sync');
  assert.equal(counts.observe, 2);
  assert.equal(counts.units, 2);
  app.registerUnit({ el: { dataset: { safescrollKey: 'same' } }, text: '', images: [] });
  assert.equal(counts.registered, 1, 'a prior key marker must not skip registration after re-enable');
  app.stopContentScript();
});

test('background rejects classification requests while protection is off', async () => {
  const source = readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '')
    .replace('export async function ensureOffscreen', 'async function ensureOffscreen');
  let onMessage;
  let offscreenCreates = 0;
  const chrome = {
    runtime: {
      onMessage: { addListener: listener => { onMessage = listener; } },
      onSuspend: { addListener() {} }, onInstalled: { addListener() {} }
    },
    storage: {
      sync: { get: async () => ({ enabled: false }) },
      onChanged: { addListener() {} }
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    offscreen: { createDocument: async () => { offscreenCreates++; } }
  };
  const MSG = { CLASSIFY: 'classify', CLASSIFY_MEDIA: 'classify-media', CLASSIFY_ANIMATED: 'classify-animated' };
  new Function('chrome', 'MSG', 'OFFSCREEN_ROUTED', 'RELAY_MARK', 'MODERATION_DEFAULTS',
    'normalizeModerationSettings', source)(chrome, MSG, new Set(Object.values(MSG)),
    '__ssRelay', {}, value => value);
  for (const type of Object.values(MSG)) {
    const response = await new Promise(resolve => {
      assert.equal(onMessage({ type }, {}, resolve), true);
    });
    assert.equal(response.error, 'protection-disabled');
  }
  assert.equal(offscreenCreates, 0);
});

test('an in-flight text result is discarded after protection turns off', async () => {
  const source = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function handleClassify(msg) {'),
    source.indexOf('// ---------------------------------------------------------------- media log'));
  let releaseInference;
  let inferenceStarted;
  let persisted = 0;
  const started = new Promise(resolve => { inferenceStarted = resolve; });
  const deps = {
    runtimeSettingsReady: Promise.resolve(), settingsPolicy: () => 'policy',
    startLoading() {}, getVerdict: async () => null, CACHEABLE: new Set(),
    runtime: { lexiconEnabled: false }, postProgress() {}, verdictLog() {},
    classifyText: () => {
      inferenceStarted();
      return new Promise(resolve => { releaseInference = resolve; });
    },
    persistVerdict: async () => { persisted++; }
  };
  const app = new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps;
    let protectionEnabled = true;
    let protectionGeneration = 1;
    ${body}
    return { handleClassify, disable() { protectionEnabled = false; protectionGeneration++; } };`)(deps);
  const result = app.handleClassify({ key: 'post-1', text: 'sample text' });
  await started;
  app.disable();
  releaseInference({ action: 'block', source: 'text' });
  await result;
  assert.equal(persisted, 0);
});
