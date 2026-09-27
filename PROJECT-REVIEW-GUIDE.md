# SafeScroll — Complete Project Explanation (for Guide / Teacher Review)

> One-line pitch: **SafeScroll is a Chrome extension that detects and blurs toxic text,
> hate speech, NSFW images and meme text on any website — using machine learning that
> runs 100% inside the browser. No servers, no data collection.**

---

## 1. The Problem & Solution

**Problem:** Social media feeds (Instagram, X/Twitter, YouTube) and the open web are full of
toxic comments, hate speech, and NSFW images. Users (and especially children) see this
content involuntarily.

**Solution:** A browser extension that:
- Scans every post/comment/image as it enters the viewport
- Classifies it **on the user's own machine** (privacy by architecture)
- **Blurs** only the toxic part (text OR image — granular), with a one-click reveal
- Has parental controls (Child Lock with PIN, scroll lock, override gating)

---

## 2. High-Level Architecture

```
┌───────────────────────────── CHROME BROWSER ─────────────────────────────┐
│                                                                           │
│  CONTENT SCRIPT (isolated world, runs on every http/https page)           │
│  ├─ Site adapters: Twitter/X, Instagram, YouTube, Generic (all sites)     │
│  ├─ MutationObserver  → detects new posts (feeds load dynamically)        │
│  ├─ IntersectionObserver → only processes posts entering the viewport     │
│  ├─ 200ms debounce + queue → batching, scroll-smoothness                  │
│  ├─ Registry (Map) → dedupe + cleanup on element removal / scroll-away    │
│  └─ Shield UI → blur overlay (backdrop-filter) + pill + buttons           │
│                                                                           │
│  BACKGROUND SERVICE WORKER (MV3, event-driven, short-lived)               │
│  ├─ Message relay: content script ⇄ offscreen                             │
│  ├─ Offscreen readiness HANDSHAKE (ping/pong + 20s hard timeout)          │
│  ├─ Keep-alive alarm (0.5 min) + onSuspend handler                        │
│  └─ Session stats routing                                                 │
│                                                                           │
│  OFFSCREEN DOCUMENT (hidden page, long-lived — the ML engine room)        │
│  ├─ Text toxicity  → transformers.js (ONNX Runtime Web, WASM)             │
│  ├─ Image NSFW     → nsfwjs (TensorFlow.js + WebGL)                       │
│  ├─ OCR (memes)    → tesseract.js (WASM worker)                           │
│  ├─ Explainable fusion: BLOCK if any tier blocks; FLAG if any flags       │
│  └─ IndexedDB: verdict history + feedback log + durability queue          │
│                                                                           │
│  UI SURFACES                                                              │
│  ├─ Popup: master on/off, model status, session stats, self-test          │
│  └─ Dashboard (options page): statistics, model info, thresholds,         │
│     text tester, Child Lock (PIN), Scroll Lock, feedback export           │
└───────────────────────────────────────────────────────────────────────────┘
```

**Why three contexts?** MV3 killed persistent background pages. Heavy ML work cannot run in
the service worker (it gets killed after ~30s idle and has no DOM). The **offscreen
document** is Chrome's sanctioned solution: a hidden page that lives as long as needed,
has DOM APIs (Canvas, IndexedDB, Web Workers) and stays alive while working.

---

## 3. Technologies Used & WHY (the "why did you choose X" questions)

### Extension framework
| Technology | What it is | Why chosen |
|---|---|---|
| **Manifest V3** | Chrome's current extension standard | Required for store submission; event-driven architecture; tighter security (no remote code) |
| **Vite** | Modern JS bundler | Fast builds, code-splitting, ES modules |
| **@crxjs/vite-plugin** | Vite plugin for extensions | Auto-bundles manifest entries (content scripts, SW, HTML pages) with HMR in dev |
| **Vanilla JavaScript** | No React/Vue in content scripts | Content scripts must be tiny and fast on every page; a framework would bloat each page's memory |

### Machine Learning stack
| Technology | What it is | Why chosen |
|---|---|---|
| **transformers.js (@xenova/transformers)** | Hugging Face's JS port of `transformers` — runs ONNX models in-browser | Lets us run production-grade NLP models fully client-side; `@huggingface/transformers` v3 exists but v2 is battle-tested in MV3 (we verified v3's tokenization via WASM would also work) |
| **ONNX Runtime (Web)** | Inference engine executing ONNX graphs on WASM/WebGL | Model-agnostic, quantization-aware, far faster than pure JS |
| **INT8 dynamic quantization** | Compresses weights from fp32 (4 bytes) to int8 (1 byte) | 1.1 GB → 266 MB for the text model; ~4× smaller with minimal accuracy loss |
| **nsfwjs + TensorFlow.js** | Pretrained NSFW image classifier (MobileNetV2) | Industry-standard lightweight NSFW detection; WebGL-accelerated |
| **tesseract.js** | OCR in the browser (WASM port of Tesseract) | Meme images often carry the toxicity in TEXT — OCR feeds that text into the text classifier |
| **Hugging Face Trainer + optimum** | Python-side fine-tuning + ONNX export | Standard, reproducible training pipeline for our custom models |

