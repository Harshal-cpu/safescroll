# SafeScroll text-classification evaluation history

History is append-only. Entries in chronological order â€” each entry records the model, the exact 20-sentence hand-picked Hinglish eval set (kept OUT of all training/validation splits), and PASS/FAIL against the hard gate (precision â‰¥ 0.7 AND recall â‰¥ 0.7).

---

# Entry 1 â€” Baseline zero-shot: Xenova/toxic-bert â€” **FAIL** (P=0.000, R=0.000)

**Checkpoint evaluated:** `Xenova/toxic-bert` (pre-quantized, transformers.js)
**Test set:** `eval/hinglish-test-set.json` â€” 20 hand-picked Hinglish/code-mixed sentences (10 toxic, 10 clean/mild)

## Results â€” FAILED GATE

| Metric | Score |
|---|---|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |

Every single Hinglish sentence â€” including explicit slurs ("randi", "chutiye", community-based hate) and an encouragement of self-harm â€” scored below both the hate-block (0.70) and mild-flag (0.55) thresholds. Mild English negativity like "this movie is stupid" correctly stays clean (good), but the model detects essentially **nothing** in Hinglish.

## Verdict (flagged loudly, per architecture constraint)

This checkpoint has **weak-to-nonexistent Hinglish coverage**. It remains the wired-in placeholder ONLY as an English baseline, with the limitation surfaced in the UI/docs â€” NOT silently presented as Hinglish-capable.

---

# Entry 2 â€” Fine-tuned MuRIL (google/muril-base-cased, partial FT, INT8 ONNX) â€” **FAIL** (P=0.500, R=1.000)

## Dataset provenance & licenses (explicit, no silent substitution)

- **HASOC** (Hate Speech and Offensive Content, Hindi/code-mixed subsets): official distribution requires **manual registration/agreement** via the HASOC organizing form. I cannot complete a human registration on your behalf and did **not** bypass it.
- **TRAC** (Trolling, Aggression and Cyberbullying, 1.0/2.0): distributed via competition portal **requiring registration**. Same situation â€” not obtainable without manual signup.
- HF mirrors of HASOC were inspected and rejected: `pranjali94/HASOC2020_Roman` (unlabeled raw tweets), `nikitadesai/hasoc` (CC-BY-NC-4.0 but mojibake-corrupted, unusable).
- **SUBSTITUTION USED (stated, not silent):** `pankajbiswas6/prism-hinglish-hate-speech` â€” **MIT license**, binary labels (0=non-hate, 1=hate), 29,506 cleaned rows; composition English 15,000 / Hindi-Devanagari 9,767 / Hinglish 4,783; Kaggle-derived "combined_hate_speech_dataset" (English hate corpus + Hindi corpus + Hinglish offensive-text TSV). This is **not** HASOC/TRAC and does not substitute for their label quality on code-mixed aggression.

## Data prep

- Provided stratified splits used (60/10/30): train 17,704 / val 2,950 / test 8,850.
- Verified: **0 cross-split duplicates** (normalized-text check), 0 intra-split dupes, all rows â‰¥ 3 chars.
- Class balance â‰ˆ 46.4% toxic in every split â€” NOT heavily imbalanced â†’ **no class weighting / oversampling applied for balance** (stated explicitly since the spec asked).
- **Domain oversampling:** Hinglish train rows duplicated 2Ã— (2,881 â†’ 5,762) because Hinglish is the target domain.
- The 20-sentence eval set was NOT included in any split â€” untouched acceptance gate.

## Training (ml/train.py, eval/training_log.md)

- Base: `google/muril-base-cased` (237.6M params). **Partial fine-tune â€” explicit stated shortcut for the CPU-only box (12 cores, no GPU):** embeddings + encoder layers 0â€“7 frozen; layers 8â€“11 + pooler + classifier trained (28.9M trainable). Full FT benchmarked at 424 ms/sample â‰ˆ 8â€“10 h wall â€” infeasible here.
- Train subsample 10,000 rows stratified by (label Ã— lang). max_len 96 (p95 = 90 tokens). 2 epochs, lr 3e-5, batch 32, early stopping patience 1, best checkpoint by **val F1**.
- Wall time 37.6 min.

| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.6125 | 0.6494 | 0.6964 | **0.6721** â† best |
| 2.0 | 0.5837 | 0.6906 | 0.6401 | 0.6644 |

## Export & size

- `optimum[onnxruntime]` export + INT8 dynamic quantization: **fp32 950 MB â†’ INT8 238 MB**.
- **SIZE FLAG: 238 MB is 3â€“4Ã— over the ~50â€“80 MB target for an extension download.** Not shippable as-is.

## Gate run (quantized ONNX via transformers.js, thresholds calibrated on val)

| Metric | Score |
|---|---|
| Precision (flag tier, thr=0.29) | 0.500 |
| Recall | 1.000 |
| F1 | 0.667 |
| Block-tier recall (thr=0.63) | 0.000 |

**Failure is structural, not a calibration problem:** the clean sentence "This movie is stupid but the songs were okay" scored 0.605 â€” higher than every toxic sentence (max 0.597). There is **no threshold** at which precision â‰¥ 0.7. Confidence distribution compressed to 0.54â€“0.61 with zero Hinglish discrimination. (Thresholds themselves: flag=0.29 â†’ val P=0.587/R=0.848; block=0.63 â†’ val P=0.735/R=0.324; max val score 0.642.)

**GATE: FAIL â€” NOT integrated.**

---

# Entry 3 â€” Fine-tuned MiniLM (microsoft/Multilingual-MiniLM-L12-H384, FULL FT, INT8 ONNX) â€” **FAIL** (P=0.000, R=0.000)

## Base-model switch (explicit, per task instructions)

MuRIL failed the gate (Entry 2) AND its export is 238 MB. The task-sanctioned fallback `ai4bharat/indic-bert` is a **gated repo** (auth + license acceptance required) â€” I did not bypass it, and rejected an unverified third-party mirror (`kornesh/indic-bert`, TF-weights-only) on supply-chain integrity grounds. Substituted **`microsoft/Multilingual-MiniLM-L12-H384`** (official, ungated, 117.7M params, XLM-R 250k vocab â€” Hindi-capable).

## Training (ml/train_minilm.py, eval/training_log.md)

- **FULL fine-tune** (117.7M trainable) â€” small enough for the CPU box. Same 10k stratified subsample, max_len 96, 3 epochs, lr 2e-5, batch 16 (reduced mid-run after an OOM hard-kill at step 441/939; resumed from the epoch-1 checkpoint), early stopping patience 2, best by val F1. XLM-R fast tokenizer used (repo ships only sentencepiece; transformers 4.57 slowâ†’fast conversion crashes on it).
- Wall time ~27 min (resumed run) + ~21 min (first attempt).

| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.5980 | 0.6603 | 0.6839 | 0.6719 |
| 2.0 | 0.5589 | 0.7328 | 0.5985 | 0.6589 |
| 3.0 | 0.5565 | 0.7063 | 0.6460 | **0.6748** â† best |

## Export & size

- **fp32 470 MB â†’ INT8 118 MB.** Still above the ~50â€“80 MB target (flagged).

## Gate run (quantized ONNX via transformers.js)

| Metric | Score |
|---|---|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |

**Failure mode is worse than MuRIL â€” the model's Hinglish signal is inverted:** every toxic Hinglish sentence scored 0.147â€“0.184 (far below the 0.29 flag threshold) while the CLEAN English sentence "I hate it when the metro is late" scored **0.845**. Root-cause hypothesis: the training corpus's Hinglish portion (a single Kaggle TSV source, only ~2.8k effective rows) carries label noise or a very different "hate" distribution than hand-picked Hinglish slurs, and the English majority dominates what the model learned.

**GATE: FAIL â€” NOT integrated.**

---

# (Entry-3-era status — superseded by Entry 4 below)

# CURRENT STATUS: production Hinglish text classifier is UNRESOLVED

The extension still runs the Entry-1 zero-shot toxic-bert as a clearly-labeled weak placeholder. **No fine-tuned model has been wired in. This is not "done".**

## Proposed next steps (concrete)

