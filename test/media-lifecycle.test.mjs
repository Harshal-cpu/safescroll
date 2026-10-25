import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { mediaFingerprint } from '../src/shared/mediaFingerprint.js';
import { MSG } from '../src/shared/messages.js';
import { refineVerdict, reconcileMediaVerdict } from '../src/offscreen/refineVerdict.js';

// The offscreen module boots Chrome listeners and large ML models on import.
// Execute its actual media handler with those boundaries mocked so these tests
// can assert ordering of persistence, notification, retries, and stale results.
const source = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
const start = source.indexOf('async function handleClassifyMedia(');
const end = source.indexOf('\nconst CACHEABLE', start);
assert.ok(start >= 0 && end > start, 'Media handler source boundary exists');
const handlerSource = source.slice(start, end);
const policy = '1:1:1';
const message = { key: 'post', images: [{ url: 'https://example.test/meme.jpg' }], siteId: 'generic' };

function harness(runMediaTiers) {
  const effects = [];
  let stored = { action: 'clean', settingsPolicy: policy, reasons: [] };
  const context = {
    protectionEnabled: true, protectionGeneration: 0,
    runtime: { imageEnabled: true, ocrEnabled: true, lexiconEnabled: true },
    settingsPolicy: () => policy, MSG, mediaFingerprint, refineVerdict, reconcileMediaVerdict,
    runtimeSettingsReady: Promise.resolve(),
    mediaLatestFp: new Map(), mediaInFlight: new Map(), mediaDone: new Map(), mediaOcrResults: new Map(),
    imageRetryAttempts: new Map(), ocrRetryAttempts: new Map(), mediaRetryQueue: new Map(),
    MEDIA_DONE_MAX: 500, IMAGE_RETRY_LIMIT: 2,
    getVerdict: async () => stored,
    persistVerdict: async (key, verdict) => { stored = verdict; effects.push({ type: 'persist', verdict }); },
    chrome: { runtime: { sendMessage: async payload => { effects.push({ type: 'notify', payload }); } } },
    deferMediaRetry: (key, msg, fp, reason) => effects.push({ type: 'retry', reason }),
    getOcrQueueState: () => ({ available: true }),
    recordMedia() {}, verdictLog() {}, log() {}, postProgress() {}, scheduleMediaRetry() {},
    setTimeout, console, runMediaTiers
  };
  const handle = runInNewContext(`(() => { ${handlerSource}; return handleClassifyMedia; })()`, context);
  return { handle, context, effects, stored: () => stored };
}

const ocrBlock = { action: 'block', source: 'lexicon-ocr', detail: { imageUrl: message.images[0].url } };
test('OCR is persisted and notified before deferring a failed image tier', async () => {
  const env = harness(async () => ({
    imageVerdict: { action: 'clean' }, ocrVerdict: ocrBlock,
    diag: { imageIncomplete: true, imageStatus: 'error', ocrStatus: 'block', ocr: 'ok' }
  }));
  const response = await env.handle(message);
  assert.equal(response.deferred, 'image-fetch');
  assert.equal(env.stored().action, 'block');
  assert.deepEqual(env.effects.map(effect => effect.type), ['persist', 'notify', 'retry']);
  assert.equal(env.effects[1].payload.verdict.action, 'block');
  assert.equal(env.context.mediaDone.has(message.key), false);
  assert.equal(env.context.mediaInFlight.size, 0);
});

test('an image block is retained while the OCR tier retries a transport failure', async () => {
  const env = harness(async (images, referer, text, progress, publish) => {
    const imageVerdict = { action: 'block', source: 'image', detail: { imageUrl: images[0].url } };
    await publish(imageVerdict);
    return { imageVerdict, ocrVerdict: null,
      diag: { imageIncomplete: false, imageStatus: 'block', ocrStatus: 'error', ocr: 'ok', ocrResult: { reason: 'fetch-timeout' } } };
  });
  assert.equal((await env.handle(message)).deferred, 'ocr-error');
  assert.equal(env.stored().action, 'block');
  assert.deepEqual(env.effects.map(effect => effect.type), ['persist', 'notify', 'retry']);
  assert.equal(env.context.ocrRetryAttempts.get(message.key).count, 1);
});