### Storage & data
| Technology | Why |
|---|---|
| **IndexedDB** (offscreen) | Large verdict/feedback stores, async, survives page loads |
| **Pending-write queue** | Verdicts are parked in a `pending-writes` store BEFORE writing, flushed on alarms/unload → no data lost if the SW dies mid-write |
| **chrome.storage.sync** | User settings (on/off, scope, Child Lock PIN hash) sync across the user's devices |

### Training stack (Python)
| Technology | Why |
|---|---|
| **PyTorch + transformers (HF Trainer)** | Fine-tuning MuRIL / MiniLM / IndicBERT with early stopping, metric tracking |
| **optimum[onnxruntime]** | One-command export of HF models to ONNX for browser use |
| **scikit-learn** | Precision/recall/F1 metrics for evaluation gates |

---

## 4. The ML Pipeline in Detail

### Text toxicity (production)
- **Model:** `unitary/multilingual-toxic-xlm-roberta` — XLM-RoBERTa base (278M params),
  fine-tuned on the Jigsaw multilingual toxicity corpus. Multilingual (100 languages),
  so it covers English + Hindi (Devanagari) natively.
- **Exported by us** to ONNX with **INT8 dynamic quantization** → 1.11 GB → **266 MB**,
  bundled **inside the extension** (zero runtime downloads).
- **Key detail (asked in reviews!):** the model has `num_labels=1` — a single-logit BCE head.
  `sigmoid(logit)` gives the toxicity score. (The naive softmax over one logit always
  returns 1.0 — a bug we caught and fixed.)
- **Two severity tiers on one score:**
  - score ≥ **0.90** → BLOCK (hate tier)
  - score ≥ **0.50** → FLAG (mild-negativity tier)
  - Calibrated so that *"this movie is stupid"* (0.87) stays at flag — it must never be
    treated like a slur (explicit project requirement).
- **Verified results:** catches **8/9** English identity-hate sentences
  ("Muslims are vermin…", "Jews control the media…", "immigrants are cockroaches…")
  where the previous zero-shot model caught 2/9.

### Image NSFW
- **nsfwjs MobileNetV2**, bundled via npm package imports (no network).
- Outputs 5 class probabilities: drawings / hentai / neutral / porn / sexy.
- **Threshold tuning (asked in reviews!):** the naive rule "any non-neutral class ≥ 0.5
  → flag" blurred *normal* photos, because the `sexy` class scores 0.4–0.6 on ordinary
  pictures. Fixed rule: flag only if `porn/hentai ≥ 0.5` or `sexy ≥ 0.85`. Verified on
  live Instagram: normal photos now stay clean.

### OCR (memes)
- Toxicity often hides in meme IMAGES. Tesseract.js (WASM, `eng`) extracts text from
  detected meme images → that text goes through the same text classifier → its verdict
  fuses into the final decision.
- Worker + WASM cores are bundled **locally**; only the `.traineddata` language file
  (pure data) is fetched once from a CDN and cached in IndexedDB.

### Fusion rule (deliberately explainable)
```
BLOCK if text.block OR image.block OR ocr-text.block
FLAG  if any tier flags
```
**No learned fusion model** — every verdict is auditable: the shield shows exactly which
tier caused it.

---

## 5. The Research Contribution: Fine-Tuning for Hinglish (honest failure analysis)

We fine-tuned three models on four datasets to support **Hinglish (romanized Hindi-English
code-mixed)** toxicity — all failed our hard acceptance gate (**precision ≥ 0.7 AND recall
≥ 0.7** on a 20-sentence hand-picked Hinglish eval set kept out of all training):

| # | Model | Data | Result |
|---|---|---|---|
| 1 | toxic-bert zero-shot | — | P=0.000 R=0.000 (no Hinglish signal) |
| 2 | MuRIL (partial FT) | PRISM corpus (MIT) | P=0.500 R=1.000 (no discrimination) |
| 3 | MiniLM (full FT) | PRISM | P=0.000 R=0.000 (inverted signal) |
| 4 | MiniLM | + India hate-speech superset | P=0.385 R=0.500 (label-convention conflict) |
| 5 | MiniLM | audited merge (1,249 label errors removed) | P=0.000 R=0.000 |
| 6 | MiniLM | + 1,925 thread-corpus rows + transliteration augmentation | P=0.500 R=1.000 |

