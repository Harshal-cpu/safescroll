// Violence and graphic-content classifier.
//
// Model: abhi099k/image-multi-detect, revision
// bc2e3ac9e09f12fc9f96187ba3c90a26292d2b52 (MIT), quantized locally to
// signed INT8. It is an eight-label ResNet-50; this tier uses only violence,
// weapon and sensitive. The model card defines violence as physical harm,
// fighting and blood, and sensitive as medical/blood contexts.
import * as ort from 'onnxruntime-web';
import { PROFILES } from '../shared/profiles.js';

const MODEL_URL = chrome.runtime.getURL('models/image-safety/model-int8.onnx');
const SIZE = 224;
const LABELS = ['nsfw', 'violence', 'weapon', 'smoking', 'alcohol', 'drugs', 'sensitive', 'hate'];
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// MV3 disallows the blob worker used by ORT's default multi-threaded mode.
// Use the same local single-threaded WASM runtime as the text classifier.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let session = null;
let loadingPromise = null;
let inferenceTail = Promise.resolve();

async function load() {
  if (session) return session;
  if (!loadingPromise) {
    loadingPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    })
      .then(value => { session = value; return value; })
      .catch(e => { loadingPromise = null; throw e; });
  }
  return loadingPromise;
}

export async function warmViolenceModel() {
  await load();
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

/** Map eight raw model logits to named, bounded probabilities. */
export function scoresFromViolenceLogits(logits) {
  const scores = {};
  for (let i = 0; i < LABELS.length; i++) {
    const value = Number(logits?.[i]);
    scores[LABELS[i]] = Number.isFinite(value) ? sigmoid(value) : 0;
  }
  return scores;
}

/** Pure violence/gore policy; exported for regression tests. */
export function decideViolence(scores, cfg = PROFILES.image.violence) {
  const violence = Math.min(1, Math.max(0, Number(scores?.violence) || 0));
  const sensitive = Math.min(1, Math.max(0, Number(scores?.sensitive) || 0));
  const weapon = Math.min(1, Math.max(0, Number(scores?.weapon) || 0));
  // Both labels explicitly contain blood. Their geometric mean behaves like a
  // soft AND: a strong joint signal is graphic/gore, while `sensitive` alone
  // (for example, a benign medical diagram) cannot trigger the gore rule.
  const goreScore = Math.sqrt(violence * sensitive);
  const detail = {
    detector: 'violence-gore',
    scores: { violence, sensitive, weapon },
    violenceScore: violence,
    goreScore
  };

  if (violence >= cfg.block || goreScore >= cfg.goreBlock) {
    return { action: 'block', detail };
  }
  if (violence >= cfg.flag || goreScore >= cfg.goreFlag || weapon >= cfg.weaponFlag) {
    return { action: 'flag', detail };
  }
  return { action: 'clean', detail };
}

function bitmapToTensor(bitmap) {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  // Preserve the entire frame. Social images are often very wide/tall and the
  // harmful content can sit outside a centre crop.
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const data = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    data[i] = (pixels[p] / 255 - MEAN[0]) / STD[0];
    data[plane + i] = (pixels[p + 1] / 255 - MEAN[1]) / STD[1];
    data[plane * 2 + i] = (pixels[p + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
}

export async function classifyViolence(bitmap) {
  const current = await load();
  const input = bitmapToTensor(bitmap);
  // ORT WASM is single-threaded. Serialisation prevents simultaneous feed
  // images from contending inside one session and producing latency spikes.
  const run = async () => {
    const output = await current.run({ [current.inputNames[0]]: input });
    const tensor = output[current.outputNames[0]];
    if (!tensor?.data || tensor.data.length < LABELS.length) {
      throw new Error('violence model returned an invalid output');
    }
    return decideViolence(scoresFromViolenceLogits(tensor.data));
  };
  const result = inferenceTail.then(run, run);
  inferenceTail = result.then(() => undefined, () => undefined);
  return result;
}
