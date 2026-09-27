# SafeScroll

On-device, privacy-first Chrome MV3 content-moderation extension for Instagram, X/Twitter, and YouTube. **No server-side inference. No user data leaves the browser.** **Current scope: English text + image moderation.** Hinglish/Hindi components are implemented but DISABLED for now (lexicon tier: PROFILES.lexicon.enabled; OCR runs 'eng' only) — see ml/TRAINING-HISTORY.md.

## Stack

- Vite + `@crxjs/vite-plugin` (all ML runtimes installed as npm packages, bundled locally)
- `@xenova/transformers` â€” text toxicity: unitary/multilingual-toxic-xlm-roberta bundled locally (INT8, 266 MB) + lexicon tier (src/shared/lexicon.js, Stage 0)
- `nsfwjs` (TensorFlow.js, MobileNetV2) â€” image NSFW detection
- `tesseract.js` (eng+hin) â€” OCR for meme images, worker/wasm bundled locally

## What runs where

```
content script â”€â”€classifyâ”€â”€â–¶ background SW (relay only) â”€â”€â–¶ offscreen document
                                                            â”œâ”€ textClassifier.js  (transformers.js)
                                                            â”œâ”€ imageClassifier.js (nsfwjs)
                                                            â”œâ”€ ocr.js             (tesseract.js)
                                                            â””â”€ store.js           (IndexedDB verdicts+feedback)
```

Explainable fusion (no learned model): **BLOCK if text.block OR image.block OR ocr-text.block; FLAG if any flag threshold crossed.**

## Build

```bash
npm install
npm run build     # copies tesseract runtime, builds dist/
npm run audit     # grep dist/ for remote-code violations (must be CLEAN)
```

Load `dist/` via chrome://extensions â†’ Developer mode â†’ Load unpacked.

## Eval

```bash
npm run eval:toxicity
```

See `eval/RESULTS.md` for the full history (6 gate runs, all FAIL — root cause: no reachable corpus has Latin-script Hinglish slur supervision; full handoff doc in `ml/TRAINING-HISTORY.md`). **Interim production defense shipped:** the severity-graded lexicon tier (`src/shared/lexicon.js`, 156 block / 38 flag terms) runs as Stage 0 before the ML classifier and OR-fuses into the verdict — deterministic, explainable Hinglish blocking today. The ML path stays unresolved pending: real HASOC **code-mixed track** data (user registered, download pending) and/or `ai4bharat/indic-bert` gate acceptance (403) → retrain → gate → wire in only on PASS. Historical note — documented failures on the 20-sentence gate (P â‰¥ 0.7 AND R â‰¥ 0.7):

1. `Xenova/toxic-bert` zero-shot â€” P=0.000, R=0.000 (wired in ONLY as a labeled weak English-baseline placeholder).
2. `google/muril-base-cased` partial fine-tune (PRISM/MIT corpus substitute â€” HASOC/TRAC originals require manual registration and were not bypassed) â€” P=0.500, R=1.000, no Hinglish discrimination; export also 238 MB (over size target).
3. `microsoft/Multilingual-MiniLM-L12-H384` full fine-tune â€” P=0.000, R=0.000, inverted Hinglish signal; 118 MB export.

Neither fine-tuned model was wired in. Concrete next steps (real HASOC/TRAC registration, Hinglish-majority training, GPU full FT, interim lexicon) are in `eval/RESULTS.md`.

## Documented limitations (accepted, per project scope)

1. **Child Mode PIN**: unsalted, single-round SHA-256 of a 4-digit PIN. Deters casual tampering only; trivially brute-forced offline. Surfaced in the options UI.
2. **Hinglish text coverage**: weak (see eval above); shipped flagged, not silently.
3. **Violence/gore detection**: stretch goal â€” NOT implemented. No placeholder/fake check ships; documented as future work.
4. **PaddleOCR fallback** for stylized/Devanagari meme text: optional polish, not built. Tesseract confidence < 35% returns empty rather than misclassifying.
5. **Retraining**: feedback is logged to IndexedDB and exportable as CSV/JSON for periodic **manual** batch review. No automated retraining pipeline (out of scope).

## Compliance checklist (verified before packaging)

