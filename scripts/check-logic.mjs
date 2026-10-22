// Standalone check of the windowing + chrome-exclusion + host-resolution logic
// in plain Node (no DOM deps). Guards the two regressions that are invisible in
// a build: a windowing bug that drops the toxic sentence, and a hash that
// changes between calls.
//
//   node scripts/check-logic.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// --- pull windowText + its constants straight out of the shipped source so we
// --- test the real implementation rather than a copy that can drift.
const src = readFileSync(new URL('../src/offscreen/textClassifier.js', import.meta.url), 'utf8');
const start = src.indexOf('export function windowText');
const end = src.indexOf('\nasync function scoreOne');
const consts = ['MAX_TOKENS', 'CHARS_PER_TOKEN', 'WINDOW_CHARS', 'OVERLAP_CHARS', 'MAX_WINDOWS']
  .map(n => src.match(new RegExp(`^const ${n} = .*$`, 'm'))?.[0])
  .filter(Boolean)
  .join('\n');
const fnSrc = `${consts}\n${src.slice(start, end)}`;
const { windowText } = await import(
  'data:text/javascript;base64,' + Buffer.from(fnSrc).toString('base64')
);
const WINDOW_CHARS = Math.floor(128 * 3.2 * 0.72); // mirrors textClassifier.js

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- windowing
check('short text -> single window', windowText('hello world').length === 1);

