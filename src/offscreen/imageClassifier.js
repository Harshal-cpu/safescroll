// Image safety detection, fully on-device:
//   1. NSFWJS MobileNetV2 for sexual content.
//   2. A quantized ONNX safety model for violence, blood/gore and weapons.
// Both models and runtimes are extension-local; no image or inference request
// leaves the browser.
// NOTE: the old filename/URL substring check was DELETED when this was wired in
// (Phase 1); nothing else inspects URLs as a proxy for content.
//
// OPEN-WEB FIXES (the previous version only worked on pbs.twimg/cdninstagram):
//  1. TRANSPORT: a `dataUrl` produced by the content script is preferred when
//     available. It is free (the bytes are already in the page) and bypasses
//     CORS, hotlink protection and cookie walls entirely.
//  2. FETCH: the offscreen document is cross-origin to every site, so a bare
//     `fetch(url, {credentials:'omit'})` is blocked by CORS almost everywhere.
//     We now send the page URL as a Referer (hotlink protection) and retry with
//     credentials:'include' (cookie-walled media such as X and Instagram).
//  3. SAFETY: a hard timeout, a byte-size cap and a non-image content-type
//     check, so one hostile/huge URL can't stall the whole pipeline. The budget
//     is a single deadline shared by both fetch strategies — with a
//     per-attempt timeout the worst case was 3 x 12s = 36s of dead time for one
//     unreachable image, which froze the whole classification queue.
// Importing the nsfwjs package root pulls all three bundled models (including
// six large Inception shards) into the extension even though only MobileNetV2
// is used. The core + one definition keeps loading identical and tree-shakable.
import { load as loadNsfw } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import { PROFILES } from '../shared/profiles.js';
import { classifyViolence, warmViolenceModel } from './violenceClassifier.js';
import { fetchImageBlob, imageSourceFailure } from './imageSource.js';

// Page-captured data URLs bypass this path. For the fallback URL path, bound
// retries tightly: a moderation result that arrives after the user has already
// scrolled away is not useful, and alternate credential modes rarely rescue a
// source after several seconds.
const FETCH_BUDGET_MS = 2500;     // total across all strategies for one image
const FETCH_ATTEMPT_MS = 1200;    // per-strategy cap
const MAX_EDGE = 512;              // decode ceiling — nsfwjs downsamples to 224 anyway

let nsfwModel = null;
let nsfwLoadingPromise = null;

async function loadNsfwModel() {
  if (nsfwModel) return nsfwModel;
  if (!nsfwLoadingPromise) {
    nsfwLoadingPromise = loadNsfw('MobileNetV2', {
      modelDefinitions: [MobileNetV2Model]
    })
      .then(m => { nsfwModel = m; return m; })
      // A transient startup failure must not poison every later image forever.
      .catch(e => { nsfwLoadingPromise = null; throw e; });
  }
  return nsfwLoadingPromise;
}

function dataUrlToBitmap(dataUrl) {
  return fetch(dataUrl).then(r => r.blob()).then(b => createImageBitmap(b));
}

/**
 * Fetch an image from the open web. Tries progressively more privileged
 * strategies and returns the first that yields decodable image bytes.
 */
async function fetchBitmap(url, referer) {
  const blob = await fetchImageBlob(url, referer, { budgetMs: FETCH_BUDGET_MS, attemptMs: FETCH_ATTEMPT_MS });
  return createImageBitmap(blob);
}

/** Downscale huge images before decode — protects the offscreen doc's memory. */
async function shrink(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  if (w <= MAX_EDGE && h <= MAX_EDGE) return bitmap;
  const scale = MAX_EDGE / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const c = new OffscreenCanvas(nw, nh);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, nw, nh);
  bitmap.close?.();
  return createImageBitmap(c);
}

/**
 * Pure NSFW decision from nsfwjs class probabilities. Extracted (and exported)
 * so the threshold policy is unit-testable without loading a 4M-parameter model
 * — see scripts/check-logic.mjs.
 *
 * Policy (calibrated against false positives on ordinary photos, see README):
 *   BLOCK  porn/hentai >= block (0.70)
 *   FLAG   porn/hentai >= flag (0.50) OR sexy >= sexyFlag (0.85)
 * `sexy` runs hot on ordinary pictures (0.4-0.6), so it needs a high bar.
 * `drawings` is never flagged — anime/art false-positive.
 */
export function decideNsfw(byClass, cfg = PROFILES.image.nsfw) {
  const { blockClasses, block, flag, sexyFlag } = cfg;
  const blockScore = Math.max(0, ...blockClasses.map(c => byClass[c] ?? 0));
  if (blockScore >= block) {
    return { action: 'block', detail: { scores: byClass, nsfwScore: blockScore } };
  }
  if (blockScore >= flag || (byClass.sexy ?? 0) >= sexyFlag) {
    return { action: 'flag', detail: { scores: byClass, nsfwScore: Math.max(blockScore, byClass.sexy ?? 0) } };
  }
  return { action: 'clean', detail: { scores: byClass } };
}

/**
 * Convert NSFWJS's real labels (`Drawing`, `Hentai`, `Neutral`, `Porn`,
 * `Sexy`) to the canonical keys used by PROFILES. The previous implementation
 * copied the labels verbatim, then looked up lowercase keys, so every genuine
 * model score read as zero and unsafe images were silently marked clean.
 */
