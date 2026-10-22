// Text toxicity via transformers.js, running fully in-browser.
// PRODUCTION CLASSIFIER (since Entry 7, ml/TRAINING-HISTORY.md):
//   unitary/multilingual-toxic-xlm-roberta — bundled LOCALLY at models/toxic-xlmr/
//   (INT8 ONNX, ~266 MB). Replaced Xenova/toxic-bert (failed the English
//   identity-hate probe 2/9; this model scores 8/9).
// CRITICAL ARCHITECTURE NOTES:
//   - num_labels=1 (BCE head): score = sigmoid(logit). The standard
//     text-classification pipeline applies SOFTMAX over 1 logit -> always 1.0,
//     so we use AutoModel + manual sigmoid.
//   - The bundle's tokenizer.json REQUIRES the Metaspace "add_prefix_space":
//     true patch — without it transformers.js v2 tokenizes without the ▁ word
//     marker and scores go wildly wrong (verified: "Jews control the media"
//     0.664 correct vs 0.011 broken). Kept in the bundle + export script.
//   - Weights are DATA; this copy is bundled so no runtime hub fetch at all.
//   - WINDOWING (added): the model truncates at 128 tokens. On the open web,
//     units are frequently longer than that (a 40-post feed, a 3000-word
//     article, a long comment thread). Previously only the first ~100 words
//     were ever scored, so toxicity past that point was invisible. We now split
//     into sentence-aligned windows with overlap and take the MAX score.
import { AutoModel, AutoTokenizer, env } from '@xenova/transformers';
import { PROFILES } from '../shared/profiles.js';

env.allowLocalModels = true;
// CRITICAL: relative model id + localModelPath = extension URL. Passing a full
// chrome-extension:// URL as the id breaks: pathJoin('', url) prepends '/' ->
// '/chrome-extension://...' -> invalid relative fetch (verified in-browser).
env.localModelPath = chrome.runtime.getURL('models/');
env.allowRemoteModels = false; // never touch the HF hub
env.useBrowserCache = false;   // Cache API rejects chrome-extension:// schemes; caching is pointless for a local bundle anyway
// MV3 CSP (script-src 'self') blocks ORT-web's blob workers for WASM
// multithreading ("worker sent an error!" -> importScripts(blob:) denied).
// Single-threaded + no proxy = CSP-clean; costs some inference latency.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');

const MODEL_ID = 'models/toxic-xlmr'; // resolved via env.localModelPath (extension URL)
const MAX_TOKENS = 128;
const CHARS_PER_TOKEN = 3.2;      // conservative estimate for XLM-R on Latin script
const WINDOW_CHARS = Math.floor(MAX_TOKENS * CHARS_PER_TOKEN * 0.72); // keep headroom
const OVERLAP_CHARS = Math.floor(WINDOW_CHARS * 0.25);
// Latency budget. Measured on the real model: ~300ms per 128-token window on
// single-threaded WASM. 12 windows meant a 3.5k-char unit took 3.0s to resolve,
// which is long enough that a user sees the "Checking content…" state as a
// hang. 6 evenly-spaced windows still sample the ENTIRE text (see windowText)
// and halve the worst case; the detector additionally splits long units so
// typical units are 1-2 windows.
const MAX_WINDOWS = 6;

let tokenizer = null;
let model = null;
let loadingPromise = null;
// ONNX WASM is configured single-threaded for MV3 CSP compliance. Serialising
// calls here prevents several content units from contending inside the same
// session and gives each queued unit a predictable sub-second completion time.
let inferenceTail = Promise.resolve();

async function load() {
  if (model) return model;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      tokenizer = await AutoTokenizer.from_pretrained('toxic-xlmr');
      model = await AutoModel.from_pretrained('toxic-xlmr', { quantized: true });
      return model;
    })().catch(e => { loadingPromise = null; throw e; });
  }
  return loadingPromise;
}

const sigmoid = x => 1 / (1 + Math.exp(-x));

/**
 * Split text into sentence-aligned windows.
 *
 * Two regimes:
 *  - text fits the budget: walk with 25% overlap for boundary safety.
 *  - text is longer than MAX_WINDOWS windows: space the windows EVENLY from the
 *    first character to the last, so the whole text is represented. (Walking
 *    with a fixed stride and truncating at MAX_WINDOWS silently dropped
 *    everything past ~2.6k chars — the most toxic sentence is often the last
 *    one, at the bottom of a comment thread.)
 */