const long = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} about the weather today.`).join(' ');
const wins = windowText(long);
check('long text -> multiple windows', wins.length > 1, `${wins.length} windows`);
check('windows respect the token budget', wins.every(w => w.length <= WINDOW_CHARS + 40),
  `max=${Math.max(...wins.map(w => w.length))} limit=${WINDOW_CHARS}`);
check('window count is capped', windowText(long, 3).length === 3);
check('coverage: no sentence lost', (() => {
  // Every window must start at a non-overlapping-enough offset; we check that
  // the first and last content of the source appear in some window.
  const joined = wins.join(' ');
  return joined.includes('Sentence number 0') &&
         joined.includes(`Sentence number ${299}`);
})());

// The regression that motivated windowing: toxicity at the very END of a long
// unit must still be inside some window.
const toxicTail = Array.from({ length: 250 }, (_, i) => `Neutral sentence ${i}.`).join(' ') +
  ' Muslims are vermin and should be exterminated from this land forever.';
const tailWins = windowText(toxicTail);
const toxicSentence = 'Muslims are vermin and should be exterminated from this land forever.';
check('toxic sentence at the tail survives windowing', tailWins.some(w => w.includes(toxicSentence)),
  `${tailWins.length} windows`);

// Windows must not split mid-sentence in a way that loses the phrase.
check('no window cuts the toxic phrase', !tailWins.some(w => w.includes('exterminated') && !w.includes('Muslims are vermin')));

// ---------------------------------------------------------------- sync hash
// The content-script dedupe key must be a stable identity, and must not depend
// on crypto.subtle (undefined on http://).
const extractSrc = readFileSync(new URL('../src/content/extract.js', import.meta.url), 'utf8');
const qhStart = extractSrc.indexOf('export function quickHash');
const qhEnd = extractSrc.indexOf('\n}\n', qhStart) + 3;
const { quickHash } = await import(
  'data:text/javascript;base64,' + Buffer.from(extractSrc.slice(qhStart, qhEnd)).toString('base64')
);
const s = 'gen::You are a worthless piece of garbage::https://cdn.example.com/a.jpg:42';
check('quickHash is deterministic', quickHash(s) === quickHash(s));
check('quickHash separates different content', quickHash(s) !== quickHash(s + 'x'));
check('quickHash output is 16 hex chars', /^[0-9a-f]{16}$/.test(quickHash(s)));

// ---------------------------------------------------- pre-verdict / X coverage
// These are pipeline-wiring guarantees rather than model-policy checks. A
// loading shield must exist before classification starts, and X must admit
// short text plus user-authored surfaces that do not live in tweet articles.
const contentSrc = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const registerStart = contentSrc.indexOf('function registerUnit');
const registerEnd = contentSrc.indexOf('\nfunction buildUnits', registerStart);
const registerBody = contentSrc.slice(registerStart, registerEnd);
check('new units receive a pre-verdict loading shield',
  registerBody.includes('createShield(el') && registerBody.includes("action: 'loading'"));
check('loading shield is installed before registry registration',
  registerBody.indexOf('createShield(el') < registerBody.indexOf('register(key, el, shields)'));

const adapterSrc = readFileSync(new URL('../src/content/adapters.js', import.meta.url), 'utf8');
const { mediaElementFor } = await import(new URL('../src/content/adapters.js', import.meta.url));
let missingUnitMediaCalls = 0;
check('stale units never reach adapter media targeting',
  mediaElementFor({ mediaEl: () => { missingUnitMediaCalls++; } }, null) === null &&
  missingUnitMediaCalls === 0 && contentSrc.includes('mediaElementFor(adapter, liveUnit)') &&
  contentSrc.includes('if (!latestNode) return;'));
check('X scans profile bios outside tweets', adapterSrc.includes('[data-testid="UserDescription"]'));
check('X scans direct-message entries outside tweets', adapterSrc.includes('[data-testid="messageEntry"]'));
check('X admits short toxic text below the generic 24-character floor',
  adapterSrc.includes('minChars: 4') && contentSrc.includes('unit.minChars'));
check('Instagram emits comments as independent moderation units',
  adapterSrc.includes('INSTAGRAM_COMMENT_SELECTOR') &&
  adapterSrc.includes('instagramCommentElements(root)'));
check('Instagram supports current div-based comment rows',
  adapterSrc.includes("'article ul > div'") &&
  adapterSrc.includes("'[role=\"dialog\"] ul > div'"));
check('Instagram isolates post captions from comment text',
  adapterSrc.includes('instagramPostTexts(el)') &&
  adapterSrc.includes('instagramCommentText(el)'));
check('Instagram comment text excludes the author-row fallback',
  adapterSrc.includes('if (!single || !parts.length)'));
check('Reddit has a first-class post and comment adapter',
  adapterSrc.includes('export const redditAdapter') &&
  adapterSrc.includes('shreddit-post') &&
  adapterSrc.includes('shreddit-comment'));
check('Reddit augments stable selectors with universal feed and media discovery',
  adapterSrc.includes('detectUnitElements(root, { viewportOnly: true })') &&
  adapterSrc.includes('REDDIT_FALLBACK_POST_SELECTOR') &&
  adapterSrc.includes('REDDIT_AUXILIARY_SELECTOR'));
check('Reddit supports homepage/community feed tracker roots',
  adapterSrc.includes('faceplate-tracker[source="post"]') &&
  adapterSrc.includes('article[role="article"]'));
check('Reddit supports profile and community descriptions',
  adapterSrc.includes('[data-testid="profile-description"]') &&
  adapterSrc.includes('[data-testid="community-description"]'));
check('Reddit normalises custom post hosts to their visible article wrapper',
  adapterSrc.includes('redditPostRoot') &&
  adapterSrc.includes('REDDIT_POST_WRAPPER_SELECTOR'));
check('Reddit text shields avoid unrendered Shadow DOM hosts',
  adapterSrc.includes('redditRenderableTextTarget'));
check('Reddit media targeting follows the extracted image',
  adapterSrc.includes('unit.images?.[0]?.el'));
check('Reddit rejects the whole main-content page shell',
  adapterSrc.includes('isRedditPageShell(candidate)'));
check('Reddit hostnames select the Reddit adapter',
  adapterSrc.includes("host === 'reddit.com'") &&
  adapterSrc.includes("host.endsWith('.reddit.com')") &&
  adapterSrc.includes('return redditAdapter'));
check('Reddit remains enabled when scope is limited to core sites',
  /CORE_HOSTS = \/[^\n]*reddit/.test(contentSrc));
check('dashboard core-site label includes Reddit',
  readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8')
    .includes('Instagram, X, Reddit and YouTube'));
check('content script paints deterministic lexicon hits before model transport',
  contentSrc.indexOf('lexiconCheck(unit.text)') < contentSrc.indexOf('async function classifyUnit'));
check('single-threaded text inference concurrency is bounded',
  /const MAX_INFLIGHT = 2;/.test(contentSrc));
const ioStart = contentSrc.indexOf('const io = new IntersectionObserver');
const ioEnd = contentSrc.indexOf('// ------------------------------------------------------------- MutationObserver', ioStart);
const ioBody = contentSrc.slice(ioStart, ioEnd);
check('below-fold units remain observed until they enter the scan band',
  ioBody.includes('if (!e.isIntersecting) continue;') &&
  !/if \(!e\.isIntersecting\)[\s\S]{0,100}io\.unobserve/.test(ioBody));
check('viewport scanning starts before a post becomes visible',
  ioBody.includes('rootMargin: `${PRELOAD_MARGIN}px 0px`'));
check('text and lazy-media mutations trigger rescanning',
  contentSrc.includes('characterData: true') &&
  contentSrc.includes("attributeFilter: ['src', 'srcset', 'poster', 'href', 'data-testid']"));
check('recycled feed nodes receive a new content identity',
  contentSrc.includes('existingKey && existingKey !== key') && contentSrc.includes('removeEntry(boundKey)'));
check('stale async verdicts cannot paint a recycled node',
  contentSrc.includes('if (!owner || owner === key) return el;'));
check('X inner mutations resolve to their containing post',
  adapterSrc.includes('containingUnit(node)') && adapterSrc.includes("closest('article[data-testid=\"tweet\"]')"));
check('content identity includes toxic text appended after preview truncation',
  !adapterSrc.includes('.text.slice(0,'));
check('lazy-loaded image sets bypass stale per-post media dedupe',
  contentSrc.includes('const mediaRequested = new Map()') &&
  contentSrc.includes('mediaRequested.get(key) === fingerprint') &&
  contentSrc.includes('refreshExistingMedia(existingKey, el, unit)'));
const {
  classify: bridgeClassify,
  isExtensionContextInvalidatedError,
  onExtensionContextInvalidated
} = await import(
  new URL('../src/content/bridge.js', import.meta.url)
);
check('extension reload invalidation is recognised',
  isExtensionContextInvalidatedError(new Error('Extension context invalidated.')) &&
  !isExtensionContextInvalidatedError(new Error('Could not establish connection.')));
let invalidationNotices = 0;
let invalidationSends = 0;
globalThis.chrome = {
  runtime: {
    sendMessage: async () => {
      invalidationSends++;
      throw new Error('Extension context invalidated.');
    }
  }
};
onExtensionContextInvalidated(() => { invalidationNotices++; });
const invalidatedVerdict1 = await bridgeClassify({ text: 'first' });
const invalidatedVerdict2 = await bridgeClassify({ text: 'second' });
check('extension reload stops repeated transport attempts',
  invalidationSends === 1 && invalidationNotices === 1 &&
  invalidatedVerdict1.reason === 'context-invalidated' &&
  invalidatedVerdict2.reason === 'context-invalidated');
delete globalThis.chrome;
check('invalidated content scripts stop observers and queues',
  contentSrc.includes('onExtensionContextInvalidated(() => stopContentScript') &&
  contentSrc.includes('mo.disconnect()') && contentSrc.includes('queue.length = 0'));
check('high-volume DOM lifecycle logs are opt-in',
  contentSrc.includes('globalThis.__SAFESCROLL_DEBUG__ !== true'));

const offscreenSrc = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
check('lexicon blocks skip redundant model inference',
  offscreenSrc.includes("lexVerdict.action === 'block'") && offscreenSrc.includes('skipped-lexicon-block'));
check('OCR visible wait is bounded to six seconds', /const OCR_WAIT_MS = 6000;/.test(offscreenSrc));
check('unsafe image verdict is published before waiting for OCR',
  offscreenSrc.indexOf('await onImageVerdict(iv)') < offscreenSrc.indexOf('ocrResult = await Promise.race'));
check('offscreen media dedupe is based on the current image fingerprint',
  offscreenSrc.includes('mediaDone.get(key) === fp') &&
  !offscreenSrc.includes("skipped: 'already-have-media-verdict'"));

const imageClassifierSrc = readFileSync(new URL('../src/offscreen/imageClassifier.js', import.meta.url), 'utf8');
check('image URL fallback has a near-real-time fetch budget',
  /const FETCH_BUDGET_MS = 2500;/.test(imageClassifierSrc));

const textClassifierSrc = readFileSync(new URL('../src/offscreen/textClassifier.js', import.meta.url), 'utf8');
check('single-threaded model calls are serialized instead of contending',
  textClassifierSrc.includes('inferenceTail.then(run, run)'));

// --------------------------------------------------------------- UI wiring
// A production build cannot detect a getElementById typo; the module would
// simply throw when the popup/options page opens. Assert every direct hook is
// still present after layout redesigns, and keep removed diagnostic sections
// from drifting back into the dashboard.
for (const [name, htmlPath, jsPath] of [
  ['popup', '../src/popup/popup.html', '../src/popup/popup.js'],
  ['dashboard', '../src/options/options.html', '../src/options/options.js']
]) {
  const html = readFileSync(new URL(htmlPath, import.meta.url), 'utf8');
  const js = readFileSync(new URL(jsPath, import.meta.url), 'utf8');
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  check(`${name} JavaScript hooks all exist in its HTML`,
    ids.every(id => html.includes(`id="${id}"`)),
    ids.filter(id => !html.includes(`id="${id}"`)).join(', '));
}
const optionsHtmlSrc = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
const optionsJsSrc = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');
check('removed dashboard sections stay removed',
  !/Feedback corrections|Live moderation thresholds|Test any text/.test(optionsHtmlSrc) &&
  !/testBtn|renderThresholds|exportJson|exportCsv/.test(optionsJsSrc));
check('popup and dashboard use the modern shared visual language',
  readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8').includes('popup.css') &&
  optionsHtmlSrc.includes('options.css'));

// The in-page disclaimer must shrink with short X text regions. The reported
// regression was a roughly 646×100 target, where the old fixed four-row card
// clipped both its title and buttons.
const shieldSrc = readFileSync(new URL('../src/content/shield.js', import.meta.url), 'utf8');
const layoutStart = shieldSrc.indexOf('export function shieldLayoutForSize');
const layoutEnd = shieldSrc.indexOf('\n}', layoutStart) + 2;
const { shieldLayoutForSize } = await import(
  'data:text/javascript;base64,' + Buffer.from(shieldSrc.slice(layoutStart, layoutEnd)).toString('base64')
);
check('shield uses full layout when both dimensions have room',
  shieldLayoutForSize(600, 240) === 'full');
check('shield uses compact layout for the reported short X region',
  shieldLayoutForSize(646, 100) === 'compact');
check('shield collapses to one row in a shallow region',
  shieldLayoutForSize(500, 60) === 'micro');
check('shield keeps an escape action in extremely small regions',
  shieldLayoutForSize(100, 35) === 'tiny');
check('shield observes live host resizing',
  shieldSrc.includes('new ResizeObserver(scheduleLayout)') &&
  shieldSrc.includes("shield.dataset.layout = layoutMode"));

// ---------------------------------------------------------------- sha256 parity
// lockscreen.js falls back to a pure-JS SHA-256 on non-secure origins; it must
// agree with the platform implementation or every Child Lock PIN breaks.
const lockSrc = readFileSync(new URL('../src/content/lockscreen.js', import.meta.url), 'utf8');
const b = lockSrc.indexOf('export function sha256hexSync');
const e = lockSrc.indexOf('\n}\n', b) + 3;
const kStart = lockSrc.indexOf('const K = [');
const kEnd = lockSrc.indexOf('];', kStart) + 2;
const rotrSrc = lockSrc.match(/^const rotr = .*$/m)?.[0] ?? '';
const { sha256hexSync } = await import(
  'data:text/javascript;base64,' + Buffer.from(
    `${rotrSrc}\n${lockSrc.slice(kStart, kEnd)}\n${lockSrc.slice(b, e)}`
  ).toString('base64')
);
for (const probe of ['', 'a', '1234', '0000', 'the quick brown fox', 'x'.repeat(200), 'éàü 🔒']) {
  const mine = sha256hexSync(probe);
  const ref = createHash('sha256').update(probe, 'utf8').digest('hex');
  check(`sha256 parity (${JSON.stringify(probe.slice(0, 12))})`, mine === ref, mine === ref ? '' : `${mine} != ${ref}`);
}

// ---------------------------------------------------------------- TDZ guard
// A `const` read by code that runs at module-evaluation time throws
// "Cannot access X before initialization". This bit the offscreen warm-up
// (startLoading() was called above `const STAGE_TIMEOUT_MS`), so the models
// never loaded and the in-page banner covered every page forever.
//
// Static check: for each top-level call, walk the callee's body transitively
// (through functions declared in this module) and report any module-level
// `const` it can read that is declared LATER in the file. Function
// declarations are hoisted and are not flagged; only `const`/`let` are, which
// is where the temporal dead zone actually bites.
for (const f of ['src/offscreen/offscreen.js', 'src/content/content.js', 'src/background/background.js']) {
  const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const lines = text.split('\n');

  const declAt = new Map(); // name -> 0-based line
  lines.forEach((ln, i) => {
    const m = ln.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !declAt.has(m[1])) declAt.set(m[1], i);
  });

  // body of `function name(...) { ... }` starting at `start`, brace-matched
  function bodyOf(name, from = 0) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`);
    const m = re.exec(text.slice(from));
    if (!m) return null;
    const open = from + text.indexOf('{', from + m.index + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
    }
    return null;
  }

  // which module-level consts does this call's callee transitively read?
  function readsOf(fnName) {
    const found = new Set();
    const seen = new Set();
    const walk = name => {
      if (seen.has(name)) return;
      seen.add(name);
      const body = bodyOf(name);
      if (!body) return;
      for (const [sym] of declAt) {
        if (new RegExp(`\\b${sym.replace(/\$/g, '\\$')}\\b`).test(body)) found.add(sym);
      }
      // follow local function calls declared in this module
      for (const m of body.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) walk(m[1]);
    };
    walk(fnName);
    return found;
  }

  let tdzFails = 0;
  lines.forEach((ln, i) => {
    const m = ln.match(/^([a-z_$][\w$]*)\s*\([^)]*\)\s*;?\s*$/);
    if (!m) return;                       // not a top-level call statement
    const callee = m[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(callee)) return;
    if (!bodyOf(callee)) return;          // imported/builtin: no module-local TDZ
    for (const sym of readsOf(callee)) {
      const decl = declAt.get(sym);
      if (decl != null && decl > i) {
        console.log(`FAIL  ${f}: top-level ${callee}() at line ${i + 1} reads \`${sym}\` declared at line ${decl + 1} (TDZ)`);
        tdzFails++;
      }
    }
  });
  check(`no TDZ-prone top-level calls (${f})`, tdzFails === 0, tdzFails ? `${tdzFails} issue(s)` : '');
}

