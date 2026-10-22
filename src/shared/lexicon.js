// Hinglish severity-graded lexicon (221 terms + glosses, source: Hinglish_Profanity_List.csv).
// GENERATED FILE — do not hand-edit; run: node scripts/generate-lexicon.mjs
// INTERIM PRODUCTION TIER (documented in ml/TRAINING-HISTORY.md): ML fine-tunes
// failed the Hinglish gate 6x (no Latin-script slur supervision in reachable
// corpora); this deterministic tier covers the gap. Fully explainable.
// Severity: >=4 = block tier, 2-3 = flag tier, <=1 = ignored (too mild).

// ---------------------------------------------------------------------------
// ENGLISH PROFANITY / ABUSE
//
// Added because the toxicity MODEL alone does not catch meme captions.
// unitary/multilingual-toxic-xlm-roberta is trained on identity-directed hate
// speech, so a profane imperative aimed at nobody ("GO FUCK YOURSELF") is
// scored well below the 0.50 flag threshold and reported as CLEAN — the image
// then never blurred. Verified: the text model did not flag it, this list does.
//
// Block tier = direct profanity/insult. Flag tier = crude or harassing but not
// a direct slur. Matching is whole-token (see lexiconCheck), so "ass" in
// "class" or "Scunthorpe" cannot trigger it.
// ---------------------------------------------------------------------------
const EN_BLOCK_TERMS = [
  'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'motherfucking',
  'shit', 'shitty', 'bullshit', 'bastard', 'bitch', 'bitches',
  'cunt', 'wanker', 'twat', 'prick', 'dickhead', 'cockhead',
  'asshole', 'arsehole', 'assholes', 'dumbass', 'jackass',
  'whore', 'slut', 'faggot', 'fag', 'retard', 'retarded',
  'nigger', 'nigga', 'faggot', 'tranny', 'coon', 'kike', 'spic', 'wetback',
  'rape', 'rapist', 'pedo', 'paedo', 'pedophile',
  'kill yourself', 'kys', 'neck yourself', 'hang yourself',
  'worthless piece of garbage', 'nobody would miss you', 'nobody would even miss you',
  'vermin', 'subhuman', 'animals', 'filth', 'scum'
];

const EN_FLAG_TERMS = [
  'damn', 'damned', 'goddamn', 'crap', 'piss', 'pissed', 'arse', 'ass',
  'dick', 'cock', 'pussy', 'twatty', 'wank', 'bollocks', 'balls',
  // NOTE: 'stupid', 'moron', 'idiot' and 'loser' are deliberately ABSENT.
  // The project's own calibration control is "This movie is stupid but the
  // songs were okay" — it must score as mild, never as a lexicon hit. Putting
  // 'stupid' in a flag list would flag every mildly-critical review on the web,
  // which is the exact false-positive class the tier is supposed to avoid.
  // Mild negativity is the ML model's job (PROFILES.text.mild.flag), not the
  // lexicon's: the lexicon exists for profanity and abuse, which the model
  // systematically under-scores.
  'scumbag', 'shameless', 'disgusting', 'revolting'
];

// Multi-word terms ("kill yourself", "go fuck yourself") cannot be matched
// token-by-token without false positives, so they get a whole-string pass.
const EN_PHRASE_BLOCK = [
  'kill yourself', 'kys', 'neck yourself', 'hang yourself',
  'worthless piece of garbage', 'nobody would miss you', 'nobody would even miss you',
  'go fuck yourself', 'screw you', 'eat shit'
];
const EN_PHRASE_FLAG = ['shut up', 'go to hell', 'kiss my ass', 'kiss off', 'get lost'];

