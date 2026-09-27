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

const MODEL_ID = 'models/toxic-xlmr'; // resolved via env.localModelPath (extension URL)
let tokenizer = null;
let model = null;
let loadingPromise = null;

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

export async function classifyText(text, progress) {
  await load();
  if (progress) progress?.('text', 1);

  const inputs = tokenizer(text, { truncation: true, max_length: 128 });
  const out = await model(inputs);
  const score = sigmoid(Number(out.logits.data[0]));

  // Two severity tiers on one score (calibrated: English identity-hate probe +
  // mild-negativity false-positive control; see eval/RESULTS.md Entry 7):
  const { hate, mild } = PROFILES.text;
  if (score >= hate.block) {
    return { action: 'block', source: 'text', detail: { tier: 'hate', score } };
  }
  if (score >= mild.flag) {
    return { action: 'flag', source: 'text', detail: { tier: 'mild', score } };
  }
  return { action: 'clean', source: 'text', detail: { tier: 'none', score } };
}