// ------------------------------------------------------------- NSFW thresholds
// Pure policy test for the image tier. These are the numbers that decide
// whether an image gets blurred, and the false-positive history behind them:
// `sexy` runs hot on ordinary photos (0.4-0.6), so it needs a high bar, and
// `drawings` must never be flagged or every anime post gets blurred.
const imgSrc = readFileSync(new URL('../src/offscreen/imageClassifier.js', import.meta.url), 'utf8');
// Import the real PROFILES object rather than scraping it out of the source.
const { PROFILES } = await import(
  'data:text/javascript;base64,' + Buffer.from(
    readFileSync(new URL('../src/shared/profiles.js', import.meta.url), 'utf8')
  ).toString('base64')
);
const dStart = imgSrc.indexOf('export function decideNsfw');
const dEnd = imgSrc.indexOf('\n}', dStart) + 2;
// Inject the REAL thresholds: a policy test that hardcodes its own numbers
// would pass even if the shipped config drifted.
const { decideNsfw } = await import(
  'data:text/javascript;base64,' + Buffer.from(
    `const PROFILES = ${JSON.stringify(PROFILES)};\n${imgSrc.slice(dStart, dEnd)}`
  ).toString('base64')
);

// Regression for the real nsfwjs v4 output shape. Its labels are Title Case
// and it emits singular `Drawing`; the shipped policy keys are lowercase and
// plural `drawings`. A verbatim Object.fromEntries made every unsafe score 0.
const nStart = imgSrc.indexOf('export function normalizeNsfwPredictions');
const nEnd = imgSrc.indexOf('\n}', nStart) + 2;
const { normalizeNsfwPredictions } = await import(
  'data:text/javascript;base64,' + Buffer.from(imgSrc.slice(nStart, nEnd)).toString('base64')
);
const realNsfwShape = normalizeNsfwPredictions([
  { className: 'Drawing', probability: 0.01 },
  { className: 'Hentai', probability: 0.03 },
  { className: 'Neutral', probability: 0.04 },
  { className: 'Porn', probability: 0.90 },
  { className: 'Sexy', probability: 0.02 }
]);
check('nsfw: real Title Case labels are canonicalised',
  realNsfwShape.porn === 0.90 && realNsfwShape.drawings === 0.01);
