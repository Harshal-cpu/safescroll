// OCR via Tesseract.js for meme text.
//
// COMPLIANCE: the tesseract worker script and WASM cores are bundled LOCALLY
// (public/tesseract/). Only .traineddata language files — pure data — are
// fetched from tessdata.projectnaptha.com and cached in IndexedDB by tesseract.js.
// ENGLISH-ONLY MODE (project decision): 'eng' only.
//
// WHY OCR USED TO FAIL ON REAL MEMES — the observed failure was a photo of a
// sign reading "GO FUCK YOURSELF": large white glyphs on a black plate, in a
// busy photographic background (foliage, blurred road). Five distinct causes,
// each addressed below:
//
//  1. POLARITY. Tesseract's training data is overwhelmingly BLACK text on a
//     WHITE background. White-on-black meme text is out-of-distribution and
//     frequently recognises as noise. We now try an INVERTED variant.
//  2. NO BINARISATION. A linear contrast stretch on a photo leaves the
//     background mid-grey, so the layout analyser segments leaves as glyphs.
//     Otsu thresholding separates ink from paper far more decisively.
//  3. WRONG PAGE SEGMENTATION. The default assumes a uniform page of body text.
//     A sign is a single uniform block, so PSM 6 beats PSM 11; sparse text
//     (PSM 11) suits a caption scattered over an image. We try both.
//  4. FIRST-PASS-WINS. The old code returned the first pass that produced any
//     text above the confidence floor — so a hallucinatory pass over the
//     background could win and the real sign was never read. We now score every
//     pass and keep the best, escalating only when nothing good is found.
//  5. NO PLAUSIBILITY CHECK. Background "text" is long, high-confidence and
//     garbage. Length and confidence alone therefore reward noise. Every
//     candidate is scored for whether it looks like language, and implausible
//     strings are rejected even when Tesseract is confident about them.
//
// THE BUG THAT BROKE OCR ENTIRELY (fixed): `runPass` used to hand an
// ImageBitmap to `w.recognize()`. tesseract.js's browser-side `loadImage()` has
// no ImageBitmap branch, so `new Uint8Array(imageBitmap)` silently produced a
// ZERO-LENGTH buffer, which leptonica reported as "truncated file" and then
// threw "Error attempting to read image." — for EVERY image, valid or not.
// `makeVariant` now returns an OffscreenCanvas, which loadImage does support.
// The second failure mode (InvalidStateError: the source image could not be
// decoded) was a non-image blob (an HTML error page / cookie wall) reaching
// `createImageBitmap`; `validateImageBlob` now rejects those before any pass.
//
// Runs OFF the critical path (MSG.CLASSIFY_MEDIA, after the text verdict has
// already been applied) and behind a bounded worker queue, so none of this can
// delay a text blur.
import { createWorker, PSM } from 'tesseract.js';
import { mediaSourceKey } from '../shared/mediaFingerprint.js';
import { fetchImageBlob, imageSourceFailure } from './imageSource.js';

const FETCH_BUDGET_MS = 3000;
const FETCH_ATTEMPT_MS = 1500;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_CONFIDENCE = 25;
const MIN_TEXT_CHARS = 4;
const OCR_MAX_EDGE = 1100;
const OCR_MAX_SOURCE_PIXELS = 40_000_000;
const GOOD_SCORE = 0.40;   // above this we stop escalating

// ------------------------------------------------------------- debug logging
// Off by default so production never prints recognised text (that IS the user's
// page content). Enable with either:
//   * in the offscreen doc: globalThis.__SS_DEBUG__ = true
//   * or localStorage.setItem('ss-debug', '1')
// Metadata (MIME, size, dimensions, pass outcomes) is always safe to log.
let OCR_DEBUG = false;
try {
  OCR_DEBUG = globalThis.__SS_DEBUG__ === true ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('ss-debug') === '1');
} catch { /* storage unavailable */ }

const imgLog = (...a) => console.log('[SS][IMAGE]', ...a);
const ocrLog = (...a) => console.log('[SS][OCR]', ...a);
const ocrWarn = (...a) => console.warn('[SS][OCR]', ...a);
/** Content-bearing log — only when debugging. */
const ocrDebug = (...a) => { if (OCR_DEBUG) console.log('[SS][OCR]', ...a); };