1. **Get the real datasets (requires manual action by you):** register for HASOC 2020â€“2022 Hindi/code-mixed tracks (Google-form agreement) and TRAC 1/2 (competition portal). Their code-mixed aggression labels are the actual training signal this corpus lacks. Then re-run: `ml/prepare_data.py` (add loaders), `ml/train.py`, `ml/export_onnx.py`, `ml/calibrate_thresholds.py`, `node eval/run-eval-muril.mjs`.
2. **Train Hinglish-only or Hinglish-majority** (oversample â‰¥ 4Ã—) instead of the 43% English mix â€” Entry 3 shows English dominates learning.
3. **Full MuRIL fine-tune on a GPU** (Colab/Kaggle free tier suffices for 3 epochs on 18k rows, ~10 min on T4) â€” the partial-FT compromise may account for the compressed confidence distribution.
4. **Interim measure (proposed, NOT built):** a curated Hinglish slur lexicon (transparent exact/normalized-token matching, two-tier like the ML thresholds) layered in front of the text classifier as the primary Hinglish defense until a model passes the gate. Fully explainable, zero download cost.
5. **Size note:** even if a model passes the gate, MuRIL INT8 (238 MB) exceeds the 50â€“80 MB target â€” prefer MiniLM-class bases or distillation, or accept a larger download explicitly.

## Regression data (for future comparisons)

- Test split (held-out, never used): `ml/prepared/test.csv` â€” 8,850 rows, 46.4% toxic.
- Eval gate: `eval/hinglish-test-set.json` â€” 20 sentences, untouched by all training runs.

=== SafeScroll Hinglish eval: fine-tuned MuRIL (quantized ONNX, local bundle) ===
Model: public/models/v2-toxic | flag_thr=0.29 block_thr=0.63 (calibrated on val, not on this set)
Set size: 20 (toxic=10, clean=10)
Operating point: score >= 0.29 => flagged toxic

Precision: 0.385
Recall:    0.500
F1:        0.435
Block-tier recall (score >= 0.63 on toxic sentences): 0.000

Per-sentence:
label=0 pred=1 toxic=0.500 block=0 :: Tu pagal hai kya, sahi se kaam kar
label=0 pred=0 toxic=0.095 block=0 :: This movie is stupid but the songs were okay
label=0 pred=1 toxic=0.526 block=0 :: Yaar aaj bahut bura din tha, mood kharab hai
label=0 pred=1 toxic=0.401 block=0 :: Bhai tera joke ekdum bakwas tha
label=0 pred=1 toxic=0.712 block=1 :: I hate it when the metro is late, so annoying
label=0 pred=1 toxic=0.395 block=0 :: Teri writing skills zero hain bhai
label=0 pred=0 toxic=0.149 block=0 :: Aaj mera team match haar gaya, dukh ho raha hai
label=0 pred=1 toxic=0.603 block=0 :: Ye product bekar hai, paise barbaad ho gaye
label=0 pred=1 toxic=0.446 block=0 :: Tu bewakoof hai jo is scam mein paise daale
label=0 pred=1 toxic=0.406 block=0 :: Mujhe ye channel pasand nahi, log stale content daalte hain
label=1 pred=1 toxic=0.563 block=0 :: Saala chor hai, sale karke bhaag gaya
label=1 pred=1 toxic=0.333 block=0 :: Randi kahin ke, baat karne layak nahi tu
label=1 pred=0 toxic=0.211 block=0 :: Bhange ke gunde desh ko barbaad kar rahe hain
label=1 pred=0 toxic=0.194 block=0 :: Tere jaise chakke desh ka naam kharab karte hain
label=1 pred=1 toxic=0.418 block=0 :: Kamina hai tu, hamesha peeche se vaar karta hai
label=1 pred=1 toxic=0.472 block=0 :: Is gandagi ko desh se bahar nikalo saalon ko
label=1 pred=0 toxic=0.123 block=0 :: Teri community ke log to harami hote hain
label=1 pred=0 toxic=0.217 block=0 :: Chutiye, apna kaam kar warna bahut bura hoga
label=1 pred=0 toxic=0.108 block=0 :: Aisi harkatein sirf namard hi kar sakte hain
label=1 pred=1 toxic=0.390 block=0 :: Suicide kar le bhai, teri zindagi bekaar hai

GATE (P>=0.7 AND R>=0.7): FAIL


---

# Entry 4 â€” Fine-tuned MiniLM on Superset+PRISM merge â€” **FAIL** (P=0.385, R=0.500)