check('nsfw: real model output reaches blocking policy',
  decideNsfw(realNsfwShape).action === 'block');

const NSFW_CASES = [
  ['flat landscape', { drawings: 0.02, hentai: 0.01, neutral: 0.95, porn: 0.01, sexy: 0.01 }, 'clean'],
  ['ordinary portrait, sexy runs hot', { drawings: 0.01, hentai: 0.01, neutral: 0.55, porn: 0.02, sexy: 0.42 }, 'clean'],
  ['anime artwork must never flag', { drawings: 0.88, hentai: 0.04, neutral: 0.06, porn: 0.01, sexy: 0.01 }, 'clean'],
  ['borderline sexy (needs the 0.85 bar)', { drawings: 0.01, hentai: 0.02, neutral: 0.10, porn: 0.04, sexy: 0.83 }, 'clean'],
  ['porn in the flag band', { drawings: 0.01, hentai: 0.02, neutral: 0.30, porn: 0.55, sexy: 0.12 }, 'flag'],
  ['hentai in the flag band', { drawings: 0.10, hentai: 0.52, neutral: 0.30, porn: 0.05, sexy: 0.03 }, 'flag'],
  ['explicit sexy above the bar', { drawings: 0.01, hentai: 0.02, neutral: 0.08, porn: 0.04, sexy: 0.90 }, 'flag'],
  ['clear porn blocks', { drawings: 0.01, hentai: 0.02, neutral: 0.05, porn: 0.88, sexy: 0.04 }, 'block'],
  ['clear hentai blocks', { drawings: 0.05, hentai: 0.91, neutral: 0.02, porn: 0.01, sexy: 0.01 }, 'block'],
  ['missing classes do not crash', { neutral: 1.0 }, 'clean'],
  ['all-zero does not crash', { drawings: 0, hentai: 0, neutral: 0, porn: 0, sexy: 0 }, 'clean']
];
for (const [name, probs, want] of NSFW_CASES) {
  const got = decideNsfw(probs).action;
  check(`nsfw: ${name}`, got === want, got === want ? '' : `got ${got}, want ${want}`);
}
// Monotonicity: raising porn probability must never lower the action.
const order = { clean: 0, flag: 1, block: 2 };
let monotonic = true;
for (let p = 0; p <= 1.0001; p += 0.05) {
  const a = order[decideNsfw({ neutral: 1 - p, porn: p, hentai: 0, sexy: 0, drawings: 0 }).action];
  const b = order[decideNsfw({ neutral: 1 - p, porn: Math.max(0, p - 0.05), hentai: 0, sexy: 0, drawings: 0 }).action];
  if (a < b) monotonic = false;
}
check('nsfw: action is monotonic in porn probability', monotonic);