test('OCR completion for replaced media cannot persist or notify a stale block', async () => {
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = harness(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = env.handle(message);
  await entered;
  env.context.mediaLatestFp.set(message.key, `${policy}|${mediaFingerprint([{ url: 'https://example.test/replacement.jpg' }])}`);
  finish({ imageVerdict: { action: 'clean' }, ocrVerdict: ocrBlock,
    diag: { imageIncomplete: false, imageStatus: 'clean', ocrStatus: 'block' } });
  assert.equal((await pending).skipped, 'stale-media');
  assert.equal(env.stored().action, 'clean');
  assert.equal(env.effects.length, 0);
  assert.equal(env.context.mediaInFlight.size, 0);
});

const settledError = { ocrVerdict: null, ocrStatus: 'error', ocrResult: { action: 'error', reason: 'fetch-timeout' } };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('late OCR failure is consumed once while duplicate media requests remain deduplicated', async () => {
  let complete, passes = 0;
  const pendingOcr = new Promise(resolve => { complete = resolve; });
  const env = harness(async () => {
    passes++;
    return { imageVerdict: { action: 'clean' }, ocrVerdict: null, pendingOcr,
      diag: { imageIncomplete: false, imageStatus: 'clean', ocrStatus: 'timed-out', ocr: 'timed-out' } };
  });
  assert.equal((await env.handle(message)).deferred, 'ocr-in-flight');
  assert.equal(env.context.mediaInFlight.size, 1);
  assert.equal((await env.handle(message)).deferred, 'already-processing');
  complete(settledError);
  await turn();
  assert.equal(passes, 1); // no image reclassification or fresh OCR read on completion
  assert.equal(env.context.ocrRetryAttempts.get(message.key).count, 1);
  assert.deepEqual(env.effects.map(effect => effect.type), ['retry']);
  assert.equal(env.context.mediaInFlight.size, 0);
});

test('image-only retries cannot restart OCR after its two attempts are exhausted', async () => {
  let ocrJobs = 0;
  const env = harness(async (images, referer, text, progress, publish, priority, key, completedOcr) => {
    if (!completedOcr) ocrJobs++;
    return { imageVerdict: { action: 'clean' }, ocrVerdict: null,
      diag: { imageIncomplete: true, imageStatus: 'error', ...(completedOcr ?? settledError), ocr: 'ok' } };
  });
  assert.equal((await env.handle(message)).deferred, 'ocr-error');
  assert.equal((await env.handle(message, { deferred: true })).deferred, 'image-fetch');
  assert.equal((await env.handle(message, { deferred: true })).skipped, 'media-incomplete');
  assert.equal(ocrJobs, 2);
  assert.equal(env.context.ocrRetryAttempts.get(message.key).count, 2);
  assert.deepEqual(env.effects.filter(effect => effect.type === 'retry').map(effect => effect.reason), ['ocr-error', 'image-fetch']);
  assert.equal(env.context.mediaDone.has(message.key), false);
  assert.equal(env.context.mediaOcrResults.get(message.key).outcome.ocrStatus, 'error');
});

test('late OCR success preserves the original image pass and its retry count', async () => {
  let complete, passes = 0;
  const pendingOcr = new Promise(resolve => { complete = resolve; });
  const env = harness(async () => {
    passes++;
    return { imageVerdict: { action: 'clean' }, ocrVerdict: null, pendingOcr,
      diag: { imageIncomplete: true, imageStatus: 'error', ocrStatus: 'timed-out', ocr: 'timed-out' } };
  });
  await env.handle(message);
  complete({ ocrVerdict: ocrBlock, ocrStatus: 'block', ocrResult: { action: 'block' } });
  await turn();
  assert.equal(passes, 1);
  assert.equal(env.stored().action, 'block');
  assert.equal(env.context.imageRetryAttempts.get(message.key).count, 1);
  assert.deepEqual(env.effects.map(effect => effect.type), ['persist', 'notify', 'retry']);
});

test('media classification waits for the stored runtime settings before starting work', async () => {
  let initialize, passes = 0;
  const env = harness(async () => { passes++; throw new Error('disabled media started'); });
  env.context.runtimeSettingsReady = new Promise(resolve => { initialize = resolve; });
  const pending = env.handle(message);
  env.context.runtime.imageEnabled = false;
  env.context.runtime.ocrEnabled = false;
  initialize();
  assert.equal((await pending).skipped, true);
  assert.equal(passes, 0);
});
