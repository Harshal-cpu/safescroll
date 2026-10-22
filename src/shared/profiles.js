// Single source of truth for moderation thresholds.
// The options dashboard renders its reference table by asking the OFFSCREEN
// document for THIS live object (message: {type:'get-profiles'}) — never a
// hardcoded copy — so the UI can never drift from the enforcement config.
export const PROFILES = {
  lexicon: {
    // Deterministic, explainable tier. Runs in ~0ms and never misfires on tone.
    //
    // ENABLED. It used to be off ("English-only mode"), but the Hinglish word
    // list is not the only thing in here — see shared/lexicon.js, which now also
    // carries an English profanity/abuse list. That list is what catches meme
    // captions like "GO FUCK YOURSELF": the toxicity model is trained on
    // identity-directed hate, so a profane command with no target scores well
    // below the 0.50 flag threshold and was being reported as CLEAN while the
    // image stayed unblurred.
    enabled: true,
    terms: { block: 156, flag: 38, mild: 25, en: 0 } // counts only; lists live in shared/lexicon.js
  },
  image: {
    enabled: true,
    // NSFWJS classes after canonicalisation: drawings, hentai, neutral,
    // porn, sexy. The package itself emits Title Case and singular "Drawing";
    // imageClassifier.js normalises those labels before applying this policy.
    nsfw: {
      blockClasses: ['porn', 'hentai'],
      block: 0.70,
      // FLAG tier: porn/hentai at 0.5 OR explicit-sexy at a HIGH bar (0.85).
      // ('sexy' scores ~0.4-0.6 on ordinary photos — flagging it blurred
      // everything; verified via CDP on live feeds.)
      flag: 0.50,
      sexyFlag: 0.85,
      // 'drawings' is excluded from flaging entirely (anime/art false positives)
      ignoreClassesForFlag: ['drawings', 'neutral']
    },
    // On-device multi-label ResNet-50. `violence` includes physical harm,
    // fighting and blood; `sensitive` includes medical/blood imagery. Gore is
    // intentionally the joint signal rather than `sensitive` alone, so an
    // ordinary medical diagram does not get treated like graphic violence.
    violence: {
      block: 0.82,
      // The browser smoke probe showed a flat skin-tone gradient at 0.617,
      // while five labeled violence frames scored 0.950-1.000 and five
      // non-violence frames scored 0.000-0.010. Keep a margin above that
      // synthetic false-positive without weakening the high-confidence hits.
      flag: 0.70,
      goreBlock: 0.70,
      goreFlag: 0.50,
      weaponFlag: 0.88
    }
  },
  text: {
    // Multilingual toxic-xlmr (bundled): single sigmoid score, two tiers.
    // Calibrated on the English identity-hate probe + mild FP control
    // (eval/RESULTS.md Entry 7): block=0.9 keeps 7/7 extreme blocks while
    // "this movie is stupid" (0.867) stays at flag, not block.
    hate: { block: 0.90 },
    mild: { flag: 0.50 }
  },
  ocr: {
    // ON by default — it moved OFF the critical path, so it no longer delays
    // the blur. Text verdicts are returned in ~160ms; the OCR tier runs
    // afterwards in the media pass and can only ever ADD a block, never delay
    // or downgrade one. Still rate-limited by a token bucket (see offscreen.js)
    // so a gallery of images cannot turn into minutes of WASM.
    enabled: true,
    // MEME-TEXT QUALITY. Four independent causes of "OCR does not work", all
    // fixed: capture resolution was 448px (now 900px — see extract.js
    // maybeRaster); no preprocessing (now grayscale + Otsu + inversion
    // variants in ocr.js); wrong page segmentation (now PSM SINGLE_BLOCK with
    // a sparse/otsu/inverted fallback ladder); and a first-pass-wins bug that
    // let confident background noise beat the real caption (now scored by
    // plausibility x confidence, with escalation).
    //
    // THRESHOLDS ARE NOW ACTUALLY USED. ocr.hate/ocr.mild were dead config —
    // OCR'd text was scored by classifyText() against PROFILES.text, so a meme
    // caption was judged as if it were a tweet. Captions are a different
    // distribution: short, imperative, profane, not identity-directed.
    hate: { block: 0.70 },
    mild: { flag: 0.35 }
  },
  // Streaming: a decisive TEXT verdict is returned to the page immediately and
  // the media tiers refine it afterwards, so hate speech is blurred in ~160ms
  // instead of waiting behind image fetches. When false, a single fused verdict
  // is returned once every tier has run.
  streamEarlyText: true,
  fusion: {
    // Explainable rule, no learned fusion:
    // BLOCK if (lexicon.block) OR (text.block) OR (image NSFW/violence.block)
    //          OR (ocr-text.block)
    // FLAG  if any flag threshold crossed
    rule: 'OR'
  },
  childMode: {
    enabled: false,
    pinHash: null, // sha-256 hex of 4-digit PIN — UNSALTED, SINGLE-ROUND: documented limitation
    blockMild: true
  }
};