// ------------------------------------------------------ violence/gore policy
const violenceSrc = readFileSync(new URL('../src/offscreen/violenceClassifier.js', import.meta.url), 'utf8');
const vStart = violenceSrc.indexOf('export function decideViolence');
const vEnd = violenceSrc.indexOf('\n}', vStart) + 2;
const { decideViolence } = await import(
  'data:text/javascript;base64,' + Buffer.from(
    `const PROFILES = ${JSON.stringify(PROFILES)};\n${violenceSrc.slice(vStart, vEnd)}`
  ).toString('base64')
);
const VIOLENCE_CASES = [
  ['ordinary image', { violence: 0.05, sensitive: 0.04, weapon: 0.03 }, 'clean'],
  ['medical-only sensitivity is not gore', { violence: 0.08, sensitive: 0.96, weapon: 0.01 }, 'clean'],
  ['credible violence is flagged', { violence: 0.74, sensitive: 0.10, weapon: 0.02 }, 'flag'],
  ['high-confidence violence blocks', { violence: 0.91, sensitive: 0.20, weapon: 0.03 }, 'block'],
  ['joint blood signals flag gore', { violence: 0.52, sensitive: 0.52, weapon: 0.01 }, 'flag'],
  ['strong joint blood signals block gore', { violence: 0.74, sensitive: 0.72, weapon: 0.01 }, 'block'],
  ['high-confidence weapon is flagged', { violence: 0.12, sensitive: 0.05, weapon: 0.93 }, 'flag'],
  ['missing scores are safe and finite', {}, 'clean']
];
for (const [name, scores, want] of VIOLENCE_CASES) {
  const got = decideViolence(scores).action;
  check(`violence: ${name}`, got === want, got === want ? '' : `got ${got}, want ${want}`);
}
const imageSafetyModel = readFileSync(new URL('../public/models/image-safety/model-int8.onnx', import.meta.url));
const imageSafetyHash = createHash('sha256').update(imageSafetyModel).digest('hex');
check('violence: browser-compatible model artifact is pinned',
  imageSafetyModel.length === 23746189 &&
  imageSafetyHash === 'd2a13d48096eba2409587b8dad4f145a7314a7e3f75b8e08e35aedde08e3d6d8',
  `${imageSafetyModel.length} bytes ${imageSafetyHash.slice(0, 12)}`);