// -------------------------------------------------------- source deduplication
// A URL that served undecodable bytes will serve them again on every scroll.
// Remember failures (and successful reads) per source so a single broken image
// costs one attempt, not one per intersection.
const MAX_SOURCE_CACHE = 250;
const ocrBadSources = new Set();   // validated-as-invalid sources
const ocrTextCache = new Map();    // source -> extracted text ('' = ran cleanly, no usable text)

function rememberBad(key) {
  if (ocrBadSources.size >= MAX_SOURCE_CACHE) ocrBadSources.delete(ocrBadSources.values().next().value);
  ocrBadSources.add(key);
}
function rememberText(key, text) {
  if (ocrTextCache.size >= MAX_SOURCE_CACHE) ocrTextCache.delete(ocrTextCache.keys().next().value);
  ocrTextCache.set(key, text);
}

/** Stable, cheap identity for an OCR source (URL, or bytes of a data: URL). */
export function ocrSourceKey(url, dataUrl) {
  return `s:${mediaSourceKey({ url, dataUrl })}`;
}

/** True if this source was already proven undecodable. */
export function isKnownBadOcrSource(key) {
  return ocrBadSources.has(key);
}

/**
 * Session-cached OCR text for a source, or undefined when it was never read.
 * '' is a REAL result ("read cleanly, no usable text") — a deterministic
 * outcome of this image — so callers must distinguish it from a cache miss.
 *
 * Callers check this before queue admission to avoid repeat OCR work.
 */
export function getCachedOcrText(key) {
  return ocrTextCache.get(key);
}

let worker = null;
let loadingPromise = null;

// Tesseract has one worker with mutable page-segmentation settings. Keep its
// setParameters/recognize pairs sequential, and share an unfinished read when
// the same image is requested again after a media-pass timeout.
export function createOcrScheduler(maxPending = 12) {
  maxPending = Math.max(1, Math.floor(maxPending));
  const pending = new Map();
  const queue = [];
  const capacityListeners = new Set();
  let active = 0;
  function drain() {
    if (active || !queue.length) return;
    queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
    const job = queue.shift();
    active = 1;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      active = 0;
      pending.delete(job.key);
      job.signal?.removeEventListener('abort', job.abort);
      for (const listener of capacityListeners) { try { listener(); } catch { /* observer */ } }
      drain();
    });
  }
  function cancelQueued(key) {
    const index = queue.findIndex(job => job.key === key);
    if (index < 0) return false; // a running Tesseract call cannot be cancelled safely
    const [job] = queue.splice(index, 1);
    job.signal?.removeEventListener('abort', job.abort);
    pending.delete(key);
    job.reject(new Error('ocr-cancelled'));
    for (const listener of capacityListeners) { try { listener(); } catch { /* observer */ } }
    return true;
  }
  let order = 0;
  return {
    pending: key => pending.get(key),
    position: key => queue.findIndex(job => job.key === key) + 1,
    stats: () => ({ active, queued: queue.length, capacity: maxPending, available: pending.size < maxPending }),
    onCapacity(listener) { capacityListeners.add(listener); return () => capacityListeners.delete(listener); },
    cancelQueued,
    cancelAllQueued() { for (const job of [...queue]) cancelQueued(job.key); },
    run(key, task, { priority = 0, signal } = {}) {
      if (pending.has(key)) {
        const queued = queue.find(job => job.key === key);
        if (queued) queued.priority = Math.max(queued.priority, priority);
        return pending.get(key);
      }
      if (signal?.aborted) return Promise.reject(new Error('ocr-cancelled'));
      if (pending.size >= maxPending) return Promise.reject(new Error('ocr-capacity-full'));
      let resolve, reject;
      const result = new Promise((res, rej) => { resolve = res; reject = rej; });
      pending.set(key, result);
      const job = { key, task, resolve, reject, priority, order: order++, signal,
        abort: () => cancelQueued(key) };
      signal?.addEventListener('abort', job.abort, { once: true });
      queue.push(job);
      queueMicrotask(drain);
      return result;
    }
  };
}

const ocrScheduler = createOcrScheduler();

export function getPendingOcrText(key) {
  return ocrScheduler.pending(key);
}
export const getOcrQueueState = () => ocrScheduler.stats();
export const getOcrQueuePosition = key => ocrScheduler.position(key);
export const onOcrCapacity = listener => ocrScheduler.onCapacity(listener);
export const cancelQueuedOcr = () => ocrScheduler.cancelAllQueued();