const BLOCK_TERMS = [
  "chutia",
  "ghasti",
  "chutiye",
  "chutye",
  "chutiya",
  "haraami",
  "haraam",
  "bahenchod",
  "bahanchod",
  "bahencho",
  "bancho",
  "bahenke",
  "laude",
  "takke",
  "betichod",
  "bhaichod",
  "jhalla",
  "jhant",
  "nabaal",
  "maadherchod",
  "madarchod",
  "padma",
  "raand",
  "jamai",
  "randwa",
  "randi",
  "bachachod",
  "bachichod",
  "bachchechod",
  "banda",
  "booblay",
  "booby",
  "buble",
  "babla",
  "bhonsriwala",
  "bhonsdiwala",
  "ched",
  "chut",
  "chod",
  "chodu",
  "chodra",
  "choochi",
  "chuchi",
  "gaandu",
  "gandu",
  "gaand",
  "lavda",
  "lawda",
  "lauda",
  "lund",
  "balchod",
  "lavander",
  "muth",
  "maacho",
  "mammey",
  "tatte",
  "toto",
  "toota",
  "bhandwe",
  "bhosadchod",
  "bhosad",
  "bumchod",
  "bum",
  "bur",
  "cunt",
  "cuntmama",
  "jhaat",
  "chodela",
  "bhagatchod",
  "chhola",
  "chudai",
  "chudaikhana",
  "chunni",
  "choot",
  "fateychu",
  "lundtopi",
  "gaandfat",
  "gaandmasti",
  "makhanchudai",
  "gaandmarau",
  "chaatu",
  "beej",
  "choosu",
  "fakeerchod",
  "lundoos",
  "shorba",
  "bhadwe",
  "parichod",
  "nirodh",
  "pucchi",
  "baajer",
  "choud",
  "bhosda",
  "sadi",
  "choos",
  "maka",
  "chinaal",
  "gadde",
  "chullugand",
  "gandkate",
  "bambu",
  "hazaarchu",
  "paidaishikeeda",
  "kali",
  "behendi",
  "chus",
  "machudi",
  "chodoonga",
  "baapchu",
  "laltern",
  "suhaagchudai",
  "raatchuda",
  "kaalu",
  "neech",
  "chikna",
  "meetha",
  "beechka",
  "chooche",
  "patichod",
  "rundi",
  "biwichod",
  "chodhunga",
  "jhanten",
  "raandsaala",
  "phudi",
  "chute",
  "kussi",
  "khandanchod",
  "ghussa",
  "maarey",
  "budh",
  "chodun",
  "chode",
  "chodho",
  "mulle",
  "mulli",
  "musalman",
  "momedan",
  "katua",
  "chutiyapa",
  "bc",
  "mc",
  "chudwaya",
  "vahiyaat",
  "jihadi",
  "atankvadi",
  "atankwadi",
  "aatanki",
  "bhosidika",
  "bhosdike",
  "bhosadike",
  "bhosadiwala",
  "bhosadi",
  "bhosdi",
  "bhosidi",
  "bhosadiwale"
];

const FLAG_TERMS = [
  "bhadva",
  "bhootnika",
  "chinaal",
  "hijra",
  "hinjda",
  "kutta",
  "kutiya",
  "auladheen",
  "najayaz",
  "gandpaidaish",
  "sala",
  "saala",
  "kutti",
  "suwar",
  "soover",
  "tatti",
  "potty",
  "pissu",
  "kutte",
  "soower",
  "backar",
  "gandnatije",
  "binbheja",
  "joon",
  "danda",
  "keera",
  "keeda",
  "safaid",
  "poot",
  "kute",
  "kaat",
  "gandi",
  "bimaar",
  "badboodar",
  "dum",
  "chatri",
  "kutton",
  "jungli"
];

const MILD_TERMS = [
  "badir",
  "badirchand",
  "bakland",
  "chup",
  "jaanvar",
  "khota",
  "jaat",
  "bhains",
  "ullu",
  "pathe",
  "chatani",
  "chipkali",
  "pasine",
  "bhoot",
  "dhakkan",
  "bhajiye",
  "doob",
  "khatmal",
  "lassan",
  "makkhi",
  "haathi",
  "gadha",
  "chipkili",
  "unday",
  "chaarpai"
];

// Normalize for matching: lowercase, strip punctuation, collapse repeated letters
// (chuuutiye -> chuutiye), drop diacritics.
export function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z\u0900-\u097F\s]/g, ' ')
    .replace(/(.)\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ');
}

const TOKEN_RE = /[a-z\u0900-\u097F]+/g;

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
    const variants = [tok, tok.replace(/(.)\1+/gu, '$1')];
    let tier = null, term = tok;
    for (const v of variants) {
      if (EN_BLOCK_TERMS.includes(v)) { tier = 'block'; term = v; break; }
      if (!tier && EN_FLAG_TERMS.includes(v)) { tier = 'flag'; term = v; }
    }
    if (!tier) {
      for (const v of variants) {
        if (BLOCK_TERMS.includes(v)) { tier = 'block'; term = v; break; }
        if (!tier && FLAG_TERMS.includes(v)) { tier = 'flag'; term = v; }
      }
    }
    if (tier) hits.push({ term, tier });
  }
  // Whole-string phrase pass. Multi-word terms ("kill yourself", "go fuck
  // yourself") cannot be matched token-by-token without false-positives, so
  // they are matched against the whole normalised string.
  for (const p of EN_PHRASE_BLOCK) if (text.includes(p)) hits.push({ term: p, tier: 'block' });
  for (const p of EN_PHRASE_FLAG) if (text.includes(p)) hits.push({ term: p, tier: 'flag' });

  if (hits.some(h => h.tier === 'block')) return { action: 'block', hits };
  if (hits.length) return { action: 'flag', hits };
  return null;
}
