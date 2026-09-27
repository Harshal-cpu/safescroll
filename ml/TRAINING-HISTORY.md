# SafeScroll â€” Complete ML Training History (for AI/human handoff)

**Project:** SafeScroll â€” Chrome MV3 extension, on-device content moderation (Instagram, X/Twitter, YouTube). No server inference. Built at `D:\safescroll`.

**This document:** every text-classifier approach attempted, why, with what data, and the exact result. The acceptance gate never changed: **precision â‰¥ 0.7 AND recall â‰¥ 0.7 on `eval/hinglish-test-set.json`** (20 hand-picked Hinglish/code-mixed sentences, 10 toxic / 10 clean, kept OUT of all training data). Gate history: **6 runs, 6 failures, one root cause.**

## 1. Working extension architecture (built, passing audits)

```
content script (adapters: twitter/instagram/youtube/generic;
  MutationObserver + IntersectionObserver + 200ms debounce; registry cleanup
  on element-removal + viewport-leave)
  â†’ background SW (relay only; offscreen handshake w/ 20s hard timeout;
    keep-alive alarm 0.5min; onSuspend; Anywhere mode = permissions.request +
    scripting.registerContentScripts â€” real gate)
  â†’ offscreen document (all ML: text classifier, nsfwjs image, tesseract OCR
    eng+hin; explainable OR-fusion: BLOCK if any .block, FLAG if any .flag;
    IndexedDB pending-write queue for durability; ImageBitmap transport probe)
```

- ML runtimes are npm deps bundled locally (Vite + @crxjs/vite-plugin). Tesseract worker/wasm local via `getURL`; only `.traineddata` (data) fetched from tessdata.projectnaptha.com. transformers.js `env.backends.onnx.wasm.wasmPaths` overridden to local `ort/` (WASM = code, must not come from jsDelivr default).
- Packaging gate: `node scripts/audit-remote-code.mjs` â€” greps dist/ for remote code; allowlisted dead paths documented in the script. **Status: CLEAN** after every rebuild.
- Two-tier severity design: hate tier (blocks) vs mild-negativity tier (flag-only). Thresholds live in `src/shared/profiles.js` (PROFILES); options dashboard renders from the live object via offscreen query (no drift).
- Known weak placeholder in production code: `Xenova/toxic-bert` (Entry 1) â€” clearly documented as weak, not silently shipped as Hinglish-capable.

## 2. Environment (reproduce everything)