async function load(progress) {
  if (worker) return worker;
  if (!loadingPromise) {
    loadingPromise = createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      workerBlobURL: false // REQUIRED: blob workers can't importScripts chrome-extension:// URLs
      ,
      corePath: chrome.runtime.getURL('tesseract'),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: m => { try { m?.progress != null && progress?.('ocr', m.progress); } catch { /* progress sink must never break OCR */ } },
      // tesseract.js invokes this for errors raised inside its own plumbing.
      // Without it they surface as bare "Uncaught Error" in the offscreen
      // console and look like a crash of the whole document.
      errorHandler: e => ocrWarn('tesseract worker error (non-fatal):', String(e?.message ?? e))
    }, {
      // Tiny decorative components in memes can trigger hundreds of native
      // "Image too small to scale" diagnostics even when recognition succeeds.
      // Redirect only Tesseract's diagnostic stream; worker/pass failures still
      // reach errorHandler and runPass.
      debug_file: '/dev/null'
    }).then(w => { worker = w; return w; })
      .catch(e => { loadingPromise = null; throw e; });
  }
  return loadingPromise;
}

async function fetchBlob(url, referer) {
  return fetchImageBlob(url, referer, { budgetMs: FETCH_BUDGET_MS, attemptMs: FETCH_ATTEMPT_MS });
}

/** data: URL -> Blob, without assuming the payload is well-formed. */
async function dataUrlToBlob(dataUrl) {
  if (!/^data:image\//i.test(dataUrl) && !/^data:application\/octet-stream/i.test(dataUrl)) {
    throw new Error(`unsupported data url prefix: ${String(dataUrl).slice(0, 40)}`);
  }
  const resp = await fetch(dataUrl);
  if (!resp.ok) throw new Error(`data url fetch failed: ${resp.status}`);
  return resp.blob();
}

// --------------------------------------------------------- image validation
// Magic bytes — catches HTML/JSON/empty responses that claim to be images.
const MAGIC = [
  ['png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47],
  ['jpeg', b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF],
  ['gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ['bmp', b => b[0] === 0x42 && b[1] === 0x4D],
  ['webp', b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50]
];

function sniffFormat(head) {
  for (const [name, test] of MAGIC) { try { if (test(head)) return name; } catch { /* short buffer */ } }
  return null;
}

/**
 * Validate a fetched image BEFORE Tesseract ever sees it.
 *
 * Returns { ok:true, bitmap, width, height, format, bytes } — with the image
 * decoded exactly ONCE, to be shared by every pass in the ladder — or
 * { ok:false, reason } when the bytes are empty, oversized, not an image, or
 * undecodable. The caller must never hand a `!ok` result to Tesseract.
 */
export async function validateImageBlob(blob) {
  if (!blob || typeof blob.size !== 'number') return { ok: false, reason: 'no-blob' };
  if (blob.size === 0) return { ok: false, reason: 'empty-blob (0 bytes)' };
  if (blob.size > MAX_BYTES) return { ok: false, reason: `too-large (${blob.size} > ${MAX_BYTES})` };
  if (blob.type && !blob.type.startsWith('image/') && !blob.type.includes('octet-stream')) {
    return { ok: false, reason: `non-image MIME: ${blob.type}` };
  }

  let head;
  try {
    head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  } catch (e) {
    return { ok: false, reason: `head-read failed: ${e?.message ?? e}` };
  }
  const format = sniffFormat(head);
  if (!format) {
    return { ok: false, reason: 'unrecognised-image-bytes' };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    return { ok: false, reason: `decode failed: ${e?.name ?? ''} ${e?.message ?? e}` };
  }
  if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) ||
      bitmap.width <= 0 || bitmap.height <= 0 ||
      bitmap.width * bitmap.height > OCR_MAX_SOURCE_PIXELS) {
    bitmap.close?.();
    return { ok: false, reason: 'invalid-or-oversized-dimensions' };
  }
  return { ok: true, bitmap, width: bitmap.width, height: bitmap.height, format, bytes: blob.size };
}


// ------------------------------------------------------------- preprocessing
function toGrayscale(px) {
  for (let i = 0; i < px.length; i += 4) {
    const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    px[i] = px[i + 1] = px[i + 2] = y;
  }
}

function invert(px) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255 - px[i];
    px[i + 1] = 255 - px[i + 1];
    px[i + 2] = 255 - px[i + 2];
  }
}

