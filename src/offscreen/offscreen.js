// SafeScroll offscreen document.
// CRITICAL ORDER (per architecture constraint #3):
//   1. register onMessage listener
//   2. IMMEDIATELY post {type:'ready'}
//   3. only then start loading ML models (lazy, in background)
import { MSG, OFFSCREEN_ROUTED, RELAY_MARK } from '../shared/messages.js';
import { PROFILES } from '../shared/profiles.js';
import { mediaFingerprint, mediaSourceKey } from '../shared/mediaFingerprint.js';
import { MODERATION_DEFAULTS } from '../shared/moderationSettings.js';
import { lexiconCheck } from '../shared/lexicon.js';
import { classifyText, classifyOcrText } from './textClassifier.js';
import { classifyImage } from './imageClassifier.js';
import { decodeGifFrames } from './animatedFrames.js';
import { refineVerdict, reconcileMediaVerdict } from './refineVerdict.js';
import { runOCRResult, ocrSourceKey, isKnownBadOcrSource, getCachedOcrText, getPendingOcrText, getOcrQueueState, getOcrQueuePosition, onOcrCapacity, cancelQueuedOcr } from './ocr.js';
import { persistVerdict, getVerdict, getImageVerdict, putImageVerdict, isCacheableImageVerdict, clearVerdicts, submitFeedback, exportFeedback, flushPendingWrites, assertImageBitmapTransport, getSessionStats, getRecentVerdicts } from './store.js';

let modelsReady = false;
let modelsError = null;
let loadStarted = false;
const stageState = { text: 'pending', image: 'pending', ocr: 'pending' };

function log(...a) { console.log('[SafeScroll offscreen]', ...a); }
function fail(...a) { console.error('[SafeScroll offscreen FAIL]', ...a); }
// Debug prefixes (see the task's logging convention). These carry no user
// content — only stage names and verdict actions/scores.
const modelLog = (...a) => console.log('[SS][MODEL]', ...a);
const verdictLog = (...a) => console.log('[SS][VERDICT]', ...a);
function postProgress(stage, value) {
  chrome.runtime.sendMessage({ type: MSG.MODELS_PROGRESS, stage, value }).catch(() => {});
}

const OCR_REFILL_MS = 5000;
// Hard ceiling on how long one media pass may wait for the OCR tier. OCR is
// allowed to fail or stall; it is never allowed to hold the pass open.
// OCR is a refinement tier, not permission to freeze an image indefinitely.
// Six seconds covers the normal cached-worker path while bounding the visible
// scanning state on a cold or stalled worker.
const OCR_WAIT_MS = 6000;

// ------------------------------------------------------------------ settings
// Runtime-toggable switches. Cached so the hot path never awaits storage; the
// cache is refreshed on change and at boot.
const runtime = { ...MODERATION_DEFAULTS };
let runtimeSettingsReady = Promise.resolve();
let settingsChangeVersion = 0;

function applyRuntimeSettings(v = {}) {
  const wasOcrEnabled = runtime.ocrEnabled;
  if (typeof v.ocrEnabled === 'boolean') runtime.ocrEnabled = v.ocrEnabled;
  if (typeof v.imageEnabled === 'boolean') runtime.imageEnabled = v.imageEnabled;
  if (typeof v.lexiconEnabled === 'boolean') runtime.lexiconEnabled = v.lexiconEnabled;
  if (wasOcrEnabled && !runtime.ocrEnabled) cancelQueuedOcr();
  log(`runtime settings: ocr=${runtime.ocrEnabled} image=${runtime.imageEnabled} lexicon=${runtime.lexiconEnabled}`);
}
function settingsPolicy() {
  return `${Number(runtime.imageEnabled)}:${Number(runtime.ocrEnabled)}:${Number(runtime.lexiconEnabled)}`;
}
async function syncRuntimeSettings() {
  const version = settingsChangeVersion;
  const response = await chrome.runtime.sendMessage({ type: MSG.GET_RUNTIME_SETTINGS });
  if (!response?.settings) throw new Error(response?.error ?? 'runtime settings unavailable');
  if (version === settingsChangeVersion) applyRuntimeSettings(response.settings);
}

