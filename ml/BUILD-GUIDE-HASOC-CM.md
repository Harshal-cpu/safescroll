# SafeScroll Build Guide: HASOC-CM + Transliteration

Simple-language plan for training a Hinglish toxicity model that can actually
pass our 0.7 precision/recall gate. Written after 5 failed gate runs — this
plan targets the exact root cause we found (no Latin-script Hinglish labels).

---

## The problem in one paragraph

Our models keep failing because they never see enough **romanized (Latin
letter) Hinglish** hate speech during training. We have plenty of
Devanagari-Hindi data (देवनागरी), but "randi", "chutiye", "harami" written in
English letters are invisible to them. This plan fixes that with two moves:
**real Hinglish labels** (HASOC code-mixed track) + **synthetic Hinglish**
(converting our Devanagari data to Latin letters).

---

## What YOU do (one-time, ~10 minutes)

1. Open the HASOC Google Drive folder you got after registration.
2. Download the **Code-Mixed** track files (folder may say `CM`,
   `code-mixed`, or `Hindi-English`). Ignore the main Hindi/English/German
   tracks — we already have that signal.
3. Drop the files into: `D:\safescroll\ml\data\hasoc\`
4. Tell me: "hasoc files are in".

---

## What I do (the build, in steps)

### Step 1 — Inspect + load HASOC-CM (15 min)
Check the TSV: text column, labels (HOF = hate/offensive, NOT = clean),
row count, script check (confirm it's really Latin-script).
**Output:** `ml/data/hasoc_cm.csv` with columns `text, labels`.

### Step 2 — Transliteration augmentation (1–2 hrs build, instant to run)
Convert our 5.6k audited Devanagari hate rows into Latin letters using
`indic-transliteration` (Python package). Example:

> जेहादी सूअरों को देश से बाहर निकालो
> → "jehadi suvaron ko desh se bahar nikalo" (label stays 1)

Each row gets 2–3 spelling variants ("suvar"/"suar"/"swar") because people
romanize words differently. Labels are guaranteed correct because we only
change spelling, not meaning.
**Output:** extra ~12–15k synthetic Hinglish rows.

### Step 3 — Merge all sources (30 min)
| Source | Rows | Role |
|---|---|---|
| HASOC code-mixed | ~4–5k | Real Hinglish labels |
| Transliterated Devanagari | ~12–15k | Synthetic Hinglish volume |
| Superset-HASOC Devanagari (audited v3) | 5.6k | Real Devanagari coverage |
| PRISM Hinglish (audited) | 4.7k | Extra Latin-script rows |

Same audit rules as v3: drop provable label errors, dedup, stratified
80/10/10 split FIRST, oversample train-only.
**Output:** `ml/prepared_v4/{train,val,test}.csv` + stats printed.

### Step 4 — Train IndicBERT (30–60 min on CPU, ~10 min on free Colab GPU)
Base model: `ai4bharat/indic-bert` (~33M params — the only one that fits the
50–80 MB extension size target; you must accept its HF gate with your
account first).
- Full fine-tune, binary head (toxic / non-toxic)
- 2–3 epochs, early stopping, best checkpoint by validation F1
- Metrics logged per epoch to `eval/training_log.md`
**Output:** `ml/model-v4/best`

### Step 5 — Export to ONNX + INT8 (10 min)
`optimum` export + dynamic quantization. Expected size: **~33 MB** ✓
**Output:** `public/models/v4-toxic/`

### Step 6 — Calibrate thresholds on validation set (10 min)
Find: flag threshold (best F1) and block threshold (high precision ~0.85+).
**Output:** `ml/prepared/thresholds-v4.json`

### Step 7 — THE GATE (5 min, pass/fail)
Run the 20-sentence hand-picked Hinglish eval set through the quantized
model via transformers.js — the exact same test all 5 previous models failed.
- **PASS = P ≥ 0.7 AND R ≥ 0.7** → go to Step 8
- **FAIL** → document in RESULTS.md, keep toxic-bert, fall back to the
  lexicon tier (already built: 221 severity-graded slur terms)

### Step 8 — Wire into SafeScroll (30 min, only if PASS)
- Replace toxic-bert with the new model in `src/offscreen/textClassifier.js`
- Load weights from the local bundle (no new CDN — same CSP pattern)
- Update the two-tier thresholds in `src/shared/profiles.js`
- Keep the explainable OR-fusion unchanged

### Step 9 — Rebuild + compliance re-check (10 min)
- `npm run build`
- `node scripts/audit-remote-code.mjs` must print CLEAN
- Re-grep for any new embedded hub URLs in the ONNX/config files
- Update `eval/RESULTS.md` with the PASS entry + model size

---

## Timeline if you get HASOC-CM files today

| When | What |
|---|---|
| Hour 0 | You download files → I inspect + build pipeline |
| Hour 1–2 | Transliteration augmentation + merge + training starts |
| Hour 2–3 | Export, calibrate, GATE verdict |
| Hour 3–4 (if PASS) | Wired in, rebuilt, audited, packaged |

## Risks (honest)

1. **HASOC-CM is small (~4–5k rows)** — that's why transliteration is in the
   plan; synthetic data multiplies the signal 3×.
2. **Transliterated text isn't identical to human romanization** — spelling
   variety is mitigated with multiple variants per row; the real HASOC-CM
   rows anchor natural spelling.
3. **IndicBERT is gated on HF** — you accept its license once with your
   account (same flow as the superset), give me the token, done.
4. If the gate still fails → we ship the lexicon tier as interim and keep
   the model out. No fake shipping, ever.