- Windows, CPU-only (12 cores, 7.3 GB RAM â€” MiniLM full-FT OOM-killed at batch 32; use batch 16), Python 3.14.4, torch 2.13.0+cpu, transformers 4.57.6, datasets 5.0.1, onnxruntime 1.30.0, optimum, indic-transliteration, Node 22.17, @xenova/transformers 2.17.2.
- Gotchas learned: transformers 4.57 slowâ†’fast tokenizer conversion crashes (mistral-regex bug) on sentencepiece-only repos â†’ ship/steal a `tokenizer.json` (XLM-R fast tokenizer used for MiniLM); pandas 3.x `groupby.apply` drops group keys; `Start-Process` + `dataloader_num_workers>0` hangs on Windows â†’ use 0; HF gated downloads need account-level license acceptance (tokens alone aren't enough).

## 3. The datasets (verified provenance)

| Dataset | License | Rows | Script | Verdict |
|---|---|---|---|---|
| `pankajbiswas6/prism-hinglish-hate-speech` (HF) | MIT | 29,506 (En 15k / Hi 9.8k / Hinglish 4.8k) | mixed | Weak Hinglish labels â€” trained twice, failed twice |
| `manueltonneau/india-hate-speech-superset` (HF, extra-gated; user accepted with token) | research-use gate | 14,155 (hasoc 5,982 + hostility 8,173) | **Devanagari 13,823; Latin-only 331** | No Latin-script share; hostility subset = wrong convention |
| User's thread corpus (`D:\safescroll\hinglish\data-*â€¦Z-001`) | unknown (unverified) | 1,925 extracted (HOF/NONE) | Latin 1,926 / Dev 408 | Real code-mixed text but **political-hostility labels; only 58 rows have severity-â‰¥4 slurs** |
| GitHub `Kxngh/â€¦combined_dataset.csv` | unknown | 19,004 binary | Latin | Label noise verified by spot-check â€” rejected |
| `Hinglish_Profanity_List.csv` (GitHub, Zishaanuddin repo) | unknown | 221 terms, severity 1â€“5 | Latin | âœ… Used for audit filter; **basis of interim lexicon tier** |
| HASOC official (code-mixed track) | registration form | ~4â€“5k | **Latin-script Hinglish** | **THE missing supervision â€” user registered, download pending** |
| TRAC | registration portal | ~35â€“44k (OAG/CAG/NAG) | Hi mostly Devanagari | Optional complement; maps to tiers |
| `ai4bharat/indic-bert` (model) | gated | â€” | â€” | **403 for user's token â€” gate acceptance on model page still not done** |

## 4. Every training run and result (chronological)

| # | Base model | Data | Val F1 | Export size | Gate P / R / F1 | Failure signature |
|---|---|---|---|---|---|---|
| 1 | Xenova/toxic-bert (zero-shot) | â€” | â€” | ~500 MB bundled | 0.000 / 0.000 / 0.000 | Scores nothing in Hinglish |
| 2 | MuRIL-base **partial-FT** (frozen emb+layers0â€“7; CPU: full FT â‰ˆ 8â€“10 h infeasible) | PRISM 10k | 0.672 | fp32 950 MB â†’ **INT8 238 MB** (over target) | 0.500 / 1.000 / 0.667 | "This movie is stupid" (0.605) > every toxic sentence (max 0.597) â€” no threshold reaches Pâ‰¥0.7 |
| 3 | MiniLM-L12-H384 **full-FT** | PRISM 10k | 0.675 | 470 MB â†’ **118 MB** | 0.000 / 0.000 / 0.000 | **Inverted**: clean "I hate it when the metro is late" = 0.845; toxic Hinglish 0.147â€“0.184 |
| 4 | MiniLM full-FT | superset+PRISM merge 10.6k | 0.473 | 118 MB | 0.385 / 0.500 / 0.435 | Hostility-subset label conflict degraded everything; "metro is late" (0.712) still top of set |
| 5 | MiniLM full-FT | **audited** hasoc-only+PRISM (1,249 label-error rows removed) 9.5k | 0.596 | 118 MB | 0.000 / 0.000 / 0.000 | Devanagari signal does NOT transfer to Latin-script slurs |
| 6 | MiniLM full-FT | thread corpus + transliteration-augmented Devanagari + audited v3 (16k) | 0.577 | (not exported) | 0.500 / 1.000 / 0.667 | Keys on English word "hate" (0.905); all Hinglish 0.095â€“0.15 |

**Conclusion (high confidence, 6 independent runs):** the bottleneck is **absent Latin-script Hinglish slur supervision** â€” max 58 such rows exist across all reachable corpora. Devanagari hate data does not transfer to romanized slurs; political-hostility labels actively harm. More reweighting/retraining of reachable data cannot pass the gate.

Also tested and rejected: published ungated Hinglish models â€” `Keshav0av/HinTox` degenerate (1.0 for everything incl. clean); `niksss/Hinglish-HATEBERT` broken checkpoint.

## 5. Pipeline artifacts (all in `D:\safescroll`)

- `ml/prepare_data.py / _v2 / _v3 / _v4.py` â€” dataset builds (v3 = audit protocol; v4 = thread extraction `ml/extract_thread_corpus.py` + transliteration via ISO-15919â†’ASCII-strip)
- `ml/train.py` (MuRIL partial), `ml/train_indicbert.py` (gated-blocked), `ml/train_minilm.py` (_v2/_v3/_v4 variants) â€” HF Trainer, early stopping on val F1, best checkpoint by F1
- `ml/export_onnx.py <model> <name>` â€” optimum ONNX + INT8 dynamic quantization â†’ `public/models/<name>/onnx/model_quantized.onnx` (transformers.js layout)
- `ml/calibrate_thresholds.py <model> <val.csv> <out.json>` â€” flag thr = max-F1, block thr = Pâ‰¥0.80 w/ coverage; **parameterized after a bug where v2/v3 calibrations used a hardcoded old val path**
- `eval/run-eval-muril.mjs --model <dir> --thresholds <json>` â€” the gate; appends to `eval/RESULTS.md` (never overwrites history)
- `eval/RESULTS.md` â€” Entries 1â€“6 (see below)
- `ml/BUILD-GUIDE-HASOC-CM.md` â€” plan doc for the HASOC-CM + transliteration approach
- `scripts/audit-remote-code.mjs` â€” dist/ remote-code gate (must be CLEAN before packaging)

## 6. Agreed next steps (nothing silent)

**Phase A (executed):** shipped the **interim lexicon tier** â€” 221-term severity-graded list as transparent pre-classifier (severity â‰¥4 â†’ block, 2â€“3 â†’ flag), OR-fused with existing ML tiers; rebuild; audit CLEAN; Entry 6 documented in `eval/RESULTS.md`.

**Entry 7 (added):** PRODUCTION UPGRADE — unitary/multilingual-toxic-xlm-roberta bundled locally (INT8 265.9 MB, fp32 1112 MB) replaces toxic-bert as the text tier. English identity-hate probe: 8/9 caught (vs 2/9). Two critical bugs found+fixed: (1) num_labels=1 BCE head requires manual sigmoid (pipeline softmax always returns 1.0); (2) transformers.js v2 Metaspace tokenizer bug — needs legacy dd_prefix_space: true patched into tokenizer.json or JS tokenization drops the ▁ word marker (scores wildly wrong). Hinglish gate still FAIL (P=0.643/R=0.900, best ML result; lexicon tier remains the Hinglish defense). See eval/RESULTS.md Entry 7.

**Phase B (blocked on user actions):** 1) complete HASOC **code-mixed track** download (user registered; Drive folder pending â€” that's the real slur-label corpus, ~4â€“5k rows); 2) accept `ai4bharat/indic-bert` gate on HF (model page "Agree" â€” still 403 for their token as of last check); 3) retrain IndicBERT (~33 MB export, fits the 50â€“80 MB target) on HASOC-CM + audited data â†’ gate â†’ wire in only on PASS.

**Explicitly not done / future work:** Hinglish-capable ML text classifier (unresolved â€” placeholder toxic-bert ships as labeled-weak); violence/gore detection (stretch goal, no fake placeholder); PaddleOCR fallback (optional polish); automated retraining (out of scope â€” feedback exports CSV/JSON for manual batch review).


## Addendum — runtime bug fix (browser load)

The first real-browser load failed: transformers.js v2 prefixed the hub URL onto our chrome-extension:// URL ('https://huggingface.co/chrome-extension://.../tokenizer.json'). Cause: hub.js only treats http/https URLs as URLs; any other scheme falls into the LOCAL branch (pathJoin(env.localModelPath, requestURL)). Fix in src/offscreen/textClassifier.js: env.allowLocalModels=true + env.localModelPath='' (full extension URL fetched as-is) + env.allowRemoteModels=false (no hub fallback). Rebuilt, audit CLEAN.

## Addendum 2 — in-browser load fixes (offscreen console evidence)

1. transformers.js v2: passing a full chrome-extension:// URL as model id -> pathJoin('', url) prepends '/' -> invalid relative fetch. Fix: env.localModelPath = chrome.runtime.getURL('models/') + relative id 'toxic-xlmr'.
2. tesseract.js: default workerBlobURL=true spawns a blob worker which importScripts(workerPath) — blob origin can't load chrome-extension:// scripts. Fix: workerBlobURL:false (direct Worker from extension URL).

## Addendum 3 — MV3 CSP blocks WASM (in-browser)

ML inference (onnxruntime-web + tesseract wasm cores + tfjs) requires WebAssembly compilation, which the default MV3 extension CSP (script-src 'self') blocks. Fix: manifest content_security_policy.extension_pages = \"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'\" — Chrome's sanctioned minimal directive for WASM (no arbitrary JS eval; CWS-accepted). Rebuilt, audit CLEAN.

## Addendum 4 — ORT-web blob workers vs MV3 CSP (in-browser)

transformers.js bundles onnxruntime-web, which spawns blob workers for WASM multithreading; MV3 CSP (script-src 'self' 'wasm-unsafe-eval') blocks blob: script loads -> 'worker sent an error!' xN + inference dead. Fix: env.backends.onnx.wasm.numThreads=1 + proxy=false (CSP-clean, single-threaded WASM inference; ~0.3-1s per comment on WASM — acceptable).

## Addendum 5 — Anywhere mode permission fix

chrome.permissions.request() called from the service worker (via popup message relay) silently fails: the user-gesture context does not survive sendMessage relaying. Fix: request permissions DIRECTLY in popup.js (click handler = gesture context); the background handler only verifies the grant (permissions.contains), registers the content script (chrome.scripting.registerContentScripts) and persists state.

## Addendum 6 — optional permission manifest declaration

chrome.permissions.request({origins:['https://*/*']}) fails with 'Only permissions specified in the manifest may be requested' unless the origin pattern is pre-declared. Fix: manifest 'optional_host_permissions': ['https://*/*'] (not granted at install; requested at runtime from the popup gesture context).

## Addendum 7 — dashboard build + CDP live verification

Dashboard rebuilt as a proper UI: Statistics cards + per-source breakdown, Recent verdicts (20), Model information table (tier/model/params/size/location/live load state), Test-any-text tool, live threshold table, Scroll Lock, Child Lock (PIN), feedback export. Popup: 'Open dashboard' now uses chrome.runtime.openOptionsPage() (a plain <a> from a popup dies on blur).

VERIFIED LIVE via CDP (chrome --remote-debugging-port + --load-extension): extension SW alive; offscreen modelsReady; self-test BLOCK score 0.9956; x.com content script scanning (units found) + verdicts flowing (25 verdicts: 11 blocked / 2 flagged); injected synthetic toxic post into live x.com DOM -> MutationObserver -> classify -> shield 'Toxic content blurred' (screenshot: test/e2e-proof.png).

Bugs fixed during verification:
- statsBySource table had no <tbody> -> null-ref threw AFTER statBlocked/statTotal set -> catch overwrote total with 'unavailable' (the misleading mixed state). One-line HTML fix.
- zombie options tabs after extension reload: stale DOM + 'Extension context invalidated' - a tab refresh fixes; retried data-fetch helpers added (viaOffscreen retries + SW relay retry for cold-start responder races).

## Addendum 8 — granular blurring + cross-site verification (CDP)

FEATURE: granular blur — text-tier verdicts (text/lexicon) blur ONLY the text container; media-tier verdicts (image/ocr-text) blur ONLY the media container; clean tiers render normally. Adapters gained textEl()/mediaEl() locators (twitter: tweetText/media img; instagram: caption/img; youtube: title/comment-content/thumbnail; generic: p/h/heading + img). Registry reworked (shields map {post,text,media}, replaceShields). BUG fixed: register() passed the shield element where the new registry expected a map — loading shields never updated (stuck 'loading' on clean posts). BUG fixed: nsfwjs flag tier fired at 'sexy'>=0.5 which runs hot on NORMAL photos (mass false blur) — now porn/hentai>=0.5 OR sexy>=0.85, drawings excluded.

LIVE VERIFICATION (CDP, user's browser):
- X: injected toxic-text post -> shield target='text' verdict=block score=0.9956; clean post -> nothing blurred.
- YouTube (watch page): watch-metadata unit found + classified clean -> no blur; comment-thread units wired (0 available on that video).
- Instagram (profile): image posts (3-4 imgs) classified -> clean -> visibleBlur=0 (sexy-threshold fix confirmed).

## Addendum 9 — ALL-SITES moderation (default) + search-engine support

Per user request, moderation now runs on ALL websites by default: manifest host_permissions = http/https all-sites + static content_scripts match http(s)://*/* (replaces the optional-permission Anywhere mode — dead code removed, 'scripting' permission dropped). New 'Moderation scope' setting in the dashboard: All websites (default) / Core sites only — enforced by the content script via storage.sync 'scope'.

Generic adapter extended for SEARCH ENGINES: Google results (div.g, [data-sokoban-container]), Bing (li.b_algo), DuckDuckGo (article). Text from h1-h3/snippets; imageUrls filtered (no avatars/logos/icons/sprites).

VERIFIED LIVE via CDP on a Google-style search page (test/search.html): toxic result -> text-target blur BLOCK (score 0.99); hate result -> text blur BLOCK (0.987); mild result ('this movie is stupid'-class) -> text blur FLAG (0.769, stays out of block tier); clean results -> fully readable, no blur. Screenshot: test/search-blur-proof.png.
