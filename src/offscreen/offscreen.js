// SafeScroll offscreen document.
// CRITICAL ORDER (per architecture constraint #3):
//   1. register onMessage listener
//   2. IMMEDIATELY post {type:'ready'}
//   3. only then start loading ML models (lazy, in background)
import { MSG } from '../shared/messages.js';
import { PROFILES } from '../shared/profiles.js';
import { lexiconCheck } from '../shared/lexicon.js';
import { classifyText } from './textClassifier.js';
import { classifyImage } from './imageClassifier.js';
import { runOCR } from './ocr.js';
import { persistVerdict, submitFeedback, exportFeedback, flushPendingWrites, assertImageBitmapTransport, getSessionStats, getRecentVerdicts } from './store.js';

let modelsReady = false;
let modelsError = null;
let loadStarted = false;
const stageState = { text: 'pending', image: 'pending', ocr: 'pending' };

function log(...a) { console.log('[SafeScroll offscreen]', ...a); }
function fail(...a) { console.error('[SafeScroll offscreen FAIL]', ...a); }

function postProgress(stage, value) {
  chrome.runtime.sendMessage({ type: MSG.MODELS_PROGRESS, stage, value }).catch(() => {});
}

// ---------------------------------------------------------------- message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
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

    case MSG.GET_PROFILES:
      // Live PROFILES object for the options dashboard — no drift possible.
      sendResponse({ profiles: PROFILES });
      return false;

    case MSG.STATUS:
      sendResponse({ modelsReady, modelsError, loadStarted, stageState, profiles: PROFILES });
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
            quantization: 'INT8 dynamic (onnxruntime)',
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
            tier: 'OCR (meme text)',
            model: 'tesseract.js eng',
            params: '—',
            quantization: 'wasm cores (local) + eng.traineddata (data, CDN-cached)',
            sizeMB: 11,
            source: 'worker/wasm bundled; traineddata cached in IndexedDB',
            loadState: stageState.ocr
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
      // return the raw score — used by the popup button to verify the ML
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

// 3. Self-test: does ImageBitmap survive chrome.runtime structured-clone transport?
// Expected outcome on real Chrome: NO (JSON-serialized). This is informational —
// the pipeline unconditionally uses ImageData/dataURL transport either way.
assertImageBitmapTransport()
  .then(survives => {
    if (survives) log('ImageBitmap transport: SURVIVES (unexpected)');
    else log('ImageBitmap transport: not supported (expected) — pipeline uses ImageData/dataURL transport');
  })
  .catch(e => fail('ImageBitmap probe crashed:', e));

// 4. Warm up models at boot (not only on first classify) so the popup reaches
// "ready" without needing a feed visit first.
startLoading();

// 4. Lazy model warm-up so first classifications are fast.
// Per-stage resilience: one stage failing (e.g., OCR traineddata download on a
// flaky network) must NOT block modelsReady forever — stages run independently;
// text+image ready => modelsReady (OCR loads lazily on demand anyway).
function startLoading() {
  if (loadStarted) return;
  loadStarted = true;

  const runStage = async (name, fn) => {
    stageState[name] = 'loading';
    postProgress(name, 0);
    try {
      await fn();
      stageState[name] = 'ready';
      postProgress(name, 1);
      log(`stage ready: ${name}`);
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

  runStage('text', () => classifyText('warmup', () => {}));
  runStage('image', () => classifyImage(null, () => {}));
  runStage('ocr', () => runOCR('', () => {}));
}

// Handle classify: lexicon -> text -> image -> OCR(+image) fusion, explainable OR rule.
// Lexicon tier (interim, deterministic — see ml/TRAINING-HISTORY.md): severity-
// graded Hinglish slur list, checked FIRST. Fused by the same OR rule.
async function handleClassify(msg) {
  startLoading();
  const { text = '', imageUrls = [], siteId = 'generic' } = msg;

  // Stage 0: deterministic lexicon check (Hinglish tier) — DISABLED for
  // English-only mode (PROFILES.lexicon.enabled === false). Kept in codebase
  // for easy re-enable.
  const lex = (text && PROFILES.lexicon.enabled) ? lexiconCheck(text) : null;
  const lexVerdict = lex
    ? { action: lex.action, source: 'lexicon', detail: { tier: lex.action, hits: lex.hits } }
    : { action: 'clean', reason: 'no-text' };

  const textVerdict = text ? await classifyText(text, postProgress) : { action: 'clean', reason: 'no-text' };

  let imageVerdict = { action: 'clean', reason: 'no-image' };
  let ocrVerdict = { action: 'clean', reason: 'no-image' };

  for (const url of imageUrls.slice(0, 3)) {
    const iv = await classifyImage(url, postProgress).catch(e => ({ action: 'clean', reason: 'image-error:' + e }));
    if (iv.action === 'block') { imageVerdict = iv; break; }
    if (iv.action === 'flag') imageVerdict = iv;

    // Meme path: run OCR on the same image, feed text into the classifier.
    // (Hinglish lexicon on OCR text is skipped in English-only mode; the 'hin'
    // OCR language was also dropped for now — see ocr.js.)
    const ocrText = await runOCR(url, postProgress).catch(() => '');
    if (ocrText && ocrText.trim().length > 3) {
      const oLex = PROFILES.lexicon.enabled ? lexiconCheck(ocrText) : null;
      const o = await classifyText(ocrText, postProgress);
      const candidates = [];
      if (oLex) candidates.push({ action: oLex.action, source: 'lexicon-ocr', detail: { tier: oLex.action, hits: oLex.hits } });
      candidates.push({ ...o, source: 'ocr-text' });
      for (const cand of candidates) {
        if (cand.action === 'block') { ocrVerdict = cand; break; }
        if (cand.action === 'flag') ocrVerdict = cand;
      }
    }
    if (ocrVerdict.action === 'block') break;
  }

  // Explainable fusion (no learned model):
  const crossed = [lexVerdict, textVerdict, imageVerdict, ocrVerdict];
  let action = 'clean';
  if (crossed.some(v => v.action === 'block')) action = 'block';
  else if (crossed.some(v => v.action === 'flag')) action = 'flag';

  const verdict = {
    action,
    siteId,
    reasons: crossed.filter(v => v.action !== 'clean').map(v => ({ source: v.source || 'text', action: v.action, detail: v.detail || v.reason })),
    ts: Date.now()
  };

  await persistVerdict(msg.key, verdict); // IndexedDB write guarded by pending-queue
  return { verdict };
}
