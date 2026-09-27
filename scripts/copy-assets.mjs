// Copies runtime asset files (JS worker code + wasm cores) from node_modules
// into public/ so they are bundled into dist/ locally. This guarantees:
//  - tesseract.js worker script + WASM cores are LOCAL (code must never load from CDN)
//  - nsfwjs weights need NO copy: they load through npm module imports (v4)
// Tesseract .traineddata language files are DATA and may be fetched from
// tessdata.projectnaptha.com and cached in IndexedDB (see src/offscreen/ocr.js).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function copyDir(src, dest, filter = null) {
  if (!existsSync(src)) {
    console.warn(`[copy-assets] WARNING: ${src} does not exist — skipping`);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, filter);
    else if (filter && !filter(entry.name)) continue;
    else cpSync(s, d);
  }
}

// tesseract.js worker script + wasm cores (CODE — must be local)
copyDir(join(root, 'node_modules/tesseract.js-core'), join(root, 'public/tesseract'));
mkdirSync(join(root, 'public/tesseract'), { recursive: true });
cpSync(
  join(root, 'node_modules/tesseract.js/dist/worker.min.js'),
  join(root, 'public/tesseract/worker.min.js')
);

console.log('[copy-assets] done: tesseract runtime copied to public/');

// ONNX Runtime WASM (executable code) — must be local, never fetched from CDN.
copyDir(join(root, 'node_modules/@xenova/transformers/dist'), join(root, 'public/ort'), f => f.endsWith('.wasm'));