const storeSrc = readFileSync(new URL('../src/offscreen/store.js', import.meta.url), 'utf8');
check('image cache: pre-fix clean verdicts are invalidated',
  /const IMAGE_POLICY_VERSION = 'nsfw-labels-v2\+violence-v1';/.test(storeSrc) &&
  /req\.result\?\.policyVersion === IMAGE_POLICY_VERSION/.test(storeSrc) &&
  /policyVersion: IMAGE_POLICY_VERSION/.test(storeSrc));

// ---------------------------------------------------------- OCR plausibility
// The observed OCR failure was a photo of a sign reading "GO FUCK YOURSELF":
// large white glyphs on black, in a busy photographic background. Tesseract
// returns background noise with HIGH confidence, so scoring by length or
// confidence alone selects the noise. These cases pin the shape-based scorer.
const ocrSrc = readFileSync(new URL('../src/offscreen/ocr.js', import.meta.url), 'utf8');
const pStart = ocrSrc.indexOf('export function plausibility');
const pEnd = ocrSrc.indexOf('\n}', pStart) + 2;
const MIN_TEXT_CHARS = Number(ocrSrc.match(/^const MIN_TEXT_CHARS = (\d+);/m)?.[1] ?? 4);
const { plausibility } = await import(
  'data:text/javascript;base64,' + Buffer.from(
    `const MIN_TEXT_CHARS = ${MIN_TEXT_CHARS};\n${ocrSrc.slice(pStart, pEnd)}`
  ).toString('base64')
);