// ---------------------------------------------------------------- message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // FIRST DELIVERY WINS.
  //
  // chrome.runtime.sendMessage() broadcasts to every extension context except
  // the sender, so a content-script/popup `classify` reaches this document
  // DIRECTLY and a second time through the background relay. Handling both
  // copies ran every model inference and every OCR pass twice per request and
  // queued duplicate OCR work each time. The relay stamps the copy it owns
  // with RELAY_MARK; unmarked copies of routed types are dropped here and the
  // background's marked copy is the one that runs.
  if (OFFSCREEN_ROUTED.has(msg?.type) && !msg[RELAY_MARK]) return false;

  switch (msg?.type) {
    case MSG.RUNTIME_SETTINGS_CHANGED:
      if (!msg[RELAY_MARK]) return false;
      settingsChangeVersion++;
      applyRuntimeSettings(msg.settings);
      sendResponse({ ok: true });
      return false;
    case MSG.PING:
      // Handshake PONG proves the listener is registered and responsive.
      sendResponse({ ok: true, ready: true });
      return false;

    case MSG.CLASSIFY:
      handleClassify(msg).then(sendResponse).catch(e => {
        fail('classify error:', e);
        sendResponse({ error: String(e), verdict: { action: 'clean', reason: 'pipeline-error' } });
      });
      return true; // async

    // MEDIA-ONLY pass, sent as a SEPARATE message after the text verdict has
    // already been rendered. This is what makes the pipeline feel real-time:
    // the text path is a single ~157ms window and never waits on a network
    // image fetch (200ms-2s) or OCR (1-3s). Any media finding is pushed back
    // asynchronously and upgrades the shield in place.
    case MSG.CLASSIFY_MEDIA:
      handleClassifyMedia(msg)
        .then(r => sendResponse({ ok: true, ...r }))
        .catch(e => {
          console.warn('[SafeScroll] media pass failed:', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true; // async

    case MSG.CLASSIFY_ANIMATED:
      queueAnimatedScan(msg)
        .then(sendResponse)
        .catch(e => {
          console.warn('[SafeScroll] animated media scan failed:', String(e?.message ?? e));
          sendResponse({ ok: false, error: String(e?.message ?? e) });
        });
      return true;

    case MSG.GET_PROFILES:
      // Live PROFILES object for the options dashboard â€” no drift possible.
      sendResponse({ profiles: PROFILES });
      return false;

    case MSG.STATUS:
      sendResponse({ modelsReady, modelsError, loadStarted, stageState, profiles: PROFILES });
      return false;

    case MSG.MEDIA_DIAG:
      sendResponse({
        modelsReady, modelsError, runtime, ocrQueue: getOcrQueueState(), mediaLog
      });
      return false;

    case MSG.FEEDBACK:
      submitFeedback(msg.feedback)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.EXPORT_FEEDBACK:
      exportFeedback(msg.format).then(sendResponse).catch(e => sendResponse({ error: String(e) }));
      return true;

    case 'flush-pending-writes':
      flushPendingWrites();
      return false;

    case 'clear-verdict-cache':
      clearVerdicts()
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;

    case 'get-session-stats':
      getSessionStats().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;

    case 'test-text': {
      // Dashboard "test any text": run the text tier + lexicon on arbitrary text.
      startLoading();
      (async () => {
        try {
          const text = String(msg.text ?? '').slice(0, 2000);
          const lex = PROFILES.lexicon.enabled ? lexiconCheck(text) : null;
          const v = await classifyText(text, () => {});
          sendResponse({ ok: true, verdict: v, lexicon: lex });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    case 'get-model-info': {
      // Model metadata for the dashboard. Sizes measured from the built bundle;
      // load state from the live stage trackers.
      sendResponse({
        ok: true,
        modelsReady,
        modelsError,
        loadStarted,
        stageState,
        tiers: [
          {
            tier: 'Text toxicity',
            model: 'unitary/multilingual-toxic-xlm-roberta',
            params: '278M (XLM-R base)',
            quantization: 'per-channel INT8 weights (onnxruntime)',
            sizeMB: 265.9,
            source: 'bundled locally in extension (public/models/toxic-xlmr)',
            loadState: stageState.text
          },
          {
            tier: 'Image NSFW',
            model: 'nsfwjs MobileNetV2',
            params: '~4.3M',
            quantization: 'fp32 (tfjs)',
            sizeMB: 5.2,
            source: 'bundled via npm package imports',
            loadState: stageState.image
          },
          {
            tier: 'Image violence / gore',
            model: 'image-multi-detect ResNet-50',
            params: '~23.5M',
            quantization: 'INT8 dynamic (onnxruntime)',
            sizeMB: 23.7,
            source: 'bundled locally (MIT; pinned revision, see model NOTICE)',
            loadState: stageState.image
          },
          {
            tier: 'OCR (meme text)',
            model: 'tesseract.js eng',
            params: 'â€”',
            quantization: 'wasm cores (local) + eng.traineddata (data, CDN-cached)',
            sizeMB: 11,
            source: 'worker/wasm bundled; traineddata cached in IndexedDB',
            loadState: stageState.ocr === 'pending' ? 'lazy' : stageState.ocr
          }
        ]
      });
      return false;
    }

    case 'get-recent-verdicts':
      getRecentVerdicts(20)
        .then(rows => sendResponse({ ok: true, rows }))
        .catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;

    case 'self-test': {
      // Classify a known-toxic sentence end-to-end through the text tier and
      // return the raw score â€” used by the popup button to verify the ML
      // half of the pipeline in isolation.
      startLoading();
      (async () => {
        try {
          const v = await classifyText('You are a worthless piece of garbage, nobody would even miss you', () => {});
          log('SELF-TEST verdict:', JSON.stringify(v));
          sendResponse({ ok: true, verdict: v });
        } catch (e) {
          fail('self-test failed:', e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
  }
});

// 2. Post READY immediately after listener registration.
chrome.runtime.sendMessage({ type: MSG.READY }).catch(e => fail('ready post failed:', e));
log('listener registered; READY posted');
runtimeSettingsReady = syncRuntimeSettings();
void runtimeSettingsReady.catch(error => fail('runtime settings sync failed:', error));

// 3. Self-test: does ImageBitmap survive chrome.runtime structured-clone transport?
// Expected outcome on real Chrome: NO (JSON-serialized). This is informational â€”
// the pipeline unconditionally uses ImageData/dataURL transport either way.
assertImageBitmapTransport()
  .then(survives => {
    if (survives) log('ImageBitmap transport: SURVIVES (unexpected)');
  })
  .catch(e => fail('ImageBitmap probe crashed:', e));

// Lazy model warm-up so first classifications are fast.
// Per-stage resilience: one stage failing (e.g., OCR traineddata download on a
// flaky network) must NOT block modelsReady forever â€” stages run independently;
// text+image ready => modelsReady (OCR loads lazily on demand anyway).
//
// ADDED: a per-stage timeout. Previously a stage that hung forever (a stalled
// model fetch that never rejects) left its state at 'loading' permanently and
// modelsReady never fired, so the in-page banner covered the page forever.
//
// NOTE: declared here, ABOVE the startLoading() call site below â€” `const` is in
// the temporal dead zone until initialised, and calling startLoading() first
// threw "Cannot access 'STAGE_TIMEOUT_MS' before initialization".
const STAGE_TIMEOUT_MS = 180000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// 4. Warm up models at boot (not only on first classify) so the popup reaches
// "ready" without needing a feed visit first.
startLoading();

function startLoading() {
  if (loadStarted) return;
  loadStarted = true;

  const runStage = async (name, fn) => {
    stageState[name] = 'loading';
    postProgress(name, 0);
    try {
      await withTimeout(fn(), STAGE_TIMEOUT_MS, `stage:${name}`);
      stageState[name] = 'ready';
      postProgress(name, 1);
      modelLog(`stage ready: ${name}`);
    } catch (e) {
      stageState[name] = 'failed';
      modelsError = modelsError ? `${modelsError}; ${name}: ${e}` : `${name}: ${e}`;
      fail(`stage ${name} failed:`, e);
    }
    // text+image are the critical tiers; OCR warms up lazily on use.
    if (stageState.text === 'ready' && stageState.image === 'ready') {
      modelsReady = true;
      chrome.runtime.sendMessage({ type: MSG.MODELS_READY, error: modelsError }).catch(() => {});
    }
  };

  // OCR is deliberately NOT warmed at boot: it pulls ~11MB of .traineddata over
  // the network on every browser start, for a tier used on a minority of units.
  // It loads on first actual need instead.
  // Text is the critical path for every unit. Loading the 266 MB XLM-R model
  // and the image models simultaneously caused CPU, WASM compilation and
  // disk contention during startup. Give text priority, then warm image.
  void (async () => {
    await runStage('text', () => classifyText('warmup', () => {}));
    await runStage('image', () => classifyImage(null, () => {}));
  })();
}

// Handle classify: lexicon -> text -> image -> OCR(+image) fusion, explainable OR rule.
// Lexicon tier (interim, deterministic — see ml/TRAINING-HISTORY.md): severity-
// graded Hinglish slur list, checked FIRST. Fused by the same OR rule.
//
// LATENCY NOTES (measured on the real model, see scripts/measure-latency.mjs):
//  - Text inference dominates: ~300ms per 128-token window. Verdict caching and
//    the early-exit in classifyText handle the repeated case and the urgent case.
//  - Image NSFW + violence/gore share one decoded bitmap. Per-post images and
//    the two independent detectors run concurrently; transport is tightly
//    bounded so a remote image cannot pin the queue.
//  - OCR is the most expensive tier (~1-3s) but it runs inside a Web Worker, so
//    it is kicked off in parallel and awaited at the end instead of serialising
//    behind the image work. It is bounded by the OCR queue so a
//    feed of fifty images cannot stall the pipeline.
async function handleClassify(msg) {
  await runtimeSettingsReady;
  const policy = settingsPolicy();
  startLoading();
  const { text = '', images = [], siteId = 'generic', referer = null, host = null } = msg;
  const imageList = (images.length ? images : (msg.imageUrls || []).map(u => (typeof u === 'string' ? { url: u, dataUrl: null } : u)))
    .filter(i => i && (i.url || i.dataUrl));

  // ---------------------------------------------------------------- cache
  // Same content key => same deterministic verdict (the model and thresholds are
  // compile-time constants), so a cache hit is exactly equivalent to re-running
  // inference. This is what makes scrolling back and page reloads instant.
  const key = msg.key;
  if (key) {
    const cached = await getVerdict(key, policy);
    if (cached && CACHEABLE.has(cached.action)) {
      return { verdict: cached };
    }
  }

  const buildVerdict = parts => {
    const crossed = parts.filter(Boolean);
    let action = 'clean';
    if (crossed.some(v => v.action === 'block')) action = 'block';
    else if (crossed.some(v => v.action === 'flag')) action = 'flag';
    return {
      action,
      siteId,
      host: host ?? null,
      reasons: crossed.filter(v => v.action !== 'clean')
        .map(v => ({ source: v.source || 'text', action: v.action, detail: v.detail || v.reason })),
      ts: Date.now(),
      settingsPolicy: policy
    };
  };

  // Stage 0: deterministic lexicon check — runs in ~0ms, always first.
  const lex = (text && runtime.lexiconEnabled) ? lexiconCheck(text) : null;
  const lexVerdict = lex
    ? { action: lex.action, source: 'lexicon', detail: { tier: lex.action, hits: lex.hits } }
    : { action: 'clean', reason: 'no-text' };

  // A lexicon block is already the maximum possible action under OR fusion;
  // spending a model inference cannot change it. Return immediately and keep
  // the single-threaded model free for ambiguous/clean text still waiting in
  // the viewport queue.
  const textVerdict = lexVerdict.action === 'block'
    ? { action: 'clean', source: 'text', reason: 'skipped-lexicon-block' }
    : (text ? await classifyText(text, postProgress) : { action: 'clean', reason: 'no-text' });
  if (settingsPolicy() !== policy) {
    return { verdict: { action: 'clean', reason: 'settings-changed', settingsPolicy: policy } };
  }

  // Deliberately NOT awaiting media here. The content script fires a separate
  // MSG.CLASSIFY_MEDIA once this response has been rendered, so a caption that
  // the model flags in ~157ms is blurred in ~157ms — not after 2-5s of image
  // downloading. Media findings arrive later as a verdict upgrade.
  const verdict = buildVerdict([lexVerdict, textVerdict]);
  verdictLog('text', String(key).slice(0, 16), '->', verdict.action,
    `(lexicon=${lexVerdict.action} model=${textVerdict.action}` +
    `${textVerdict?.detail?.score != null ? ` score=${Number(textVerdict.detail.score).toFixed(3)}` : ''})`);
  await persistVerdict(key, verdict);
  return { verdict };
}

// ---------------------------------------------------------------- media log
// Ring buffer of every media pass, including the ones that were skipped. A
// skipped pass is exactly the failure a user reports ("it never blurs"), so it
// must be observable — a skip that leaves no trace is indistinguishable from a
// clean verdict.
const mediaLog = [];
function recordMedia(entry) {
  mediaLog.push({ ts: Date.now(), ocrQueue: getOcrQueueState(), ...entry });
  if (mediaLog.length > 40) mediaLog.splice(0, mediaLog.length - 40);
}

// ------------------------------------------------------- media deduplication
// One media pass per (post key + image set). A duplicate delivery used to buy a
// second NSFW fetch and another OCR queue entry for the exact same image —
// the single biggest waste in the pipeline. Bounded maps, no DOM references,
// and a changed image set is NOT a duplicate (a post whose media legitimately
// differs must be re-analysed, never permanently blocked).
const mediaInFlight = new Map(); // key -> fingerprint
const mediaLatestFp = new Map(); // key -> latest requested fingerprint
const mediaDone = new Map(); // key -> fingerprint of the image set last analysed
const mediaOcrResults = new Map(); // key -> { fp, outcome }; includes terminal OCR errors
const MEDIA_DONE_MAX = 500;

// ---------------------------------------------------------- media deferral
// A missing OCR result means "not yet read", not "there is nothing to see".
// An image fetch timeout is likewise not proof that the image was safe.
const MEDIA_RETRY_MAX = 30;
const IMAGE_RETRY_LIMIT = 2;
const mediaRetryQueue = new Map(); // key -> { msg, fp }
const mediaRetryKeys = new Set();
const imageRetryAttempts = new Map(); // key -> { fp, count }
const ocrRetryAttempts = new Map(); // key -> { fp, count }
let mediaRetryTimer = null;
let mediaRetryFlushing = false;

function deferMediaRetry(key, msg, fp, reason = 'image-fetch') {
  if (mediaRetryKeys.has(key)) {
    if (mediaRetryQueue.get(key)?.fp !== fp) mediaRetryQueue.set(key, { msg, fp, reason });
    recordMedia({ key, skipped: 'media-retry-pending', nImages: msg.images?.length ?? 0 });
    log(`[SS][DEDUP] media retry already queued for ${String(key).slice(0, 16)}`);
    return;
  }
  if (mediaRetryQueue.size >= MEDIA_RETRY_MAX) {
    const oldest = mediaRetryQueue.keys().next().value;
    const dropped = mediaRetryQueue.get(oldest);
    mediaRetryQueue.delete(oldest);
    mediaRetryKeys.delete(oldest);
    // Release the content script's request dedupe so a returning post can
    // request its media again. The old entry is never reported as clean.
    chrome.runtime.sendMessage({ type: MSG.VERDICT_REFINED, key: oldest,
      mediaFingerprint: mediaFingerprint(dropped.msg.images ?? []), retryDropped: true }).catch(() => {});
  }
  mediaRetryQueue.set(key, { msg, fp, reason });
  mediaRetryKeys.add(key);
  const retry = reason === 'ocr-error' ? ocrRetryAttempts.get(key)?.count
    : reason === 'image-fetch' ? imageRetryAttempts.get(key)?.count : 0;
  log(`[SS][MEDIA] deferred key=${String(key).slice(0, 16)} reason=${reason} retry=${retry ?? 0} queued=${mediaRetryQueue.size}`);
  if (reason !== 'capacity-full') scheduleMediaRetry();
  else if (getOcrQueueState().available) setTimeout(() => flushMediaRetries(true), 0);
}

function scheduleMediaRetry() {
  if (mediaRetryTimer || ![...mediaRetryQueue.values()].some(e => e.reason !== 'capacity-full')) return;
  mediaRetryTimer = setTimeout(() => {
    mediaRetryTimer = null;
    void flushMediaRetries();
  }, OCR_REFILL_MS);
}

async function flushMediaRetries(capacityOnly = false) {
  if (mediaRetryFlushing || !mediaRetryQueue.size) return;
  if (!runtime.ocrEnabled && !runtime.imageEnabled) { mediaRetryQueue.clear(); mediaRetryKeys.clear(); return; }
  const selected = [...mediaRetryQueue].find(([, entry]) => capacityOnly ? entry.reason === 'capacity-full' : entry.reason !== 'capacity-full');
  if (!selected) return;
  const [key, entry] = selected;
  mediaRetryQueue.delete(key);
  mediaRetryKeys.delete(key);
  if (mediaLatestFp.get(key) !== entry.fp) { scheduleMediaRetry(); return; }
  if (mediaInFlight.has(key)) {
    mediaRetryQueue.set(key, entry);
    mediaRetryKeys.add(key);
    return;
  }
  mediaRetryFlushing = true;
  try {
    await handleClassifyMedia(entry.msg, { deferred: true });
  } catch (e) {
    console.warn('[SS][MEDIA] deferred pass failed (non-fatal):', String(e?.message ?? e));
  } finally {
    mediaRetryFlushing = false;
  }
  scheduleMediaRetry();
  if (getOcrQueueState().available && [...mediaRetryQueue.values()].some(e => e.reason === 'capacity-full')) {
    setTimeout(() => flushMediaRetries(true), 0);
  }
}
onOcrCapacity(() => { if (mediaRetryQueue.size) queueMicrotask(() => flushMediaRetries(true)); });

/**
 * Media-only pass. Runs the image/OCR tiers for a unit whose text verdict has
 * already been applied, and pushes an upgrade if the media is worse. Runs off
 * the critical path so it never delays the next unit's text verdict.
 */
const animatedQueue = [];
let animatedBusy = false;
function queueAnimatedScan(msg) {
  if (animatedQueue.length >= 8) return Promise.resolve({ ok: false, skipped: 'busy' });
  return new Promise(resolve => {
    animatedQueue.push({ msg, resolve });
    drainAnimatedQueue();
  });
}
function drainAnimatedQueue() {
  if (animatedBusy || !animatedQueue.length) return;
  const { msg, resolve } = animatedQueue.shift();
  animatedBusy = true;
  handleClassifyAnimated(msg).then(resolve, error => {
    console.warn('[SafeScroll] animated media scan failed:', String(error?.message ?? error));
    resolve({ ok: false, error: String(error?.message ?? error) });
  }).finally(() => { animatedBusy = false; drainAnimatedQueue(); });
}

async function handleClassifyAnimated(msg) {
  await runtimeSettingsReady;
  const { scanId, kind, frameIndex = 0, dataUrl, url, referer = null } = msg;
  if (typeof scanId !== 'string' || scanId.length > 120 || !scanId.startsWith('ssanim:') ||
      !['video', 'gif'].includes(kind) || (!runtime.imageEnabled && !runtime.ocrEnabled)) {
    return { ok: false, skipped: 'invalid-or-disabled' };
  }
  if (kind === 'video' && (!/^data:image\/(jpeg|png|webp);base64,/i.test(dataUrl ?? '') || dataUrl.length > 4_000_000)) {
    return { ok: false, skipped: 'invalid-video-frame' };
  }
  if (kind === 'gif' && (typeof url !== 'string' || url.length > 4_000_000 ||
      !/^(https?:\/\/|data:image\/gif;base64,)/i.test(url))) {
    return { ok: false, skipped: 'invalid-gif-source' };
  }
  const policy = settingsPolicy();
  let strongest = 'clean';
  const publish = (verdict, index) => {
    if (!verdict || !['block', 'flag'].includes(verdict.action) || settingsPolicy() !== policy) return;
    if (strongest === 'block' || (strongest === 'flag' && verdict.action === 'flag')) return;
    strongest = verdict.action;
    chrome.runtime.sendMessage({
      type: MSG.ANIMATED_VERDICT, scanId, kind, frameIndex: index,
      verdict: { action: verdict.action, source: verdict.source, reason: verdict.reason,
        settingsPolicy: policy }
    }).catch(() => {});
  };
  const frames = kind === 'video'
    ? (async function* () { yield { frameIndex, dataUrl }; })()
    : decodeGifFrames(url, referer);
  let checked = 0;
  for await (const frame of frames) {
    if (settingsPolicy() !== policy || strongest === 'block') break;
    checked++;
    const media = await runMediaTiers([{ url: null, dataUrl: frame.dataUrl }], referer,
      { action: 'clean' }, null, verdict => publish(verdict, frame.frameIndex),
      0, scanId);
    publish(media.ocrVerdict, frame.frameIndex);
    if (media.pendingOcr) void media.pendingOcr.then(result => {
      publish(result.ocrVerdict, frame.frameIndex);
    }).catch(() => {});
  }
  return { ok: true, checked, action: strongest };
}

async function handleClassifyMedia(msg, { deferred = false, resumedMedia = null } = {}) {
  await runtimeSettingsReady;
  const policy = settingsPolicy();
  const { key, images = [], referer = null, siteId = 'generic', host = null } = msg;
  const imageList = (images || []).filter(i => i && (i.url || i.dataUrl));
  if (!key || !imageList.length || (!runtime.imageEnabled && !runtime.ocrEnabled)) {
    recordMedia({
      key, skipped: !key ? 'no-key' : (!imageList.length ? 'no-images' : 'media-disabled'),
      nImages: imageList.length,
      imageEnabled: runtime.imageEnabled, ocrEnabled: runtime.ocrEnabled,
      lexiconEnabled: runtime.lexiconEnabled
    });
    return { skipped: true };
  }

  const fp = `${policy}|${mediaFingerprint(imageList)}`;
  const notifyVerdict = (verdict, mediaCompleted = false) => {
    if (!isCurrent()) return;
    chrome.runtime.sendMessage({ type: MSG.VERDICT_REFINED, key, verdict,
      mediaFingerprint: mediaFingerprint(imageList), mediaCompleted }).catch(() => {});
  };
  if (!deferred) {
    mediaLatestFp.delete(key);
    mediaLatestFp.set(key, fp);
    if (mediaLatestFp.size > MEDIA_DONE_MAX) mediaLatestFp.delete(mediaLatestFp.keys().next().value);
  } else if (mediaLatestFp.get(key) !== fp) return { skipped: 'stale-media' };
  const isCurrent = () => settingsPolicy() === policy && mediaLatestFp.get(key) === fp;

  // ---- duplicate-processing guard (same post, same images) -------------
  if (mediaInFlight.has(key)) {
    if (mediaInFlight.get(key) !== fp) deferMediaRetry(key, msg, fp, 'changed-media');
    recordMedia({ key, skipped: 'already-processing', nImages: imageList.length });
    log(`[SS][DEDUP] skipping already-processing media ${String(key).slice(0, 16)}`);
    return { deferred: 'already-processing' };
  }
  if (mediaDone.get(key) === fp) {
    recordMedia({ key, skipped: 'already-completed-media', nImages: imageList.length });
    log(`[SS][DEDUP] skipping already-completed media ${String(key).slice(0, 16)}`);
    return { skipped: 'already-completed-media' };
  }

  mediaInFlight.set(key, fp);
  let holdForOcr = false;
  const releaseMedia = () => {
    if (mediaInFlight.get(key) === fp) mediaInFlight.delete(key);
    if (mediaRetryQueue.get(key)?.reason === 'capacity-full') {
      if (getOcrQueueState().available) setTimeout(() => flushMediaRetries(true), 0);
    } else if (mediaRetryQueue.has(key)) scheduleMediaRetry();
  };
  try {
    // mediaDone + the current fingerprint is the authoritative duplicate
    // guard. Persisted reasons alone cannot prove this exact image set was
    // scanned: X may lazy-load or replace media while retaining the same post
    // key, and that new visible image must still be classified.
    const previous = await getVerdict(key, policy);
    if (!isCurrent()) return { skipped: 'stale-media' };
    const existing = reconcileMediaVerdict(previous, imageList);
    if (existing !== previous) {
      await persistVerdict(key, existing);
      notifyVerdict(existing);
    }

    // A text block still needs separate image/OCR provenance for media shields.
    const textVerdict = { action: 'clean', source: 'text' };
    let progressiveVerdict = null;
    const publishMediaVerdict = async mediaPart => {
      if (!isCurrent()) return;
      if (!mediaPart || !['block', 'flag'].includes(mediaPart.action)) return;

      const base = progressiveVerdict ?? existing;
      progressiveVerdict = refineVerdict(base, [mediaPart], siteId, host, policy);
      await persistVerdict(key, progressiveVerdict);
      notifyVerdict(progressiveVerdict);
    };

    const savedOcr = mediaOcrResults.get(key);
    const completedOcr = savedOcr?.fp === fp ? savedOcr.outcome : null;
    const media = resumedMedia ?? await runMediaTiers(imageList, referer, textVerdict, postProgress,
      publishMediaVerdict, deferred ? 0 : 1, key, completedOcr);
    if (!isCurrent()) return { skipped: 'stale-media' };
    // A confirmed OCR finding is ready now even if another image tier needs
    // a retry. Persist and paint it before any deferred return below.
    await publishMediaVerdict(media.ocrVerdict);
    if (!isCurrent()) return { skipped: 'stale-media' };
    const mediaParts = [media.imageVerdict, media.ocrVerdict].filter(v => v && v.action !== 'clean');
    const mediaState = ['timed-out', 'deferred'].includes(media.diag.ocrStatus) ? 'pending'
      : media.diag.imageIncomplete || media.diag.ocrStatus === 'error' ? 'error' : 'complete';
    recordMedia({
      key, nImages: imageList.length,
      imageEnabled: runtime.imageEnabled, ocrEnabled: runtime.ocrEnabled,
      ...media.diag,
      mediaState, result: mediaParts.length ? 'hit' : `media-${mediaState}`
    });
    verdictLog('media', String(key).slice(0, 16),
      `image=${media.diag.imageStatus} ocr=${media.ocrVerdict?.action ?? media.diag.ocrStatus}`,
      `ocrStatus=${media.diag.ocrStatus} ocrTier=${media.diag.ocr ?? '?'} images=${imageList.length} final=${(progressiveVerdict ?? existing)?.action ?? 'clean'} mediaState=${mediaState}`);

    // A failed image fetch is not a clean image verdict. Retry twice, then
    // leave this fingerprint uncompleted so a later visit can try again.
    let retryImage = false;
    if (media.diag.imageIncomplete) {
      const prior = imageRetryAttempts.get(key);
      const count = (prior?.fp === fp ? prior.count : 0) + (resumedMedia ? 0 : 1);
      imageRetryAttempts.set(key, { fp, count });
      if (imageRetryAttempts.size > MEDIA_DONE_MAX) imageRetryAttempts.delete(imageRetryAttempts.keys().next().value);
      retryImage = count <= IMAGE_RETRY_LIMIT;
    } else {
      imageRetryAttempts.delete(key);
    }
    if (media.diag.ocrStatus === 'timed-out') {
      holdForOcr = true;
      // Consume the original outcome, including failure. Reuse image results;
      // restarting the pass here discarded errors and bypassed retry limits.
      void media.pendingOcr.then(outcome => {
        releaseMedia();
        if (!isCurrent()) return;
        const { ocrVerdict, ...ocrDiag } = outcome;
        return handleClassifyMedia(msg, { deferred: true, resumedMedia: {
          ...media, ocrVerdict, pendingOcr: null,
          diag: { ...media.diag, ...ocrDiag, ocr: 'late-completion' }
        } });
      }).catch(error => {
        releaseMedia();
        console.warn('[SS][MEDIA] late completion failed:', error?.name ?? 'unknown');
        notifyVerdict(progressiveVerdict ?? existing, true);
      });
      return { deferred: 'ocr-in-flight' };
    }
    if (media.diag.ocrStatus === 'deferred') {
      deferMediaRetry(key, msg, fp, 'capacity-full');
      return { deferred: 'ocr-capacity' };
    }
    if (media.diag.ocrStatus === 'error' && !completedOcr && media.diag.ocr !== 'known-undecodable-source' &&
        media.diag.ocrResult?.reason !== 'invalid-image') {
      const prior = ocrRetryAttempts.get(key);
      const count = (prior?.fp === fp ? prior.count : 0) + 1;
      ocrRetryAttempts.set(key, { fp, count });
      if (ocrRetryAttempts.size > MEDIA_DONE_MAX) ocrRetryAttempts.delete(ocrRetryAttempts.keys().next().value);
      if (count <= 1) {
        deferMediaRetry(key, msg, fp, 'ocr-error');
        return { deferred: 'ocr-error' };
      }
    } else if (media.diag.ocrStatus !== 'error') ocrRetryAttempts.delete(key);
    // Image-only retries must reuse a settled OCR outcome, including an error
    // whose retry allowance is exhausted, rather than scheduling OCR again.
    mediaOcrResults.set(key, { fp, outcome: {
      ocrVerdict: media.ocrVerdict, ocrStatus: media.diag.ocrStatus,
      ocrResult: media.diag.ocrResult, ocrTextChars: media.diag.ocrTextChars
    } });
    if (mediaOcrResults.size > MEDIA_DONE_MAX) mediaOcrResults.delete(mediaOcrResults.keys().next().value);
    if (retryImage) {
      deferMediaRetry(key, msg, fp, 'image-fetch');
      return { deferred: 'image-fetch' };
    }
    if (media.diag.imageIncomplete || media.diag.ocrStatus === 'error') {
      notifyVerdict(progressiveVerdict ?? existing, true);
      return { skipped: 'media-incomplete', ocrStatus: media.diag.ocrStatus };
    }

    // Completed — including the clean outcome, which is the case that used to
    // re-run every time (clean media left no reason in the verdict to skip on).
    mediaDone.set(key, fp);
    if (mediaDone.size > MEDIA_DONE_MAX) mediaDone.delete(mediaDone.keys().next().value);
    notifyVerdict(progressiveVerdict ?? existing, true);
    return progressiveVerdict
      ? { action: progressiveVerdict.action, upgraded: true, progressive: true }
      : { skipped: 'media-clean' };
  } finally {
    if (!holdForOcr) releaseMedia();
  }
}

const CACHEABLE = new Set(['clean', 'block', 'flag']);

/**
 * Media tiers: NSFW + violence/gore per image (cached by URL, fetched
 * concurrently) plus the optional OCR tier.
 */
async function runMediaTiers(imageList, referer, textVerdict, progress, onImageVerdict = null, priority = 1, mediaKey = '', completedOcr = null) {
  let imageVerdict = { action: 'clean', reason: 'no-image' };
  let ocrVerdict = null;
  const budget = imageList.slice(0, 3);
  const diag = { ocr: null, ocrStatus: 'pending', images: [] };
  if (!budget.length) return { imageVerdict, ocrVerdict, diag };

  // The text tier may already have blocked; OCR cannot add a stronger verdict.
  const ocrKey = ocrSourceKey(budget[0].url ?? null, budget[0].dataUrl ?? null);
  let ocrAllowed = false;
  let ocrWhy = '';
  // Reuse completed and pending work before admitting a new queue entry.
  let preloadedText;
  if (completedOcr) ocrWhy = 'completed-media-ocr';
  else if (!runtime.ocrEnabled) ocrWhy = 'ocr-disabled';
  else if (textVerdict.action === 'block') ocrWhy = 'text-already-block';
  else if (isKnownBadOcrSource(ocrKey)) ocrWhy = 'known-undecodable-source';
  else {
    const cached = getCachedOcrText(ocrKey);
    const pending = getPendingOcrText(ocrKey);
    if (cached !== undefined) { preloadedText = cached; ocrWhy = 'cache-hit'; }
    else if (pending) { ocrAllowed = true; ocrWhy = 'in-flight'; }
    else if (!getOcrQueueState().available) ocrWhy = 'capacity-full';
    else { ocrAllowed = true; ocrWhy = 'ok'; }
  }
  diag.ocr = ocrWhy;
  const queueState = getOcrQueueState();
  const position = ocrWhy === 'ok' ? queueState.queued + 1 : getOcrQueuePosition(ocrKey);
  log(`[SS][OCR] key=${String(mediaKey).slice(0, 16)} tier=${ocrWhy} position=${position} active=${queueState.active} queued=${queueState.queued} capacity=${queueState.capacity}`);

  // Images are classified while OCR is in flight. Normalize OCR failures into
  // an outcome so they cannot reject this pass and discard the image verdict.
  const rawOcrPromise = ocrAllowed
    ? runOCRResult(budget[0].url, progress, referer, budget[0].dataUrl ?? null, priority)
    : Promise.resolve(preloadedText !== undefined
      ? { status: 'clean', text: preloadedText, cache: true }
      : { status: ocrWhy === 'capacity-full' ? 'deferred' : ocrWhy === 'known-undecodable-source' ? 'error' : 'skipped', text: '' });
  const ocrPromise = completedOcr ? Promise.resolve(completedOcr)
    : rawOcrPromise.then(result => moderateOcrResult(result, budget[0], progress))
      .catch(() => ({ ocrVerdict: null, ocrStatus: 'error', ocrResult: { action: 'error', reason: 'ocr-text-failed' } }));

  const results = runtime.imageEnabled ? await Promise.all(budget.map(async (img, index) => {
    // Per-image cache: repeat images cost ~1ms instead of a network round trip.
    const imageCacheKey = img.url ? mediaSourceKey(img) : null;
    let v;
    if (imageCacheKey) {
      const cached = await getImageVerdict(imageCacheKey);
      if (cached) v = { ...cached, cached: true };
    }
    if (!v) {
      v = await classifyImage(img.url, progress, referer, img.dataUrl ?? null)
        .catch(e => ({ action: 'clean', source: 'image', reason: 'image-error:' + e }));
    }
    diag.images[index] = {
      action: v.action,
      reason: v.reason ?? null,
      detail: v.detail ?? null,
      cached: !!v.cached,
      hasDataUrl: !!img.dataUrl
    };
    const iv = {
      ...v,
      detail: { ...(v.detail ?? {}), imageUrl: img.url ?? null, imageSourceKey: mediaSourceKey(img) }
    };
    // Publish a confirmed finding now; another image or OCR can still be slow.
    if (onImageVerdict && ['block', 'flag'].includes(iv.action)) await onImageVerdict(iv);
    // Storage must not hold up the first visible blur. Transport failures are
    // not cacheable: the source may be reachable on a later pass.
    if (!v.cached && imageCacheKey && isCacheableImageVerdict(v)) {
      await putImageVerdict(imageCacheKey, v);
    }
    return iv;
  })) : [];
  diag.imageIncomplete = results.some(v => !isCacheableImageVerdict(v));
  for (const iv of results) {
    if (iv.action === 'block' || (iv.action === 'flag' && imageVerdict.action === 'clean')) imageVerdict = iv;
  }
  diag.imageStatus = imageVerdict.action !== 'clean' ? imageVerdict.action
    : diag.imageIncomplete ? 'error' : runtime.imageEnabled ? 'clean' : 'skipped';

  // Bounded wait: a stalled tesseract worker (e.g. traineddata download that
  // never settles) must not pin the whole media pass open forever. The image
  // verdict above has already been computed at this point, so timing out here
  // costs only the OCR tier.
  let ocrResult;
  let ocrTimer = null;
  let ocrTimedOut = false;
  try {
    ocrResult = await Promise.race([
      ocrPromise,
      new Promise(r => {
        ocrTimer = setTimeout(() => {
          ocrTimedOut = true;
          const workState = getOcrQueuePosition(ocrKey) > 0 ? 'pending' : 'in-flight';
          log(`[SS][OCR] key=${String(mediaKey).slice(0, 16)} visible-wait-expired state=${workState}; completion will publish directly`);
          r({ ocrVerdict: null, ocrStatus: 'timed-out', ocrWorkState: workState,
            ocrResult: { action: 'timed-out', reason: 'caller-wait-expired' } });
        }, OCR_WAIT_MS);
      })
    ]);
  } catch (e) {
    console.warn('[SS][OCR] unreadable result (non-fatal):', String(e?.message ?? e));
    ocrResult = { ocrVerdict: null, ocrStatus: 'error', ocrResult: { action: 'error', reason: e?.name ?? 'unknown' } };
  } finally {
    clearTimeout(ocrTimer);
  }
  if (ocrTimedOut) diag.ocr = 'timed-out';
  const { ocrVerdict: finalOcrVerdict, ...ocrDiag } = ocrResult;
  ocrVerdict = finalOcrVerdict;
  Object.assign(diag, ocrDiag);
  return { imageVerdict, ocrVerdict, diag, pendingOcr: ocrTimedOut ? ocrPromise : null };
}

async function moderateOcrResult(result, image, progress) {
  let ocrVerdict = null;
  const diag = { ocrStatus: result.status, ocrTextChars: result.text?.length ?? 0 };
  const ocrText = result.text;
  if (result.status === 'clean' && ocrText && ocrText.trim().length > 3) {
    try {
      ocrVerdict = { action: 'clean', reason: 'ocr-text-clean' };
      // The lexicon runs on OCR text too. It is the only tier that reliably
      // catches a profane meme caption, because the toxicity model is trained on
      // identity-directed hate rather than profanity.
      const oLex = runtime.lexiconEnabled ? lexiconCheck(ocrText) : null;
      // Judged with the OCR thresholds, not the tweet thresholds.
      const o = await classifyOcrText(ocrText, progress);
      const candidates = [];
      if (oLex) candidates.push({ action: oLex.action, source: 'lexicon-ocr', detail: { tier: oLex.action, hits: oLex.hits } });
      candidates.push({ ...o, source: 'ocr-text' });
      for (const cand of candidates) {
        if (cand.action === 'block') { ocrVerdict = cand; break; }
        if (cand.action === 'flag') ocrVerdict = cand;
      }
      if (ocrVerdict.action !== 'clean') {
        ocrVerdict = {
          ...ocrVerdict,
          detail: { ...(ocrVerdict.detail ?? {}), imageUrl: image.url ?? null, imageSourceKey: mediaSourceKey(image) }
        };
        diag.ocrStatus = ocrVerdict.action;
      }
      diag.ocrResult = { action: ocrVerdict.action, source: ocrVerdict.source ?? null, score: o.detail?.score ?? null };
      // Content-bearing: gated so production logs never contain page text.
      console.log('[SS][VERDICT]', `ocr text read (${ocrText.length} chars) -> ${ocrVerdict.action}`);
    } catch (e) {
      // A failure in the OCR *text* tier must not discard the image verdict
      // that was already computed above.
      console.warn('[SS][MODEL] ocr-text classify failed (non-fatal):', String(e?.message ?? e));
      diag.ocrResult = { action: 'error', reason: String(e?.message ?? e) };
      diag.ocrStatus = 'error';
    }
  } else if (result.status === 'clean') {
    ocrVerdict = { action: 'clean', reason: 'no-ocr-text' };
    diag.ocrResult = {
      action: 'no-text',
      reason: 'empty-or-low-quality'
    };
  } else {
    diag.ocrResult = { action: result.status, reason: result.reason ?? 'ocr-skipped' };
  }
  return { ocrVerdict, ...diag };
}