/** Otsu's method: the threshold that maximises between-class variance. */
function otsuThreshold(px) {
  const hist = new Float64Array(256);
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) hist[px[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function binarize(px, thr) {
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i] > thr ? 255 : 0;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
}

/**
 * Build one preprocessed variant of the source image.
 *
 * RETURNS AN OffscreenCanvas, NOT an ImageBitmap. This is the fix for the
 * pipeline-breaking bug: tesseract.js's browser `loadImage()` (createWorker.js
 * calls it before every `recognize`) only understands string / HTMLElement /
 * OffscreenCanvas / File / Blob. It has no ImageBitmap branch, so passing one
 * falls through to `new Uint8Array(imageBitmap)` which yields a ZERO-LENGTH
 * array. Tesseract then wrote 0 bytes to /input and leptonica rejected it:
 *
 *   Error in findFileFormatStream: truncated file
 *   Image file /input cannot be read!
 *   Uncaught Error: Error attempting to read image.
 *
 * OffscreenCanvas IS handled — `loadImage` calls `convertToBlob()` on it and
 * hands Tesseract real PNG bytes.
 */
export function ocrCanvasDimensions(w0, h0, upscale = false) {
  if (!Number.isSafeInteger(w0) || !Number.isSafeInteger(h0) || w0 <= 0 || h0 <= 0) {
    throw new Error('invalid-ocr-source-dimensions');
  }
  let scale = 1;
  const longEdge = Math.max(w0, h0);
  if (longEdge > OCR_MAX_EDGE) scale = OCR_MAX_EDGE / longEdge;
  else if (upscale && longEdge < 700) scale = Math.min(2.5, 900 / longEdge);

  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) {
    throw new Error('invalid-ocr-canvas-dimensions');
  }
  return { width: w, height: h };
}