const OCR_CASES = [
  // must be accepted
  ['GO FUCK YOURSELF', true],            // the exact meme that failed
  ['YOU ARE VERMIN AND EVERYONE WOULD BE BETTER OFF WITHOUT YOU', true],
  ['look out for signs', true],
  ['Muslims are vermin and should be exterminated', true],
  ['I LUV U', true],                      // short words are still language
  // must be rejected as background noise (shapes Tesseract emits from
  // foliage, railings and road texture — high confidence, no language)
  ['', false],
  ['|||', false],
  ['MKLT', false],                       // fence slats: no vowels
  ['....,,,;;;;', false],                // punctuation only
  ['a', false],                          // too short
  ['no', false],                         // below the minimum useful length
  ['1234 5678 9012', false],             // digits only, no letters
  ['MKMKMK MKMKMK MKMKMK', false],        // repeated glyph run
  ['ee nn rt', false],                   // 2-char fragments
  ['TEE nee ee ee TEE nn', false],        // leaf/branch texture
  ['WW NN ee lt nee', false]             // road markings
];
for (const [text, wantAccept] of OCR_CASES) {
  const got = plausibility(text);
  const accepted = got > 0;
  check(`ocr plausibility ${accepted === wantAccept ? 'accepts' : 'rejects'}: ${JSON.stringify(text.slice(0, 34))}`,
    accepted === wantAccept, got.toFixed(2));
}
check('ocr: real sentence outscores a fragment', plausibility('look out for signs') > plausibility('ee nn rt'));
check('ocr: multi-word caption outscores single word', plausibility('GO FUCK YOURSELF') > plausibility('FUCK'));

