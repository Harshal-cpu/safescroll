// OCR via Tesseract.js for meme images.
// COMPLIANCE: the tesseract worker script and WASM cores are bundled LOCALLY
// (public/tesseract/). Only .traineddata language files — pure data — are
// fetched from tessdata.projectnaptha.com and cached in IndexedDB by tesseract.js.
// ENGLISH-ONLY MODE (project decision): 'eng' only. Hindi/Devanagari ('hin')
// can be re-added later — the langPath already serves it; PaddleOCR fallback
// for stylized Devanagari remains OPTIONAL POLISH (documented, not built).
import { createWorker } from 'tesseract.js';

let worker = null;
let loadingPromise = null;

async function load(progress) {
  if (worker) return worker;
  if (!loadingPromise) {
    loadingPromise = createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      workerBlobURL: false, // REQUIRED: blob workers can't importScripts chrome-extension:// URLs — spawn the worker directly from the extension URL
      corePath: chrome.runtime.getURL('tesseract'),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: m => m?.progress != null && progress?.('ocr', m.progress)
    }).then(w => { worker = w; return w; });
  }
  return loadingPromise;
}

export async function runOCR(url, progress) {
  if (!url) {
    await load(progress); // warm-up
    return '';
  }
  try {
    const w = await load(progress);
    const blob = await (await fetch(url, { credentials: 'omit' })).blob();
    const { data } = await w.recognize(blob);
    return data?.confidence != null && data.confidence < 35 ? '' : (data?.text || '');
    // Below 35% mean confidence the text is unreliable — return empty rather
    // than misclassify. (If Tesseract confidence proves visibly poor on stylized
    // Devanagari in testing, add the optional PaddleOCR fallback here.)
  } catch (e) {
    console.warn('[SafeScroll ocr] failed:', e);
    return '';
  }
}
