// Single source of truth for moderation thresholds.
// The options dashboard renders its reference table by asking the OFFSCREEN
// document for THIS live object (message: {type:'get-profiles'}) — never a
// hardcoded copy — so the UI can never drift from the enforcement config.
export const PROFILES = {
  lexicon: {
    // INTERIM Hinglish tier — DISABLED per project decision (English-only at
    // this time). Fully implemented (156 block / 38 flag terms in
    // shared/lexicon.js); flip enabled=true to restore Hinglish coverage.
    enabled: false,
    terms: { block: 156, flag: 38, mild: 25 } // counts only; actual lists live in shared/lexicon.js
  },
  image: {
    // nsfwjs classes: drawings, hentai, neutral, porn, sexy
    nsfw: {
      blockClasses: ['porn', 'hentai'],
      block: 0.70,
      // FLAG tier: porn/hentai at 0.5 OR explicit-sexy at a HIGH bar (0.85).
      // ('sexy' scores ~0.4-0.6 on ordinary photos — flagging on it blurred
      // everything; verified via CDP on live feeds.)
      flag: 0.50,
      sexyFlag: 0.85,
      // 'drawings' is excluded from flagging entirely (anime/art false positives)
      ignoreClassesForFlag: ['drawings', 'neutral']
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
    hate: { block: 0.70 },
    mild: { flag: 0.60 }
  },
  fusion: {
    // Explainable rule, no learned fusion:
    // BLOCK if (lexicon.block) OR (text.block) OR (image.block) OR (ocr-text.block)
    // FLAG  if any flag threshold crossed
    rule: 'OR'
  },
  childMode: {
    enabled: false,
    pinHash: null, // sha-256 hex of 4-digit PIN — UNSALTED, SINGLE-ROUND: documented limitation
    blockMild: true
  }
};
