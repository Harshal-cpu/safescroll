// NSFW image detection via nsfwjs (TensorFlow.js), fully on-device.
// Model weights ship INSIDE the extension bundle via the npm package's own
// module imports (nsfwjs v4 'MobileNetV2') — zero runtime fetch for this
// classifier, no web_accessible_resources needed.
// NOTE: the old filename/URL substring check was DELETED when this was wired in
// (Phase 1); nothing else inspects URLs as a proxy for content.
import * as nsfwjs from 'nsfwjs';
import { PROFILES } from '../shared/profiles.js';

let model = null;
let loadingPromise = null;

async function load() {
  if (model) return model;
  if (!loadingPromise) {
    loadingPromise = nsfwjs.load('MobileNetV2').then(m => { model = m; return m; });
  }
  return loadingPromise;
}

async function fetchBitmap(url) {
  const blob = await (await fetch(url, { credentials: 'omit' })).blob();
  return createImageBitmap(blob);
}

export async function classifyImage(url, progress) {
  if (!url) {
    // Warm-up call
    await load();
    return { action: 'clean', source: 'image', detail: { warmed: true } };
  }
  const m = await load();
  let bitmap;
  try {
    bitmap = await fetchBitmap(url);
  } catch (e) {
    return { action: 'clean', source: 'image', detail: { reason: 'fetch-failed', error: String(e) } };
  }
  const preds = await m.classify(bitmap, 5);
  bitmap.close?.();

  const byClass = Object.fromEntries(preds.map(p => [p.className, p.probability]));
  const { blockClasses, block, flag, sexyFlag } = PROFILES.image.nsfw;
  const blockScore = Math.max(0, ...blockClasses.map(c => byClass[c] ?? 0));

  if (blockScore >= block) {
    return { action: 'block', source: 'image', detail: { scores: byClass, nsfwScore: blockScore } };
  }
  // Flag tier (conservative to avoid blurring normal photos):
  //   porn/hentai >= flag, OR 'sexy' >= sexyFlag (it runs hot on normal photos)
  if (blockScore >= flag || (byClass.sexy ?? 0) >= sexyFlag) {
    return { action: 'flag', source: 'image', detail: { scores: byClass, nsfwScore: Math.max(blockScore, byClass.sexy ?? 0) } };
  }
  return { action: 'clean', source: 'image', detail: { scores: byClass } };
}
