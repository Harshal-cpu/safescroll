import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MSG, OFFSCREEN_ROUTED, RELAY_MARK } from '../src/shared/messages.js';
import { MODERATION_DEFAULTS, normalizeModerationSettings } from '../src/shared/moderationSettings.js';

const backgroundSource = readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace('export async function ensureOffscreen', 'async function ensureOffscreen');
function background(storageRead) {
  let listener, changed;
  const broadcasts = [];
  const context = {
    MSG, OFFSCREEN_ROUTED, RELAY_MARK, MODERATION_DEFAULTS, normalizeModerationSettings,
    console, setTimeout, clearTimeout,
    chrome: {
      runtime: {
        onMessage: { addListener: callback => { listener = callback; } },
        onInstalled: { addListener() {} }, onSuspend: { addListener() {} },
        sendMessage: async message => { broadcasts.push(message); }
      },
      storage: { sync: { get: storageRead }, onChanged: { addListener: callback => { changed = callback; } } },
      alarms: { create() {}, onAlarm: { addListener() {} } }
    }
  };
  runInNewContext(backgroundSource, context);
  return { broadcasts, changed: (...args) => changed(...args),
    read: () => new Promise(resolve => listener({ type: MSG.GET_RUNTIME_SETTINGS }, {}, resolve)) };
}

test('background returns stored moderation settings and relays live updates', async () => {
  const preferences = { ocrEnabled: false, imageEnabled: true, lexiconEnabled: false };
  const env = background(async () => ({ ...preferences }));
  assert.deepEqual((await env.read()).settings, preferences);
  env.changed({ ocrEnabled: { newValue: false } }, 'sync');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.broadcasts.length, 1);
  assert.equal(env.broadcasts[0].type, MSG.RUNTIME_SETTINGS_CHANGED);
  assert.equal(env.broadcasts[0][RELAY_MARK], 1);
  assert.deepEqual(env.broadcasts[0].settings, preferences);
});

test('out-of-order settings reads cannot broadcast an older configuration', async () => {
  const reads = [];
  const env = background(() => new Promise(resolve => reads.push(resolve)));
  env.changed({ ocrEnabled: { newValue: false } }, 'sync');
  env.changed({ imageEnabled: { newValue: false } }, 'sync');
  reads[1]({ ocrEnabled: false, imageEnabled: false, lexiconEnabled: true });
  reads[0](MODERATION_DEFAULTS);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(env.broadcasts.length, 1);
  assert.equal(env.broadcasts[0].settings.imageEnabled, false);
});

const offscreenSource = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
const settingsSource = offscreenSource.slice(offscreenSource.indexOf('const runtime ='), offscreenSource.indexOf('// ---------------------------------------------------------------- message router'));
function offscreen(sendMessage) {
  return runInNewContext(`(() => { ${settingsSource}; return {
    runtime, syncRuntimeSettings, update(settings) { settingsChangeVersion++; applyRuntimeSettings(settings); }
  }; })()`, { MODERATION_DEFAULTS, MSG, Promise, chrome: { runtime: { sendMessage } },
    log() {}, cancelQueuedOcr() {} });
}

test('offscreen settings initialize with runtime messaging and no storage API', async () => {
  const settings = { ocrEnabled: false, imageEnabled: false, lexiconEnabled: true };
  const env = offscreen(async message => {
    assert.equal(message.type, MSG.GET_RUNTIME_SETTINGS);
    return { settings };
  });
  await env.syncRuntimeSettings();
  assert.equal(env.runtime.ocrEnabled, false);
  assert.equal(env.runtime.imageEnabled, false);
});

test('a live offscreen settings update cannot be overwritten by an older startup reply', async () => {
  let reply;
  const env = offscreen(() => new Promise(resolve => { reply = resolve; }));
  const startup = env.syncRuntimeSettings();
  env.update({ ocrEnabled: false, imageEnabled: false, lexiconEnabled: true });
  reply({ settings: MODERATION_DEFAULTS });
  await startup;
  assert.equal(env.runtime.ocrEnabled, false);
  assert.equal(env.runtime.imageEnabled, false);
});