**Root cause (high confidence, 6 runs):** no legally-accessible corpus contains enough
**Latin-script Hinglish slur supervision** — Devanagari-script hate labels do not transfer
to romanized text, and available "Hinglish" corpora carry political-hostility or noisy labels.

**Why this is a project strength, not a weakness (say this in review!):**
- We built a **reproducible evaluation harness** (dataset prep → fine-tune → ONNX export →
  quantization → threshold calibration → automated gate) that any future dataset can plug into
- We never shipped a failing model as if it worked — the interim defense is a
  **deterministic, explainable lexicon tier** (221 severity-graded Hinglish terms), parked
  behind a feature flag
- We documented everything: `ml/TRAINING-HISTORY.md`, `eval/RESULTS.md`, `eval/training_log.md`

**Ongoing:** official **HASOC code-mixed track** registration (the correct supervised data)
is in progress; the pipeline is one command away from re-evaluation.

---

## 6. Security & Privacy (teachers will ask)

| Concern | How it's handled |
|---|---|
| **Remote code** | MV3 forbids it. All JS is bundled by Vite at build time. An automated audit (`scripts/audit-remote-code.mjs`) greps the final `dist/` for CDN scripts, `eval()`, `new Function()`, remote `import()`/`importScripts`, and remote workers — **CLEAN**, with every transitive false-positive documented (e.g. protobufjs's dead require-shim) |
| **Model weights** | Bundled locally; no runtime model hub fetch at all |
| **CSP** | `script-src 'self' 'wasm-unsafe-eval'` — the minimal Chrome-sanctioned addition needed for WebAssembly (ML inference); no `unsafe-eval`, no remote scripts |
| **Permissions** | Only what's needed: storage, offscreen, alarms, unlimitedStorage. Host access is all-sites (the product requirement) with a dashboard scope switch |
| **User data** | **Nothing leaves the browser.** No analytics, no servers. Verdicts/feedback live in local IndexedDB; user can export and delete |
| **Child Lock PIN** | Unsalted single-round SHA-256 of a 4-digit PIN — a **documented, accepted limitation** (deters casual tampering only) |

---

## 7. Engineering Problems Solved (great "challenge" answers)

1. **MV3 service-worker lifecycle** — SWs die after ~30s idle. Solution: offscreen document
   for long-lived ML work + keep-alive alarms + a durable pending-write queue so IndexedDB
   writes never get lost mid-teardown.
2. **Offscreen readiness handshake** — the offscreen must confirm it booted; we use an
   explicit READY message + ping/pong with a **20-second hard timeout that fails loudly**
   (the original spec's "silent everything-clean failure mode").
3. **transformers.js × chrome-extension:// URLs** — four distinct bugs found and fixed:
   - Full extension URLs as model IDs get mangled by the path joiner → use
     `env.localModelPath = chrome.runtime.getURL('models/')` + relative ID
   - The Cache API rejects `chrome-extension://` schemes → `useBrowserCache = false`
   - ORT-Web spawns blob workers for WASM multithreading — blocked by CSP →
     single-threaded mode (`numThreads = 1`, `proxy = false`)
   - **The tokenizer Metaspace bug**: transformers.js v2 reads the legacy
     `add_prefix_space` field; modern tokenizers only write `prepend_scheme` → words lost
     their `▁` prefix marker → wildly wrong scores ("Jews control the media": 0.664 correct
     vs 0.011 broken). Fixed by patching the field into the bundle's tokenizer.json —
     diagnosed by diffing token IDs between Python and JS.
4. **CSP vs WebAssembly** — WASM compile requires `'wasm-unsafe-eval'` in the MV3 CSP;
   added the Chrome-sanctioned minimal directive.
5. **Virtualized feeds** — Twitter/YouTube recycle DOM nodes. Solution:
   IntersectionObserver leave-callbacks + MutationObserver removal detection clear the
   registry so stale shields never re-attach to recycled elements.
6. **Scroll-smoothness** — viewport-only processing, 200 ms debounce, classification queue,
   21–36 ms per comment (native) / a few hundred ms (WASM).
7. **DOM correctness** — every inner query uses `post.querySelectorAll` (scoped to the
   post root), never `document.querySelectorAll`; Instagram's fallback dedupe key pads
   text + DOM position to >120 chars to avoid collisions.
8. **Live verification infrastructure** — we drove the REAL browser via the Chrome DevTools
   Protocol (headless + windowed Chrome, WebSocket): extension reload, message round-trips,
   self-tests, DOM shield assertions, screenshots. Same idea as E2E tests.

---

## 8. Frontend / UI Features (demo checklist)

- **Popup:** master on/off switch (persists), model status badge with per-stage states
  (text/image/ocr), session stats, pipeline self-test button, dashboard link
- **Dashboard (options page):** statistics cards (blocked/flagged/processed) +
  per-source breakdown; recent-verdicts table (20); model information table
  (tier/model/params/size/location/live state); **Test-any-text** tool (paste text →
  see verdict + score); live threshold table (rendered from the running config — no
  drift possible); Scroll Lock setting; **Child Lock** (PIN set/disable, state,
  block-mild option); feedback export (JSON/CSV)
- **On-page UX:** blur shields (heavy blur + red pill for toxic, light blur + yellow
  for mild), "Show anyway" (PIN-gated in Child Lock), "Report wrong verdict",
  first-run model-loading banner, Child Lock scroll-freeze with PIN unlock screen

---

## 9. Likely Viva Questions (with short answers)

**Q: Why run ML in the browser instead of a server?**
Privacy (content never leaves the device), zero server cost, works offline after load,
and no per-user API fees. Trade-off: slower inference and larger bundles.

**Q: Why ONNX and not TensorFlow.js for everything?**
ONNX is model-agnostic (any HF model exports to it), supports INT8 quantization, and
ONNX Runtime Web's WASM backend is the fastest pure-WASM option. TFJS is used only for
nsfwjs because that ecosystem provides the pretrained NSFW model.

**Q: How do you handle dynamically loaded feeds?**
MutationObserver (debounced 200 ms) detects new DOM; IntersectionObserver limits
processing to viewport-entering posts; a registry with element-removal and
viewport-leave cleanup prevents stale state on virtualized feeds.

**Q: What are the two severity tiers?**
Block tier = high-confidence hate/threat (score ≥ 0.9) — blurred heavily, PIN-gated
override in Child Lock. Flag tier = mild negativity (score ≥ 0.5) — light blur, never
blocked. This prevents "this movie is stupid" from being treated like a slur.

**Q: How do you know your model is good?**
A held-out hand-picked eval set + automated precision/recall gates that block shipping
if below 0.7. We also run probe suites for English identity hate and NSFW false positives.

**Q: Your Hinglish models failed — why ship this at all?**
We never shipped a failing model. The deterministic lexicon tier covers Hinglish slurs
interim; the full training pipeline is reusable the moment the correct dataset
(HASOC code-mixed) is obtained — that's the documented next step.

**Q: What is quantization and why INT8?**
Storing model weights as 8-bit integers instead of 32-bit floats: 4× smaller, faster on
CPU/WASM, negligible accuracy drop for classification. Verified: torch vs ONNX logit
parity (±0.13 post-quantization).

**Q: How does the blur work technically?**
A per-target overlay div with `backdrop-filter: blur(18px)` (heavy) or `blur(8px)`
(mild) over the text container or media container — content shows through blurred,
with a state pill and buttons. No content is ever deleted, only blurred.

**Q: What happens when the service worker dies mid-write?**
Verdicts enter a durable `pending-writes` store BEFORE the real write; a keep-alive
alarm + onSuspend + unload flush drains the queue — no silent data loss.

**Q: Does it work on any website?**
Yes — all-sites content script by default (with a scope setting), including search
engines; site-specific adapters for the three core sites, a generic adapter elsewhere.

---

## 10. Repository Map

```
D:\safescroll
├── manifest.json              # MV3 manifest (CSP, permissions, content scripts)
├── vite.config.js             # Vite + CRXJS build
├── src/
│   ├── background/            # service worker (relay, handshake, keep-alive)
│   ├── content/               # adapters, observers, registry, shields, lockscreen
│   ├── offscreen/             # ML engine room: text/image/OCR + fusion + storage
│   ├── options/               # dashboard UI
│   ├── popup/                 # popup UI
│   └── shared/                # profiles (thresholds), lexicon, message constants
├── eval/                      # eval sets, gate runner, RESULTS.md, training_log.md
├── ml/                        # data prep, training, export, calibration scripts
├── scripts/                   # build helpers + audit + CDP verification drivers
├── test/                      # test pages + screenshot proofs
└── public/                    # bundled model + tesseract runtime + ort wasm
```