- [x] (a) No CDN `<script>` tags in any HTML file (popup, options, offscreen) â€” all scripts bundled by Vite/CRXJS.
- [x] (b) `npm run audit` (dist/ grep) CLEAN. Review and disposition of every transitive hit:
  - protobufjs `eval` require-shim â€” dead path in browser bundle
  - `new Function("return this")` globalThis polyfills (tfjs/tesseract) â€” dead on Chrome 109+
  - tesseract.js default `workerPath`/core/lang jsDelivr fallbacks â€” overridden with `chrome.runtime.getURL` paths (verified present in bundle)
  - transformers.js `wasmPaths` jsDelivr default for ONNX WASM â€” **overridden**: runtime `.wasm` files bundled locally into `public/ort/` (WASM is code, not data)
  - remaining URL matches are license comments / our own scoped permission patterns
- [x] (c) `host_permissions` scoped to exactly: instagram + cdninstagram/fbcdn, x.com/twitter.com + twimg, youtube + ytimg, huggingface.co (model weights = data), tessdata.projectnaptha.com (.traineddata = data). No `*://*/*`, no `file://`.
- [x] (d) Offscreen handshake: `offscreen.js` registers listener then **immediately posts `{type:'ready'}`**; `ensureOffscreen()` additionally pings with a **20s hard timeout that throws** (never silently passes), 10 retry attempts. IndexedDB writes go through a durable pending-queue (`persistVerdict()` parks the record before writing, clears after); keep-alive alarm (0.5 min) + `chrome.runtime.onSuspend` + `beforeunload` flush. ImageBitmap transport probe runs at offscreen startup and **logs a loud FAIL** when it doesn't survive `chrome.runtime.sendMessage` (it doesn't on Chrome â€” pipeline uses ImageData/dataURL transport instead).
- [x] (e) Hinglish test-set results documented in `eval/RESULTS.md` (P=0.000, R=0.000 â€” flagged, fallback iteration proposed).

## Manual regression pass (requires Chrome)

1. **Throttled-CPU scroll test**: load dist/ unpacked â†’ open x.com or instagram.com â†’ DevTools â†’ Performance â†’ 6Ã— CPU throttle â†’ scroll a virtualized feed for 60s. Expect: smooth scroll, no shield flicker on recycled nodes (registry entries clear on IntersectionObserver leave + element removal).
2. **Offscreen handshake under slow load**: DevTools â†’ Network â†’ Slow 3G â†’ reload extension page. First classification must wait for the explicit PONG; check SW console for `[SafeScroll bg] offscreen handshake OK`. On timeout it must log `[SafeScroll bg FAIL] ... TIMED OUT` â€” never silently proceed.
3. **Anywhere mode**: popup â†’ Enable â†’ Chrome permission prompt must appear; deny â†’ mode stays off and content script is NOT injected on other sites (real gate via `chrome.permissions.request` + `chrome.scripting.registerContentScripts`).
4. **Model loading UI**: fresh profile â†’ open a supported site â†’ floating "loading modelsâ€¦" banner until `models-ready`.

## Registry / DOM correctness

- `genericAdapter` inner queries use `post.querySelectorAll` (post-root scoped), matching Twitter/Instagram adapters.
- Registry entries cleared on MutationObserver-detected removal and IntersectionObserver leave (virtualized-feed safe).
- Instagram fallback post key pads combined text+DOM-position material to >120 chars before hashing (no collisions on short/duplicate captions).
- MutationObserver + IntersectionObserver + 200ms debounce; viewport-only processing.







## UI features

- **Popup**: master on/off switch (persists via chrome.storage.sync), model status badge, session stats (blocked/flagged), Anywhere mode toggle, dashboard link
- **Options dashboard**: live threshold table (rendered from offscreen PROFILES), moderation stats (blocked/flagged/total), feedback export (JSON/CSV), Scroll Lock setting, Child Mode (parent PIN, PIN-gated overrides, state display)
- **In-page**: verdict shields (loading/blocked/flagged states, Show anyway, Report wrong verdict), first-run model-loading banner, Child Mode scroll lock (blocked post freezes page behind a PIN screen; UNSALTED SHA-256 PIN - documented limitation)
- Settings storage: chrome.storage.sync (scrollLock, childMode, enabled)