// ------------------------------------------------------------------- lexicon
// The tier that actually catches meme captions. The toxicity model is trained
// on identity-directed hate, so a profane imperative scores below the flag
// threshold; this list is what makes those images blur.
const lexSrc = readFileSync(new URL('../src/shared/lexicon.js', import.meta.url), 'utf8');
const { lexiconCheck, normalizeText } = await import(
  'data:text/javascript;base64,' + Buffer.from(lexSrc).toString('base64')
);

const LEX_BLOCK = [
  'GO FUCK YOURSELF',                                   // the reported meme
  'go fuck yourself',
  'you are a worthless piece of garbage',
  'kill yourself',
  'you are vermin',
  'nobody would even miss you',
  'this fucking app crashes',
  'FUCK'
];
const LEX_FLAG = [
  'damn that is annoying',
  'shut up already',
  'that is a scumbag move',
  'absolutely disgusting behaviour'
];
// These MUST NOT match: the classic profanity-scanner false positives, where a
// substring check would fire inside an unrelated word.
const LEX_CLEAN = [
  'The class reassembles at noon in the annexe',
  'I need to assess the situation carefully',
  'Scunthorpe United won the cup',
  'We shipped a graceful degradation path',
  'The weather is lovely today, perfect for a walk',
  'This movie is stupid but the songs were okay',
  'Espresso,issimo,asse,passage,compass,grass,hello'
];

for (const t of LEX_BLOCK) {
  const r = lexiconCheck(t);
  check(`lexicon blocks: ${JSON.stringify(t.slice(0, 40))}`, r?.action === 'block', `got ${r?.action ?? 'null'}`);
}
for (const t of LEX_FLAG) {
  const r = lexiconCheck(t);
  check(`lexicon flags: ${JSON.stringify(t.slice(0, 40))}`, r?.action === 'flag', `got ${r?.action ?? 'null'}`);
}
for (const t of LEX_CLEAN) {
  const r = lexiconCheck(t);
  check(`lexicon ignores: ${JSON.stringify(t.slice(0, 40))}`, r === null, r ? `false positive: ${JSON.stringify(r.hits)}` : '');
}
// Substring safety, asserted explicitly on the classic traps.
check('lexicon: "class" does not match "ass"', lexiconCheck('class') === null);
check('lexicon: "assess" does not match', lexiconCheck('assess') === null);
check('lexicon: "Scunthorpe" does not match', lexiconCheck('Scunthorpe') === null);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