export function normalizeNsfwPredictions(predictions) {
  const scores = { drawings: 0, hentai: 0, neutral: 0, porn: 0, sexy: 0 };
  for (const prediction of Array.isArray(predictions) ? predictions : []) {
    let key = String(prediction?.className ?? '').trim().toLowerCase();
    if (key === 'drawing') key = 'drawings';
    if (!(key in scores)) continue;
    const probability = Number(prediction?.probability);
    if (!Number.isFinite(probability)) continue;
    scores[key] = Math.max(scores[key], Math.min(1, Math.max(0, probability)));
  }
  return scores;
}

function strongestImageDecision(nsfwDecision, violenceDecision) {
  const rank = { clean: 0, flag: 1, block: 2 };
  const strongest = rank[violenceDecision.action] > rank[nsfwDecision.action]
    ? violenceDecision
    : nsfwDecision;
  const result = {
    action: strongest.action,
    source: 'image',
    detail: {
      detector: strongest.detail?.detector ?? (strongest === violenceDecision ? 'violence-gore' : 'nsfw'),
      nsfw: nsfwDecision.detail,
      violence: violenceDecision.detail
    }
  };
  // A clean result is cacheable only when both detectors really ran. Without
  // this top-level marker, a one-off model failure became a permanent clean
  // cache entry for the image URL.
  if (result.action === 'clean' && [nsfwDecision, violenceDecision]
    .some(v => /failed|no-valid|not-run/.test(String(v.detail?.reason ?? '')))) {
    result.reason = 'classify-failed';
  }
  return result;
}

/**
 * @param {string|null} url       absolute image URL (may be null for warm-up)
 * @param {function} progress
 * @param {string|null} referer   page URL, sent as Referer for hotlink protection
 * @param {string|null} dataUrl   optional data: URL captured in the page
 */
export async function classifyImage(url, progress, referer = null, dataUrl = null) {
  if (!url && !dataUrl) {
    // Warm both independent models. One unavailable detector must not prevent
    // the other from protecting the page; fail only if both fail.
    const warmed = await Promise.allSettled([loadNsfwModel(), warmViolenceModel()]);
    if (warmed.every(x => x.status === 'rejected')) {
      throw new Error('all image safety models failed to load');
    }
    return {
      action: 'clean', source: 'image',
      detail: { warmed: true, nsfw: warmed[0].status, violence: warmed[1].status }
    };
  }
  // Start model loading before transport/decode and overlap both startup paths.
  const nsfwPromise = loadNsfwModel();
  const violenceWarmPromise = warmViolenceModel();
  if (progress) progress?.('image', 0.5);

  let bitmap;
  try {
    // Prefer the pixels the page already has. Falls back to a network fetch.
    bitmap = dataUrl ? await dataUrlToBitmap(dataUrl) : await fetchBitmap(url, referer);
    console.log('[SS][IMAGE]', `nsfw decode ok: ${bitmap.width}x${bitmap.height}` +
      (dataUrl ? ` (dataUrl ${dataUrl.length} chars)` : ''));
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      console.debug('[SS][IMAGE] fetch timed out; media pass will retry');
    } else {
      console.warn('[SS][IMAGE]', 'nsfw source unusable (non-fatal, OCR/text unaffected):', String(e?.message ?? e));
    }
    return { action: 'clean', source: 'image', reason: 'fetch-failed', detail: { reason: 'fetch-failed', failure: imageSourceFailure(e) } };
  }

  let nsfwDecision = { action: 'clean', detail: { detector: 'nsfw', reason: 'not-run' } };
  let violenceDecision = { action: 'clean', detail: { detector: 'violence-gore', reason: 'not-run' } };
  try {
    bitmap = await shrink(bitmap);
    // Keep the bitmap alive until both consumers finish. They use separate
    // canvases/tensors and can safely run concurrently.
    const [nsfwResult, violenceResult] = await Promise.allSettled([
      nsfwPromise.then(m => m.classify(bitmap, 5)),
      violenceWarmPromise.then(() => classifyViolence(bitmap))
    ]);

    if (nsfwResult.status === 'fulfilled' && Array.isArray(nsfwResult.value) && nsfwResult.value.length) {
      const byClass = normalizeNsfwPredictions(nsfwResult.value);
      const hasSignal = Object.values(byClass).some(v => v > 0);
      if (hasSignal) {
        const decision = decideNsfw(byClass);
        nsfwDecision = { ...decision, detail: { detector: 'nsfw', ...decision.detail } };
      } else {
        nsfwDecision = { action: 'clean', detail: { detector: 'nsfw', reason: 'no-valid-predictions' } };
      }
    } else {
      nsfwDecision = {
        action: 'clean',
        detail: { detector: 'nsfw', reason: 'classify-failed', error: String(nsfwResult.reason ?? 'no-predictions') }
      };
    }

    if (violenceResult.status === 'fulfilled') {
      violenceDecision = violenceResult.value;
    } else {
      violenceDecision = {
        action: 'clean',
        detail: { detector: 'violence-gore', reason: 'classify-failed', error: String(violenceResult.reason) }
      };
    }
  } catch (e) {
    return { action: 'clean', source: 'image', reason: 'classify-failed', detail: { reason: 'classify-failed', error: String(e) } };
  } finally {
    bitmap?.close?.();
  }
  return strongestImageDecision(nsfwDecision, violenceDecision);
}
