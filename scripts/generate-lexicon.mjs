// Generates src/shared/lexicon.js from ml/data/hinglish_profanity_list.csv.
// Run: node scripts/generate-lexicon.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync('ml/data/hinglish_profanity_list.csv', 'latin1');
const terms = { block: new Set(), flag: new Set(), mild: new Set() };

for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [termRaw, gloss, sevRaw] = line.split(',');
  const term = termRaw.toLowerCase().trim();
  const sev = parseInt(sevRaw, 10);
  if (!term || Number.isNaN(sev)) continue;
  if (sev >= 4) terms.block.add(term);
  else if (sev >= 2) terms.flag.add(term);
  else terms.mild.add(term);
}

const arr = name => {
  const key = { BLOCK_TERMS: 'block', FLAG_TERMS: 'flag', MILD_TERMS: 'mild' }[name];
  return `const ${name} = ${JSON.stringify([...terms[key]], null, 0).replaceAll('","', '",\n  "').replace('[', '[\n  ').replace(']', '\n]')};`;
};

const out = `// Hinglish severity-graded lexicon (221 terms + glosses, source: Hinglish_Profanity_List.csv).
// GENERATED FILE — do not hand-edit; run: node scripts/generate-lexicon.mjs
// INTERIM PRODUCTION TIER (documented in ml/TRAINING-HISTORY.md): ML fine-tunes
// failed the Hinglish gate 6x (no Latin-script slur supervision in reachable
// corpora); this deterministic tier covers the gap. Fully explainable.
// Severity: >=4 = block tier, 2-3 = flag tier, <=1 = ignored (too mild).

${arr('BLOCK_TERMS')}

${arr('FLAG_TERMS')}

${arr('MILD_TERMS')}

// Normalize for matching: lowercase, strip punctuation, collapse repeated letters
// (chuuutiye -> chuutiye), drop diacritics.
export function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\\p{M}/gu, '')
    .replace(/[^a-z\\u0900-\\u097F\\s]/g, ' ')
    .replace(/(.)\\1{2,}/gu, '$1$1')
    .replace(/\\s+/g, ' ');
}

const TOKEN_RE = /[a-z\\u0900-\\u097F]+/g;

// Word-boundary token match with spelling-variant handling:
//  - text norm: repeats collapsed to 2 (chuuut -> chut-2)
//  - per-token variant: repeats collapsed to 1 (chuutiye -> chutiye, raandi -> randi)
// Returns {action:'block'|'flag', hits:[{term,tier}]} or null.
export function lexiconCheck(rawText) {
  const text = normalizeText(rawText);
  if (!text) return null;
  const tokens = text.match(TOKEN_RE) || [];
  const hits = [];
  for (const tok of tokens) {
    const variants = [tok, tok.replace(/(.)\\1+/gu, '$1')];
    let tier = null, term = tok;
    for (const v of variants) {
      if (BLOCK_TERMS.includes(v)) { tier = 'block'; term = v; break; }
      if (!tier && FLAG_TERMS.includes(v)) { tier = 'flag'; term = v; }
    }
    if (tier) hits.push({ term, tier });
  }
  if (hits.some(h => h.tier === 'block')) return { action: 'block', hits };
  if (hits.length) return { action: 'flag', hits };
  return null;
}
`;

writeFileSync('src/shared/lexicon.js', out);
console.log(`written: block=${terms.block.size} flag=${terms.flag.size} mild=${terms.mild.size}`);