## What changed

Downloaded manueltonneau/india-hate-speech-superset (14,155 rows, HF extra-gate accepted with access token; gate text: research/evaluation use, cite arXiv:2411.15462, no redistribution, no generative training). Composition: **hasoc 5,982 rows** (Twitter+Facebook; REAL HASOC-derived data) + **hostility detection 8,173 rows**. Binary labels binarized by the superset author. **Heavy imbalance: 13.2% toxic** â†’ handled by stated oversampling (toxic x2 + PRISM-Hinglish x2, train split only).

**Critical composition finding:** the superset is **Devanagari-dominant â€” 13,823 of 14,155 rows contain Devanagari; only 331 are pure Latin-script.** There is no meaningful Hinglish share, contradicting the hope that it would fix the Hinglish gap by itself.

## Merge & split (ml/prepare_data_v2.py)

- Superset (14,155) + PRISM Hinglish (4,774) = 10,633 after dedup (19.8% toxic).
- Clean stratified 80/10/10 FIRST, then train-only oversample (train 21,937 rows, 34.0% toxic; val/test untouched at 19.8%). No leakage.
- Training identical to Entry 3 (MiniLM full FT, 14k train subsample, 2 epochs, max_len 96). Wall time 62 min.

| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.4244 | 0.6331 | 0.2869 | 0.3948 |
| 2.0 | 0.4091 | 0.5109 | 0.4397 | 0.4726 â† best (WORSE than Entry 3's 0.6748) |

Val threshold sweep ceiling: best F1 = 0.634 at a degenerate threshold (0.05 â†’ P=0.46/R=1.0). Block tier: P=0.797 at recall 0.037 (no coverage).

## Gate run (quantized ONNX 118 MB, transformers.js)

| Metric | Score |
|---|---|
| Precision | 0.385 |
| Recall | 0.500 |
| F1 | 0.435 |

Same structural failure as Entry 2: **"I hate it when the metro is late" (clean) scored 0.712 â€” the HIGHEST score in the entire set; the highest toxic sentence scored 0.563.** No threshold reaches the gate.

## Root-cause analysis (three failures, one common cause)

1. **Label-convention conflict in the merge.** The superset's hostility detection subset (8.2k rows, the majority) annotates *hostility toward political entities/nations* (its samples label political criticism as positive), which conflicts with hate-speech annotation (identity attacks). Merging them taught the model that political grievance = toxicity. This DEGRADED the model vs Entry 3 (val F1 0.675 â†’ 0.634 ceiling).
2. **No corpus in reach has quality Latin-script Hinglish slur annotations.** PRISM's Hinglish source is weak (Entry 3: inverted signal); the superset is Devanagari + political-hostility.
3. Architecture, pipeline, and compute are NOT the bottleneck â€” the same pipeline produced a 0.67 val F1 model; data quality is.

**GATE: FAIL â€” NOT integrated. Failed artifact deleted; dist/ rebuilt; audit CLEAN.**

## Updated next steps

1. **Manual data audit (highest-leverage, ~half a day):** keep ONLY rows whose labels are unambiguous under ONE definition â€” drop the hostility detection subset entirely, keep superset hasoc rows (5,982, Devanagari) + PRISM Hinglish, re-run. Expect val F1 to recover to â‰¥ Entry 3 levels with better Hinglish recall from the fixed toxic/clean ratio.
2. **Real HASOC code-mixed registration** (procedure documented earlier in this file's conversation) remains the proper fix for Latin-script Hinglish labels.
3. **Interim lexicon mode** (curated Hinglish slur list â€” e.g. Zishaanuddin/Hate_Speech_Classifier_In_Hinglish ships a 4 KB Hinglish_Profanity_List.csv) as the transparent block-tier backstop, with toxic-bert as flag-tier only. Proposed, not shipped.


=== SafeScroll Hinglish eval: fine-tuned MuRIL (quantized ONNX, local bundle) ===
Model: public/models/v3-toxic | flag_thr=0.5 block_thr=0.84 (calibrated on val, not on this set)
Set size: 20 (toxic=10, clean=10)
Operating point: score >= 0.5 => flagged toxic

Precision: 0.000
Recall:    0.000
F1:        0.000
Block-tier recall (score >= 0.84 on toxic sentences): 0.000

Per-sentence:
label=0 pred=0 toxic=0.317 block=0 :: Tu pagal hai kya, sahi se kaam kar
label=0 pred=0 toxic=0.198 block=0 :: This movie is stupid but the songs were okay
label=0 pred=0 toxic=0.352 block=0 :: Yaar aaj bahut bura din tha, mood kharab hai
label=0 pred=0 toxic=0.311 block=0 :: Bhai tera joke ekdum bakwas tha
label=0 pred=0 toxic=0.380 block=0 :: I hate it when the metro is late, so annoying
label=0 pred=0 toxic=0.254 block=0 :: Teri writing skills zero hain bhai
label=0 pred=0 toxic=0.264 block=0 :: Aaj mera team match haar gaya, dukh ho raha hai
label=0 pred=0 toxic=0.258 block=0 :: Ye product bekar hai, paise barbaad ho gaye
label=0 pred=0 toxic=0.337 block=0 :: Tu bewakoof hai jo is scam mein paise daale
label=0 pred=0 toxic=0.322 block=0 :: Mujhe ye channel pasand nahi, log stale content daalte hain
label=1 pred=0 toxic=0.298 block=0 :: Saala chor hai, sale karke bhaag gaya
label=1 pred=0 toxic=0.299 block=0 :: Randi kahin ke, baat karne layak nahi tu
label=1 pred=0 toxic=0.249 block=0 :: Bhange ke gunde desh ko barbaad kar rahe hain
label=1 pred=0 toxic=0.233 block=0 :: Tere jaise chakke desh ka naam kharab karte hain
label=1 pred=0 toxic=0.293 block=0 :: Kamina hai tu, hamesha peeche se vaar karta hai
label=1 pred=0 toxic=0.273 block=0 :: Is gandagi ko desh se bahar nikalo saalon ko
label=1 pred=0 toxic=0.224 block=0 :: Teri community ke log to harami hote hain
label=1 pred=0 toxic=0.331 block=0 :: Chutiye, apna kaam kar warna bahut bura hoga
label=1 pred=0 toxic=0.227 block=0 :: Aisi harkatein sirf namard hi kar sakte hain
label=1 pred=0 toxic=0.323 block=0 :: Suicide kar le bhai, teri zindagi bekaar hai

GATE (P>=0.7 AND R>=0.7): FAIL


---

# Entry 5 — AUDITED retrain (option 1: drop hostility subset + contradiction filter) — **FAIL** (P=0.000, R=0.000)

## Audit protocol executed (as promised: "half-day manual data audit")

1. **Dropped the entire hostility detection subset** (8,173 rows, conflicting political-hostility convention) — kept only superset hasoc rows (5,982).
2. **Manual spot-check of both label classes**: hate labels are genuine HASOC HOF-convention (dehumanizing slurs, calls to violence — verified). Clean labels contained **provable errors**: explicit sexual content and vulgar insults labeled 0.
3. **Mechanical contradiction removal**: dropped **1,249 clean-labeled rows** containing unambiguous vulgar tokens (Devanagari list of 19 high-confidence terms + 156 severity-≥4 terms from the Hinglish_Profanity_List.csv). Dropped samples verified by eye — all were genuine label errors.
4. Final: 9,477 audited rows (27.5% toxic); stratified 80/10/10; train-only oversampling (toxic x2 + Hinglish x2 → train 13,268, 42.6% toxic).

## Training (ml/train_v3.py — identical MiniLM full-FT config)

| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.5079 | 0.6208 | 0.5731 | **0.5960** ← best |
| 2.0 | 0.4746 | 0.6449 | 0.5308 | 0.5823 |

Calibration (now on the CORRECT v3 val set — a bug in calibrate_thresholds.py had been scoring v2/v3 models against the old PRISM val set; fixed and re-verified by direct recompute): flag=0.50 (P=0.62/R=0.57), block=0.84 (**P=0.91**/R=0.23), max val score 0.85.

## Gate run (quantized ONNX 118 MB, transformers.js)

| Metric | Score |
|---|---|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |

**Failure mode:** the model transferred Devanagari-Hindi hate signal and general offensiveness, but scores **Latin-script Hinglish slurs BELOW clean sentences** ("randi"=0.299, "chutiye"=0.331, "harami"=0.224 vs clean "Bhai tera joke ekdum bakwas tha"=0.311). Romanized Hinglish slur tokens are effectively invisible to models trained on Devanagari-script corpora + diluted Latin-script noise.

**GATE: FAIL — NOT integrated. Artifact deleted; dist/ rebuilt; audit CLEAN.**

## Final tally after 4 training runs

| # | Model | Data | P | R | Verdict |
|---|---|---|---|---|---|
| 1 | toxic-bert zero-shot | — | 0.000 | 0.000 | FAIL |
| 2 | MuRIL partial-FT | PRISM | 0.500 | 1.000 | FAIL |
| 3 | MiniLM full-FT | PRISM | 0.000 | 0.000 | FAIL |
| 4 | MiniLM full-FT | superset+PRISM | 0.385 | 0.500 | FAIL |
| 5 | MiniLM full-FT | AUDITED hasoc+PRISM | 0.000 | 0.000 | FAIL |

**Conclusion (high confidence, 5 independent runs):** the bottleneck is the absence of quality **Latin-script Hinglish slur supervision** in every legally-accessible corpus. Devanagari-script hate data does not transfer to romanized Hinglish. No amount of re-weighting the same data will pass the gate.

## What would actually pass the gate

1. **HASOC code-mixed track** (the one requiring registration — it IS the Latin-script Hinglish labeled corpus). Procedure documented earlier in this conversation. This is the only supervised path with proven label quality for this exact domain.
2. **Interim lexicon tier (shippable today, proposed and now ready):** the severity-graded 221-term Hinglish_Profanity_List.csv gives a transparent, explainable block/flag tier (severity ≥ 4 = block, 2–3 = flag) that covers the exact tokens every trained model missed. Zero download cost, zero ML risk, fully explainable — matches the fusion architecture's explainability constraint.
3. Weak-supervision alternative (slower): transliterate the Devanagari HASOC corpus into Latin script (indic-transliteration) and retrain — plausible but unproven; would need its own gate run.

---

# Entry 6 — v4: user-provided thread corpus + transliteration — **FAIL** (P=0.500, R=1.000)

## Data (new source discovered in D:\safescroll\hinglish)

User-provided thread-annotation archives (data-20220220T075606Z-001, 	est-…): topic folders (bantwitter, casteism, charlie hebdo, Covid Crisis, indian politics), each thread = data.json (tweet + comments) + labels.json (per-comment **HOF/NONE** — HASOC task_1 convention). Extracted via ml/extract_thread_corpus.py: **1,925 rows, 44.7% toxic, Latin-script dominant (1,926)**.

## Merge (ml/prepare_data_v4.py)

thread corpus + audited v3 (superset-hasoc Devanagari + PRISM Hinglish) + **transliteration augmentation** (4,669 Devanagari rows → Latin via ISO-15919 → ASCII diacritic strip) = 16,069 rows. Stratified 80/10/10, train-only oversample (hasoc-cm x3, toxic x2). Fixed a column-name bug (label vs labels) that silently dropped thread rows on first run. Train 22,955 (47.2% toxic), subsampled 15k for CPU wall-time.

## Training (MiniLM full-FT, same config)

| epoch | val_loss | precision | recall | f1 |
|---|---|---|---|---|
| 1.0 | 0.5208 | 0.5174 | 0.6067 | 0.5585 |
| 2.0 | 0.4863 | 0.5435 | 0.6139 | 0.5766 ← best |

## Gate (in-memory test of best checkpoint — artifact NOT exported)

| Metric | Score |
|---|---|
| Precision (thr=0.05) | 0.500 |
| Recall | 1.000 |
| F1 | 0.667 |

Same signature as Entry 2: keys on the English word "hate" ("I hate it when the metro is late" = **0.905**, the highest score in the set); all Hinglish sentences 0.095–0.15 regardless of label.

## Diagnostic — why the "real Hinglish" corpus didn't help

Of 659 HOF+pure-Latin rows, only **58 contain severity-≥4 slur terms**. The thread corpus's HOF labels are dominantly **political hostility** ("Ghulam Bhakts", "Feku", "CONgress' gulam dog") — a third label convention that doesn't supervise slur-based Hinglish attacks. This completes the root-cause proof across all six runs.

**GATE: FAIL — NOT integrated.**

## ACTION SHIPPED after this entry: interim lexicon tier

Per the approved plan: src/shared/lexicon.js (GENERATED from Hinglish_Profanity_List.csv via scripts/generate-lexicon.mjs: 156 block terms severity≥4, 38 flag terms severity 2–3, 25 ignored mild) wired into src/offscreen/offscreen.js as **Stage 0** of classification — deterministic, word-boundary matched, repeat-letter normalization ("chuuutiye"→"chutiye"), applied to post text AND OCR text, OR-fused with ML verdicts. Config added to PROFILES (dashboard renders it live). dist/ rebuilt, **audit CLEAN**.

---

# Entry 7 — PRODUCTION UPGRADE: unitary/multilingual-toxic-xlm-roberta (bundled INT8) — **English tier upgraded, wired in**

## Context

User asked to implement the multilingual toxic XLM-R model after a verification probe showed toxic-bert catches only 2/9 English identity-hate sentences. Notes: Xenova/multilingual-toxic-xlm-roberta does NOT exist (404 — that was the earlier 'Unauthorized'); the original unitary/multilingual-toxic-xlm-roberta is UNGATED and was exported to ONNX ourselves.

## Verification results (transformers.js = extension runtime, INT8 bundle)

English identity-hate probe — **8/9 caught** (toxic-bert: 2/9):
- BLOCK (>=0.9): Muslims/vermin 0.983, immigrants/cockroaches 0.956, go-back 0.977, garbage 0.995, threats 0.918
- FLAG (0.5-0.9): Jews/media 0.664, Black/criminals 0.894, trans/freaks 0.891
- Missed: women/kitchen 0.093 (blind spot shared with all tested models)
- Clean English: service/terrible 0.002, weather 0.000, metro-late 0.366 — all clean
- Known trade-off: 'This movie is stupid' scores 0.867 -> FLAG tier (not block). Documented; flag-only is acceptable per two-tier design (it never scores like a slur at BLOCK tier 0.9).

Hinglish gate: FAIL (P=0.643 R=0.900 F1=0.750 — best ML Hinglish result so far, still under gate; lexicon tier remains the Hinglish block defense).

## Two critical bugs found & fixed (IMPORTANT for future exports)

1. **num_labels=1 BCE head**: unitary model outputs ONE logit. The transformers.js text-classification pipeline applies softmax over logits -> always 1.0. Fix: AutoModel + manual sigmoid.
2. **transformers.js v2 Metaspace tokenizer bug**: tokenizers-lib >=0.13 writes only 'prepend_scheme'; transformers.js v2 reads the legacy 'add_prefix_space'. Without the patch, JS tokenization drops the word-prefix marker (▁Je->Je) and scores go wildly wrong ('Jews control the media': 0.664 correct vs 0.011 broken). Fix: patch 'add_prefix_space': true into the Metaspace pretokenizer in tokenizer.json (done in ml/export_toxic_xlmr.py + applied to the bundle). Diagnosed by comparing token IDs JS vs Python (identical after patch).

Also: unitary repo is sentencepiece-only and transformers 4.57 slow->fast conversion crashes; tokenizer sourced from xlm-roberta-base (identical 250k vocab) with fix_mistral_regex=True.

## Size & wiring

- fp32 ONNX 1,112 MB -> **INT8 265.9 MB** bundled locally (public/models/toxic-xlmr/). dist/ total 384.6 MB. **SIZE FLAG: large for an extension** (under the 2 GB CWS limit but heavy to download); acceptable because it eliminates ALL runtime model downloads for the text tier.
- Wired into src/offscreen/textClassifier.js: loads from chrome.runtime.getURL('models/toxic-xlmr/'), manual sigmoid, two-tier thresholds PROFILES.text = { hate.block: 0.90, mild.flag: 0.50 } (calibrated: 7/7 extreme blocks stay >=0.9; mild FP 'stupid movie' 0.867 stays out of block tier).
- Old toxic-bert code path removed. Lexicon tier (Stage 0) unchanged and still OR-fused.
- dist/ audit: **CLEAN**.