async function makeVariant(bitmap, { mode, upscale }) {
  const { width: w, height: h } = ocrCanvasDimensions(bitmap.width, bitmap.height, upscale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('ocr-canvas-unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);

  let img;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch {
    return canvas;
  }
  const px = img.data;
  toGrayscale(px);

  if (mode === 'invert') {
    invert(px);
  } else if (mode === 'otsu') {
    binarize(px, otsuThreshold(px));
  } else if (mode === 'otsu-invert') {
    binarize(px, otsuThreshold(px));
    invert(px);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --------------------------------------------------------------- plausibility
/**
 * Does this string look like language rather than background noise?
 *
 * Background "text" is typically long, confidently recognised, and made of
 * glyph-like fragments with no vowels and few spaces — so scoring by length or
 * confidence alone actively selects it. This scores shape instead.
 */
export function plausibility(text) {
  const t = String(text || '').trim();
  if (t.length < MIN_TEXT_CHARS) return 0;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const alphaRatio = letters / t.length;
  if (alphaRatio < 0.45) return 0;

  const words = t.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
  if (!words.length) return 0;

  // Real words contain a vowel. A run of consonants is a barcode, not text.
  const withVowel = words.filter(w => /[aeiouyAEIOUY]/.test(w)).length;
  const vowelRatio = withVowel / words.length;
  if (vowelRatio < 0.5) return 0;

  // Two-letter "words" are rare in real prose (a, an, as, at, be, by, do, go,
  // he, if, in, is, it, me, my, no, of, on, or, so, to, up, us, we) but
  // extremely common in background noise ("ee nn rt lt"). Requiring short
  // tokens to be on that list is what separates foliage from language, and it
  // leaves meme shorthand like "I LUV U" intact.
  const SHORT_OK = new Set(['a','i','an','as','at','be','by','do','go','he','if','in','is','it','me','my','no','of','on','or','so','to','up','us','we','ya','ok','oh','im','ur','thx','yo','no','am','pm','id','tv','pc','ok']);
  let suspicious = 0;
  for (const w of words) {
    const core = w.replace(/[^A-Za-z]/g, '').toLowerCase();
    if (core.length <= 2 && !SHORT_OK.has(core)) suspicious++;
  }
  if (suspicious / words.length > 0.4) return 0;

  // Word-length sanity. Hard-reject only on true fragments, and score down
  // rather than reject for merely short words — real meme text includes
  // things like "I LUV U" that a strict length gate would discard.
  const meanLen = words.reduce((a, w) => a + w.replace(/[^A-Za-z]/g, '').length, 0) / words.length;
  if (meanLen < 1.4) return 0;

  // Penalise absurd repetition of one glyph (fence texture, railings).
  const longestRun = (t.match(/(.)\1{3,}/g) || []).length;
  if (longestRun > 2) return 0;

  let s = 0.35;
  s += 0.25 * Math.min(1, vowelRatio);
  s += 0.20 * Math.min(1, meanLen / 4);
  s += 0.20 * Math.min(1, words.length / 2);
  return Math.min(1, s);
}

function scoreCandidate({ text, conf }, psm, mode) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const plaus = plausibility(clean);
  if (!plaus) return null;
  // Confidence is a multiplier, plausibility the gate. A confident but
  // implausible read scores zero, which is what keeps background noise out.
  const confF = Math.max(0, Math.min(1, conf / 100));
  return { text: clean, conf, psm, mode, plaus, score: plaus * (0.4 + 0.6 * confF) };
}

/**
 * One preprocessed pass. `source` is the SHARED, already-validated decoded
 * bitmap — it is not closed here, it is closed once by runOCR after the ladder.
 */
async function runPass(w, source, mode, psm, upscale) {
  let variant = null;
  try {
    variant = await makeVariant(source, { mode, upscale });
    await w.setParameters({ tessedit_pageseg_mode: psm });
    // Moderation needs only text and mean confidence. Tesseract.js otherwise
    // also builds block, hOCR, and TSV output for every pass.
    const { data } = await w.recognize(variant, {}, {
      text: true, blocks: false, hocr: false, tsv: false
    });
    return { candidate: scoreCandidate({ text: data?.text, conf: data?.confidence ?? 0 }, psm, mode), failed: false };
  } catch (e) {
    // Non-fatal: one bad pass must never take down the ladder or the document.
    ocrWarn(`pass failed (${mode}/${psm}):`, String(e?.message ?? e));
    return { candidate: null, failed: true };
  } finally {
    variant?.close?.();
  }
}

/**
 * Escalating pass ladder. Ordered by (likelihood × cost): the cheap and most
 * likely variant goes first and normally wins, so the common case stays fast;
 * the expensive binarised/inverted passes only run when the earlier ones
 * produced nothing plausible.
 */
// `upscale: true` on every rung is deliberate. makeVariant() only upscales a
// source whose long edge is BELOW 700px, so for anything larger it is a no-op
// and costs nothing. Below that, upscaling used to be reserved for the FINAL
// rung — i.e. a small image was attempted five times at native resolution
// before the one pass that could help. Tesseract surfaced this in the field:
//
//   Image too small to scale!! (2x36 vs min width of 3)
//   Line cannot be recognized!!
//
// on a 648x680 source (long edge 680 < 700 — inside the upscale band), where a
// segmented line was 2px wide and below Tesseract's own minimum scale width.
// Upscaling the first pass moves that segment past the floor immediately
// instead of after five failed attempts.
const PASS_LADDER = [
  { mode: 'gray', psm: PSM.SINGLE_BLOCK, upscale: true },
  { mode: 'invert', psm: PSM.SINGLE_BLOCK, upscale: true },
  { mode: 'gray', psm: PSM.SPARSE_TEXT, upscale: true },
  { mode: 'otsu', psm: PSM.SINGLE_BLOCK, upscale: true }
];

/**
 * Read one image and return its text and explicit completion status. A broken
 * image cannot destabilise the NSFW/text tiers that run alongside it.
 *
 * @param {string|null} url      image URL (null = warm-up)
 * @param {function} progress
 * @param {string|null} referer  page URL for hotlink-protected CDNs
 * @param {string|null} dataUrl  page-captured data: URL (preferred)
 */
export async function runOCRResult(url, progress, referer = null, dataUrl = null, priority = 1) {
  if (!url && !dataUrl) {
    try { await load(progress); } catch (e) { ocrWarn('warm-up failed (non-fatal):', String(e?.message ?? e)); }
    return { status: 'clean', text: '' };
  }

  const key = ocrSourceKey(url, dataUrl);
  if (ocrBadSources.has(key)) {
    ocrDebug('source already known to be undecodable — skipping');
    return { status: 'error', text: '', reason: 'invalid-image' };
  }
  const cached = ocrTextCache.get(key);
  if (cached !== undefined) {
    ocrDebug('source already OCR\'d this session — reusing cached text');
    return { status: 'clean', text: cached, cache: true };
  }
  try {
    let preparedSource;
    if (!ocrScheduler.pending(key)) {
      if (!ocrScheduler.stats().available) return { status: 'deferred', text: '', reason: 'ocr-capacity-full' };
      // Reserve the shared bytes at admission, while the image tier is reading
      // them. Queue delay must not expire the blob cache and force a refetch.
      preparedSource = (dataUrl ? dataUrlToBlob(dataUrl) : fetchBlob(url, referer))
        .then(blob => ({ blob }), error => ({ error }));
    }
    return await ocrScheduler.run(key, () => scanOCR(url, progress, referer, dataUrl, key, preparedSource), { priority });
  } catch (e) {
    return { status: e?.message === 'ocr-capacity-full' ? 'deferred' : 'error', text: '', reason: e?.message ?? 'unknown' };
  }
}

export async function runOCR(url, progress, referer = null, dataUrl = null) {
  return (await runOCRResult(url, progress, referer, dataUrl)).text;
}

async function scanOCR(url, progress, referer, dataUrl, key, preparedSource) {
  const startedAt = performance.now();
  let stage = 'fetch';
  let bitmap = null;
  try {
    imgLog('source:', dataUrl ? 'data URL' : 'URL');
    const source = await preparedSource;
    if (source.error) throw source.error;
    const blob = source.blob;
    imgLog('MIME:', blob.type || '(none)', '| blob size:', blob.size);
    stage = 'worker';
    const w = await load(progress);

    // ---- VALIDATE BEFORE TESSERACT -------------------------------------
    stage = 'decode';
    const v = await validateImageBlob(blob);
    if (!v.ok) {
      rememberBad(key);
      ocrWarn('invalid image - skipping OCR');
      ocrWarn('reason:', v.reason);
      return { status: 'error', text: '', reason: 'invalid-image' };
    }
    bitmap = v.bitmap;
    ocrLog(`image validation successful: ${v.width}x${v.height} (${v.format}, ${v.bytes}B)`);
    ocrLog('starting Tesseract');

    // ---- PASS LADDER (one decode, shared by every pass) ----------------
    stage = 'recognize';
    let best = null;
    let failedPasses = 0;
    for (const pass of PASS_LADDER) {
      const { candidate: cand, failed } = await runPass(w, bitmap, pass.mode, pass.psm, pass.upscale);
      if (failed) failedPasses++;
      if (cand && (!best || cand.score > best.score)) best = cand;
      if (best && best.score >= GOOD_SCORE) break;   // good enough, stop early
    }

    ocrLog(`completed ms=${Math.round(performance.now() - startedAt)}`);
    // A decode + full pass ladder that produced nothing (or only low-confidence
    // noise) is a DETERMINISTIC outcome of this image — it will do so again.
    // Cache it, otherwise text-free images re-run Tesseract on every
    // re-registration and fill the OCR queue with the same picture.
    // (Transient fetch/decode/worker failures in the catch below are NOT
    // cached — those are not proof the source is unreadable.)
    if (failedPasses && (!best || best.conf < MIN_CONFIDENCE)) {
      return { status: 'error', text: '', reason: 'ocr-pass-failed' };
    }
    if (!best) {
      ocrDebug('no pass produced plausible text — caching empty result');
      rememberText(key, '');
      return { status: 'clean', text: '' };
    }
    if (best.conf < MIN_CONFIDENCE) {
      ocrDebug(`best pass confidence ${best.conf} < ${MIN_CONFIDENCE} — discarded, caching empty result`);
      rememberText(key, '');
      return { status: 'clean', text: '' };
    }
    ocrDebug(`extracted text (${best.psm}/${best.mode}, conf ${best.conf}, chars ${best.text.length})`);
    rememberText(key, best.text);
    return { status: 'clean', text: best.text };
  } catch (e) {
    // Fetch/decode/worker failures are NOT proof the source is bad (the worker
    // may simply not have finished loading), so they are not negative-cached —
    // only validateImageBlob()'s deterministic verdicts are.
    const reason = stage === 'fetch' ? imageSourceFailure(e) : `ocr-${stage}-failed`;
    ocrWarn(`unavailable stage=${stage} reason=${reason} ms=${Math.round(performance.now() - startedAt)}`);
    return { status: 'error', text: '', reason };
  } finally {
    bitmap?.close?.();
  }
}