export function windowText(text, maxWindows = MAX_WINDOWS) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= WINDOW_CHARS) return [t];

  const stride = WINDOW_CHARS - OVERLAP_CHARS;
  const needed = Math.ceil((t.length - WINDOW_CHARS) / stride) + 1;
  const windows = [];
  let start = 0;

  if (needed <= maxWindows) {
    while (start < t.length && windows.length < maxWindows) {
      const { end, piece } = sliceAtBoundary(t, start, WINDOW_CHARS);
      if (piece) windows.push(piece);
      if (end >= t.length) break;
      const next = Math.max(start + 1, end - OVERLAP_CHARS);
      start = next;
    }
    return windows;
  }

  // Even coverage: last window is anchored so it ends at the final character.
  const evenStride = (t.length - WINDOW_CHARS) / (maxWindows - 1);
  for (let i = 0; i < maxWindows; i++) {
    const from = Math.round(i * evenStride);
    const { piece } = sliceAtBoundary(t, from, WINDOW_CHARS);
    if (piece) windows.push(piece);
  }
  return windows;
}

/** Slice [start, start+len) and extend to a sentence boundary when one is near. */
function sliceAtBoundary(t, start, len) {
  let end = Math.min(t.length, start + len);
  if (end < t.length) {
    const searchFrom = start + Math.floor(len * 0.55);
    const slice = t.slice(searchFrom, end);
    const m = slice.match(/[.!?…]["')\]]?\s|\n+/g);
    if (m && m.length) {
      const last = m[m.length - 1];
      const idx = searchFrom + slice.lastIndexOf(last) + last.length;
      if (idx > start + len * 0.4) end = idx;
    }
  }
  return { end, piece: t.slice(start, end).trim() };
}

async function scoreOne(text) {
  const run = async () => {
    const inputs = tokenizer(text, { truncation: true, max_length: MAX_TOKENS });
    const out = await model(inputs);
    return sigmoid(Number(out.logits.data[0]));
  };
  const result = inferenceTail.then(run, run);
  inferenceTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Score a string with the toxicity model and apply a threshold set.
 *
 * `tierCfg` matters: OCR'd image text is judged with PROFILES.ocr, not
 * PROFILES.text. A meme caption is a different distribution from a tweet —
 * captions are short, imperative and profane ("GO FUCK YOURSELF") rather than
 * identity-directed, so reusing the tweet thresholds reported it as CLEAN and
 * the image was never blurred.
 */
export async function classifyWith(text, { source, tierCfg, progress } = {}) {
  await load();
  if (progress) progress?.('text', 1);

  const windows = windowText(text);
  if (!windows.length) {
    return { action: 'clean', source, detail: { tier: 'none', score: 0 } };
  }

  const cfg = tierCfg ?? PROFILES.text;
  const { hate, mild } = cfg;
  let best = 0;
  let bestWindow = windows[0];
  for (let i = 0; i < windows.length; i++) {
    const s = await scoreOne(windows[i]);
    if (s > best) { best = s; bestWindow = windows[i]; }
    // EARLY EXIT: we only need the maximum, and `hate.block` is the ceiling of
    // the decision. Once a window crosses it, no later window can change the
    // verdict, so stop instead of paying another ~300ms per window. This is
    // what makes the *slowest-to-detect* content (the content the user is
    // waiting to be blurred) resolve fastest: 1 window instead of 6.
    if (best >= hate.block) {
      return {
        action: 'block', source,
        detail: { tier: 'hate', score: best, windows: i + 1, earlyExit: true, window: bestWindow.slice(0, 240) }
      };
    }
  }

  // Two severity tiers on one score (calibrated: English identity-hate probe +
  // mild-negativity false-positive control; see eval/RESULTS.md Entry 7):
  const detail = { tier: 'none', score: best, windows: windows.length, window: bestWindow.slice(0, 240) };
  if (best >= hate.block) {
    return { action: 'block', source, detail: { ...detail, tier: 'hate' } };
  }
  if (best >= mild.flag) {
    return { action: 'flag', source, detail: { ...detail, tier: 'mild' } };
  }
  return { action: 'clean', source, detail };
}

/** Tweet/comment/caption text — uses PROFILES.text thresholds. */
export async function classifyText(text, progress) {
  return classifyWith(text, { source: 'text', tierCfg: PROFILES.text, progress });
}

/**
 * Meme text read off an image — uses PROFILES.ocr thresholds, which are
 * deliberately more sensitive (see PROFILES.ocr).
 */
export async function classifyOcrText(text, progress) {
  return classifyWith(text, { source: 'ocr-text', tierCfg: PROFILES.ocr, progress });
}
