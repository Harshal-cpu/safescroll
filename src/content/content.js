// SafeScroll content script: viewport-only processing via
// MutationObserver + IntersectionObserver + debounce, with registry cleanup on
// element removal / viewport leave (virtualized-feed safe).
//
// WORKS ON ALL WEBSITES: the adapter layer (adapters.js + detect.js + extract.js)
// decides what a "unit" is. This file is site-agnostic — it only handles
// scheduling, lifecycle and rendering.
import { pickAdapter, materialise, mediaElementFor } from './adapters.js';
import {
  register, setVerdict, replaceShields, prune, size, cacheSize, clearAll,
  get, rebind, cachedVerdict, keyFor, setIdentity, getIdentity, removeEntry
} from './registry.js';
import { createShield, createBlurShield, showLoadingBanner, hideLoadingBanner } from './shield.js';
import {
  classify, waitForModels, sendRuntimeMessage, onExtensionContextInvalidated
} from './bridge.js';
import { splitUnit } from './extract.js';
import { lockIfConfigured, isScrollLocked, unlock, getSettings, sha256hex } from './lockscreen.js';
import { isHostPaused, toggleHostPause } from './sitecontrol.js';
import { MSG } from '../shared/messages.js';
import { lexiconCheck } from '../shared/lexicon.js';
import { PROFILES } from '../shared/profiles.js';
import { mediaFingerprint } from '../shared/mediaFingerprint.js';
import { createAnimatedMediaScanner } from './animatedMedia.js';

const DEBOUNCE_MS = 60;
const MAX_BATCH = 4;          // units admitted per drain tick
// The text model runs single-threaded WASM. Six simultaneous calls do not make
// six verdicts finish sooner; they contend for one CPU and make the content at
// the centre of the viewport wait much longer. Two keeps useful overlap without
// turning one ~300ms inference into multi-second contention.
const MAX_INFLIGHT = 2;
const MAX_QUEUE = 200;
const IDLE_RESCAN_MS = 8000;  // cheap safety net for missed mutations
const MIN_UNIT_CHARS = 24;    // below this an element is chrome, not content
const SPLIT_AT = 700;          // units longer than this are split (latency)
const PRELOAD_MARGIN = 800;    // how far off-screen we pre-observe elements

const adapter = pickAdapter();
const siteId = adapter.siteId;
const inFlight = new Set();
const queue = [];
const unitMemo = new WeakMap(); // Element -> materialised unit (for granular targets)

let enabled = false; // stay idle until the saved master-switch state arrives
let scope = 'all'; // 'all' = every website (default) | 'core' = IG/X/Reddit/YT
let paused = false;
let pausedHosts = [];
let settingsRevision = 0;
let domReady = false;
let scanning = false;
let destroyed = false;
let scheduled = false;
let debounceTimer = null;
let idleTimer = null;
const pendingRoots = new Set();
let moderationGeneration = 0;
const moderationSettings = {
  imageEnabled: PROFILES.image.enabled,
  ocrEnabled: PROFILES.ocr.enabled,
  lexiconEnabled: PROFILES.lexicon.enabled
};
const animatedScanner = createAnimatedMediaScanner({
  send: sendRuntimeMessage, createShield: createBlurShield, overrideGuard,
  isEnabled: isActive, policy: moderationPolicy, siteId
});
function moderationPolicy() {
  return `${Number(moderationSettings.imageEnabled)}:${Number(moderationSettings.ocrEnabled)}:${Number(moderationSettings.lexiconEnabled)}`;
}
function applyModerationSettings(next) {
  const before = moderationPolicy();
  Object.assign(moderationSettings, next);
  if (moderationPolicy() === before) return;
  moderationGeneration++;
  animatedScanner.reset();
  clearAll();
  queue.length = 0;
  mediaRequested.clear();
  if (isActive()) {
    pendingRoots.add(document.body || document.documentElement);
    scheduleScan(0);
  }
}

const CORE_HOSTS = /instagram\.|twitter\.|reddit\.|youtube\.|googlevideo\.|(^|\.)x\.com$/;
function isCoreSite() {
  return CORE_HOSTS.test(location.hostname) || ['x.com', 'reddit.com', 'youtube.com', 'instagram.com'].includes(location.hostname);
}

function isActive() {
  return !destroyed && enabled && !paused && !(scope === 'core' && !isCoreSite());
}

// ------------------------------------------------------------------- settings
function applySettings({ enabled: e, scope: s, pausedHosts: hosts }) {
  enabled = !!e;
  scope = s;
  pausedHosts = Array.isArray(hosts) ? hosts : [];
  paused = isHostPaused(pausedHosts, location.hostname);
  if (!isActive()) {
    suspendScanning();
    return;
  }
  if (!scanning) { resumeScanning(); return; }
  prune();
  pendingRoots.add(document.body || document.documentElement);
  scheduleScan(0);
}

chrome.storage.sync.get({ enabled: true, scope: 'all', pausedHosts: [] })
  .then(settings => { if (!settingsRevision) applySettings(settings); })
  .catch(e => console.error('[SafeScroll] settings read failed:', e));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.imageEnabled || changes.ocrEnabled || changes.lexiconEnabled) {
    applyModerationSettings({
      imageEnabled: changes.imageEnabled?.newValue ?? moderationSettings.imageEnabled,
      ocrEnabled: changes.ocrEnabled?.newValue ?? moderationSettings.ocrEnabled,
      lexiconEnabled: changes.lexiconEnabled?.newValue ?? moderationSettings.lexiconEnabled
    });
  }
  if (!changes.enabled && !changes.scope && !changes.pausedHosts) return;
  const revision = ++settingsRevision;
  applySettings({
    enabled: changes.enabled ? changes.enabled.newValue : enabled,
    scope: changes.scope ? changes.scope.newValue : scope,
    pausedHosts: changes.pausedHosts ? changes.pausedHosts.newValue : pausedHosts
  });
  // A storage event can beat the initial read. Reconcile untouched settings
  // without letting an older read turn protection back on.
  chrome.storage.sync.get({ enabled: true, scope: 'all', pausedHosts: [] })
    .then(settings => { if (revision === settingsRevision) applySettings(settings); })
    .catch(() => {});
});
chrome.storage.sync.get(moderationSettings).then(applyModerationSettings).catch(() => {});

function hideAllShields() {
  document.querySelectorAll('.safescroll-shield').forEach(s => { s.style.display = 'none'; });
}

// Parent-PIN guard for shield overrides (only enforced in Child Mode).
async function overrideGuard() {
  const { childMode } = await getSettings();
  if (!childMode?.enabled || !childMode?.pinHash) return true; // no child mode → free override
  const pin = prompt('Parent PIN required (Child Mode is on):');
  if (pin === null) return false;
  return (await sha256hex(pin)) === childMode.pinHash;
}

// ------------------------------------------------------------------- shields
// ---------------------------------------------------------------- stale-node gate
// X destroys and recreates post elements while ML/OCR is in flight, so a node
// captured before an `await` is routinely detached afterwards. Every DOM write
// that happens after async work goes through resolveLive(): use the node we
// still hold, else re-find the post by its STABLE id, else treat the stale
// node as a normal condition and skip. Never throws, never suppresses real
// errors — it just refuses to touch a node the page already threw away.
const domLogAt = new Map(); // tag -> last logged ms (rate limit; bounded)
function domLog(tag, detail) {
  // High-churn feeds trigger expected dedupe/stale-node events constantly.
  // Keep production consoles quiet; developers can opt in from the content
  // script's DevTools execution context when diagnosing DOM lifecycle issues.
  if (globalThis.__SAFESCROLL_DEBUG__ !== true) return;
  const now = Date.now();
  if (now - (domLogAt.get(tag) ?? 0) < 3000) return;
  domLogAt.set(tag, now);
  if (domLogAt.size > 200) domLogAt.delete(domLogAt.keys().next().value);
  console.info('[SS][DOM]', detail);
}

/** The CURRENT element for `key`, or null when the post is really gone. */
function resolveLive(key, el) {
  // A virtualized feed can keep the same DOM element connected while replacing
  // all of its content. Never let an old async result paint onto a node that has
  // since been claimed by a different content key.
  if (el && el.isConnected) {
    const owner = keyFor(el) ?? el.dataset?.safescrollKey;
    if (!owner || owner === key) return el;
  }

  const postId = getIdentity(key);
  if (postId) domLog(`re:${postId}`, `post became stale; re-looking up ${postId}`);

  let found = null;
  // 1. stable post id -> current container (survives X re-rendering the node).
  //    Only trusted when the node we lost was itself the identity-bearing
  //    container, so a split sub-unit (no status link of its own) can never
  //    re-bind itself to the whole article.
  if (postId) {
    let lostId = null;
    try { lostId = adapter.identity?.({ el }); } catch { lostId = null; }
    if (lostId === postId) {
      let candidates = [];
      try {
        candidates = adapter.locateAll?.(postId) ?? (adapter.locate?.(postId) || []);
      } catch { candidates = []; }
      for (const candidate of candidates) {
        if (!candidate?.isConnected) continue;
        const owner = candidate.dataset.safescrollKey ?? keyFor(candidate);
        // Never steal a container that already belongs to a different post
        // (a quote-post above shares the status id and must not be claimed).
        if (!owner || owner === key) { found = candidate; break; }
      }
    }
  }
  // 2. any element still carrying this key
  if (!found) {
    try {
      const candidate = document.querySelector(`[data-safescroll-key="${CSS.escape(key)}"]`);
      if (candidate?.isConnected) found = candidate;
    } catch { /* key not expressible as a selector */ }
  }

  if (!found) {
    if (postId) domLog(`miss:${postId}`, `current post not found for ${postId}`);
    return null;
  }

  if (keyFor(found) !== key) rebind(key, found);
  // Persist the binding ON the new node too, so the next lookup can find it by
  // selector as well as by WeakMap (the WeakMap alone dies with the node).
  if (found.dataset.safescrollKey !== key) found.dataset.safescrollKey = key;
  // We are about to paint onto a node we have never materialised; build its
  // unit now so the granular text/media targets resolve instead of falling
  // back to a post-level shield.
  if (!unitMemo.has(found)) {
    try {
      const unit = materialise(found, adapter);
      if (unit) unitMemo.set(found, unit);
    } catch { /* synthetic unit below is enough to shield */ }
  }
  return found;
}

/**
 * Install the granular (text / media) shields for a non-clean verdict.
 * Text and media are blurred SEPARATELY so a toxic caption in an otherwise
 * fine post does not hide the photo, and vice versa.
 */
function paintShields(key, el, verdict) {
  if (!isActive()) return false;
  const node = resolveLive(key, el);
  if (!node) {
    domLog(`skip:${key}`, 'node became stale; skipping update');
    return false;
  }
  const action = verdict?.action;
  if (!action || action === 'clean' || action === 'loading') {
    get(key)?.shields?.post?.update?.(verdict);
    return false;
  }
  const reasons = verdict.reasons ?? [];
  const textReasons = reasons.filter(r => ['text', 'lexicon'].includes(r.source));
  const mediaReasons = reasons.filter(r => ['image', 'ocr-text', 'lexicon-ocr'].includes(r.source));
  const actionFor = rs => {
    if (rs.some(r => r.action === 'block')) return 'block';
    if (rs.some(r => r.action === 'flag')) return 'flag';
    return 'clean';
  };
  const textAction = actionFor(textReasons);
  const shields = get(key)?.shields;
  if (!shields) return false;
  const unit = unitMemo.get(node) || { el: node, parts: [], text: '', images: [] };
  const wanted = new Set();
  if (textAction !== 'clean') {
    const targets = adapter.textTargets?.(unit) ?? [adapter.textEl?.(unit)];
    for (const [index, target] of targets.entries()) {
      const name = index ? `text:${index}` : 'text';
      const textAllowed = shields[name]?.dataset.userOverrode === '1';
      if (shields[name] && (!shields[name].isConnected || shields[name].safescrollTarget !== target)) {
        shields[name]?.destroy?.();
        delete shields[name];
      }
      const ts = shields[name] ?? createBlurShield(target, { key, siteId, overrideGuard, target: 'text' });
      if (ts) {
        ts.safescrollTarget = target;
        ts.update({ ...verdict, action: textAction });
        if (textAllowed) ts.hide(true);
        shields[name] = ts;
        wanted.add(name);
      }
    }
  }
  const mediaByUrl = new Map();
  let staleMediaReason = false;
  for (const reason of mediaReasons) {
    if (reason.action !== 'block' && reason.action !== 'flag') continue;
    // OCR currently runs on the first image; image-model reasons carry the URL
    // that produced the finding. A post with several photos can need several
    // separate media shields.
    const url = reason.detail?.imageUrl ?? (reason.source !== 'image' ? unit.images?.[0]?.url : null);
    // A virtualized post can replace its images without changing its text key.
    // Never paint an old photo's finding onto the new first photo.
    if (url && !unit.images?.some(image => image.url === url)) {
      staleMediaReason = true;
      continue;
    }
    if (!url && reason.source === 'image') continue;
    const id = url || 'default';
    const previous = mediaByUrl.get(id);
    mediaByUrl.set(id, {
      url,
      action: previous?.action === 'block' || reason.action === 'block' ? 'block' : 'flag'
    });
  }
  for (const [id, item] of mediaByUrl) {
    const name = `media:${id}`;
    const image = unit.images?.find(i => i.url === item.url);
    const target = adapter.mediaTarget?.(image, unit) ?? image?.el?.parentElement ?? mediaElementFor(adapter, unit);
    const mediaAllowed = shields[name]?.dataset.userOverrode === '1';
    if (shields[name] && (!shields[name].isConnected || shields[name].safescrollTarget !== target)) {
      shields[name]?.destroy?.();
      delete shields[name];
    }
    const ms = shields[name] ?? createBlurShield(target, { key, siteId, overrideGuard, target: 'media' });
    if (ms) {
      ms.safescrollTarget = target;
      ms.update({ ...verdict, action: item.action });
      if (mediaAllowed) ms.hide(true);
      shields[name] = ms;
      wanted.add(name);
    }
  }
  // An OCR-only verdict still needs a visible shield when YouTube replaces a
  // thumbnail node before we can resolve its exact target. Do not paint an old
  // image finding onto a different image after virtualization, though.
  if (!wanted.size && (textAction !== 'clean' || !staleMediaReason)) {
    if (shields.post && !shields.post.isConnected) {
      shields.post.destroy?.();
      delete shields.post;
    }
    const ps = shields.post ?? createShield(node, { key, siteId, overrideGuard });
    if (ps) { ps.update(verdict); shields.post = ps; wanted.add('post'); }
  }
  for (const [name, shield] of Object.entries(shields)) {
    if (wanted.has(name)) continue;
    shield?.destroy?.();
    delete shields[name];
  }
  return wanted.size > 0;
}

// ----------------------------------------------------------------- unit intake
// DETECTION is cheap (selectors + textContent); MATERIALISATION and
// CLASSIFICATION are expensive, and happen only for elements the user can
// actually see. Nothing below reads a post's text until it is on screen.
// WeakSet (not a Set, not a DOM counter): DOM nodes are the tracked identity,
// so entries vanish with the node — no leak when X discards hundreds of posts,
// and a REPLACED node is a different object, which is exactly what we want
// (the new node must be observed again rather than inherited from the old one).
let observedNodes = new WeakSet();
function observeUnit(el) {
  if (observedNodes.has(el)) return;
  observedNodes.add(el);
  el.dataset.safescrollSeen = '1';
  io.observe(el);
}

/** Materialise a visible element and register it (keyed, shield-ready). */
function registerUnit(unit) {
  const el = unit.el;
  const previousUnit = unitMemo.get(el);
  unitMemo.set(el, unit);

  // Compute the current content identity even when this DOM node was seen
  // before. X recycles timeline containers; the element can stay connected
  // while its status id, text and media all change underneath us.
  let key;
  try {
    key = adapter.key(unit);
  } catch {
    return null;
  }
  if (!key) return null;

  const boundKey = keyFor(el);
  const existingKey = boundKey ?? el.dataset.safescrollKey;
  if (existingKey && existingKey !== key) {
    if (boundKey && boundKey !== 'skip') removeEntry(boundKey);
    delete el.dataset.safescrollKey;
  }
  if (existingKey === key && get(existingKey)) {
    // Already known. A returning element is re-bound and re-shielded from the
    // verdict cache immediately — no clean flash, no re-inference.
    const cached = cachedVerdict(existingKey);
    if (cached) {
      rebind(existingKey, el);
      paintShields(existingKey, el, cached);
    }
    // X frequently inserts the real image URL after the text has already been
    // classified. A changed media set needs its own pass even though the post's
    // stable text/status key correctly stayed the same.
    if (previousUnit && mediaFingerprint(previousUnit.images) !== mediaFingerprint(unit.images) && unit.images?.length) {
      refreshExistingMedia(existingKey, el, unit);
    }
    return existingKey;
  }

  el.dataset.safescrollKey = key;
  const shields = {};
  const cached = cachedVerdict(key);
  // Hide new content before the asynchronous verdict lands. This prevents a
  // toxic flash and makes the pipeline state explicit, matching the same
  // shield the final verdict will update or replace with granular text/media
  // shields. Cached units skip this state and render their known verdict
  // synchronously.
  if (!cached) {
    // Text-only posts can contain an unclassified video. Cover the caption
    // while it is checked without making safe video pixels look moderated.
    const loading = unit.text && !unit.images.length
      ? (createBlurShield(adapter.textEl?.(unit), { key, siteId, overrideGuard, target: 'text' })
        ?? createShield(el, { key, siteId, overrideGuard }))
      : createShield(el, { key, siteId, overrideGuard });
    if (loading) {
      loading.update({ action: 'loading', reasons: [] });
      shields.post = loading;
    }
  }
  const hadCache = !!register(key, el, shields);
  // Stable post id (X status number) — stored on the REGISTRY ENTRY, not on
  // the node, because the node is the thing that gets replaced. It is what
  // lets an async result find the post again after a re-render.
  try { setIdentity(key, adapter.identity?.(unit)); } catch { /* adapter has none */ }
  if (!cached && unit.text && moderationSettings.lexiconEnabled) {
    // Stage 0 runs synchronously in the content script. Obvious abuse is
    // blurred in the same frame the unit enters the viewport instead of waiting
    // for the service worker, IndexedDB and the 266 MB model. This is only a
    // provisional paint: the normal offscreen classifier still runs and returns
    // the authoritative fused verdict.
    const lex = lexiconCheck(unit.text);
    if (lex) {
      paintShields(key, el, {
        action: lex.action,
        siteId,
        host: location.hostname,
        reasons: [{ source: 'lexicon', action: lex.action, detail: { hits: lex.hits, provisional: true } }],
        ts: Date.now()
      });
    }
  }
  if (hadCache) {
    paintShields(key, el, cached);
  } else if (cached) {
    paintShields(key, el, cached);
  }
  return key;
}

/** Split a too-large element into smaller units (latency + blur granularity). */
function buildUnits(el) {
  const unit = materialise(el, adapter);
  if (!unit.noSplit && unit.text.length > SPLIT_AT) {
    const split = splitUnit(el);
    if (split && split.length >= 2) {
      return split.filter(s => s.el?.isConnected);
    }
  }
  const minChars = Number.isFinite(unit.minChars) ? unit.minChars : MIN_UNIT_CHARS;
  if (unit.text.length < minChars && !unit.images.length) return [];
  return [unit];
}

// ------------------------------------------------------------ IntersectionObserver
// THIS IS THE REAL-TIME PATH. Elements are observed cheaply as they are
// discovered; the expensive work (text extraction, image capture, key hashing,
// ML inference) happens only when an element enters the viewport — so detection
// tracks scrolling exactly, one screenful at a time.
//
// On re-entry a cached verdict is re-applied SYNCHRONOUSLY, before any async
// work, so a blocked post is never visible for even one frame. The previous
// implementation destroyed the entry on leave but left data-safescroll-key on
// the element, so scan() skipped it forever and a blocked post scrolled out and
// back in was left completely unmoderated.
const io = new IntersectionObserver(entries => {
  if (!isActive()) return;
  for (const e of entries) {
    const el = e.target;
    if (!el.isConnected) {
      io.unobserve(el);
      observedNodes.delete(el);
      continue;
    }

    // Keep below-fold candidates observed. Unobserving them here while leaving
    // them in observedNodes meant only the first screenful could ever fire an
    // entry callback; clicking a later post merely caused a lucky mutation.
    if (!e.isIntersecting) continue;

    activateElement(el);
  }
}, { threshold: 0, rootMargin: `${PRELOAD_MARGIN}px 0px` });

/** Materialise and queue one element that is visible or about to be visible. */
function activateElement(el) {
  if (!isActive() || !el?.isConnected) return;
  // Always rebuild the lightweight unit here. Besides first entry, this detects
  // virtualized nodes whose text/media changed without the outer element being
  // removed from the document.
  let units;
  try { units = buildUnits(el); } catch { units = []; }
  for (const unit of units) {
    const k = registerUnit(unit);
    if (k && !cachedVerdict(k)) enqueue(k);
  }
  // A split produced no usable unit (e.g. a nav-ish element); don't spin on
  // it every intersection. A later meaningful mutation can replace this marker
  // through registerUnit's content-identity reconciliation.
  if (!units.length) el.dataset.safescrollKey = el.dataset.safescrollKey || 'skip';
}

function inPreloadBand(el) {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return !!(r.width || r.height) &&
    r.bottom > -PRELOAD_MARGIN && r.top < window.innerHeight + PRELOAD_MARGIN;
}

function releaseObservedSubtree(root) {
  if (!root || root.nodeType !== 1) return;
  const nodes = [];
  if (root.matches?.('[data-safescroll-seen]')) nodes.push(root);
  nodes.push(...(root.querySelectorAll?.('[data-safescroll-seen]') ?? []));
  for (const el of nodes) {
    io.unobserve(el);
    observedNodes.delete(el);
  }
}

function elementForMutationNode(node) {
  return node?.nodeType === 1 ? node : node?.parentElement ?? null;
}

function isShieldNode(node) {
  return !!elementForMutationNode(node)?.closest?.('[data-safescroll="shield"]');
}

// ------------------------------------------------------------- MutationObserver
// Added subtrees, changed text and lazy-loaded image/link attributes can all
// change the identity of a virtualized post. Refresh the containing unit too,
// because X often mutates a span inside an existing article instead of adding
// a brand-new article node.
const mo = new MutationObserver(mutations => {
  if (!isActive()) return;
  for (const m of mutations) {
    if (isShieldNode(m.target)) continue;
    let meaningful = m.type !== 'childList';

    if (m.type === 'childList') {
      for (const node of m.removedNodes) {
        if (!isShieldNode(node)) meaningful = true;
        releaseObservedSubtree(node);
      }
      for (const node of m.addedNodes) {
        if (isShieldNode(node)) continue;
        const el = elementForMutationNode(node);
        if (!el) continue;
        meaningful = true;
        pendingRoots.add(el);
      }
    }

    if (!meaningful) continue;
    const target = elementForMutationNode(m.target);
    if (target) pendingRoots.add(target);
    try {
      const containing = adapter.containingUnit?.(target);
      if (containing?.isConnected) pendingRoots.add(containing);
    } catch { /* incremental subtree scan remains available */ }
    }
  if (pendingRoots.size) scheduleScan(DEBOUNCE_MS);
});

function scheduleScan(delay) {
  if (!isActive()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scanPending, delay);
}

function scanPending() {
  if (!isActive()) { pendingRoots.clear(); return; }
  const roots = [...pendingRoots];
  pendingRoots.clear();
  for (const root of roots) {
    if (root.isConnected) processRoot(root);
  }
  prune();
  scheduleIdleRescan();
}

// A rate-limited full-document DETECTION pass catches anything the incremental
// observer could miss (client-side routing that swaps containers wholesale).
// It only observes candidates near the viewport — everything further down is
// picked up by the IntersectionObserver as the user scrolls to it, which is
// exactly the behaviour we want: work proportional to what is on screen.
function scheduleIdleRescan() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!isActive()) return;
    const body = document.body || document.documentElement;
    try {
      const els = adapter.units(body);
      for (const el of els) {
        if (!el?.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < -PRELOAD_MARGIN || r.top > window.innerHeight + PRELOAD_MARGIN) continue;
        observeUnit(el);
      }
    } catch { /* observer will retry */ }
    prune();
    scheduleIdleRescan();
  }, IDLE_RESCAN_MS);
}

function processRoot(root, { activateVisible = true } = {}) {
  if (!isActive()) return;
  animatedScanner.observeRoot(root);
  let els;
  try {
    els = adapter.units(root);
  } catch (e) {
    console.error('[SafeScroll] adapter.units failed:', e);
    return;
  }
  // Detection only — no text extraction, no keys, no shields. Everything here
  // is cheap enough to run over a large document.
  for (const el of els) {
    if (!el?.isConnected) continue;
    observeUnit(el);
    // IntersectionObserver delivery is asynchronous. Activate candidates that
    // are already onscreen (or just below it) now so no click/focus event is
    // required to start scanning.
    if (activateVisible && inPreloadBand(el)) activateElement(el);
  }
}

// ----------------------------------------------------------------- classification
// Queue is ordered by how central the element is on screen, so as the user
// scrolls the item they are actually looking at is classified first. Items far
// above/below the viewport are deprioritised and, past a hard limit, dropped
// rather than queued — a fast flick through a feed must not build a backlog of
// stale work for content the user has already scrolled past.
function centreScore(el) {
  if (!el?.isConnected) return Infinity;
  const r = el.getBoundingClientRect();
  const mid = r.top + r.height / 2;
  return Math.abs(mid - window.innerHeight / 2);
}

function enqueue(key) {
  if (!isActive()) return;
  // Same key = same post. Never let it into the pipeline twice: this is what
  // stops a MutationObserver re-fire from re-running ML + OCR on a post that
  // is already being analysed (or is already queued).
  if (inFlight.has(key) || queue.includes(key)) {
    const postId = getIdentity(key);
    domLog(`dedup:${key}`, `skipping already-processing post ${postId ?? key}`);
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    // Drop the least central queued item rather than refusing new work: a fast
    // flick through a feed must not build a backlog of stale work.
    let worst = -1, worstScore = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      const s = centreScore(get(queue[i])?.el);
      if (s > worstScore) { worstScore = s; worst = i; }
    }
    if (worst < 0 || !Number.isFinite(worstScore)) return;
    queue.splice(worst, 1);
  }
  queue.push(key);
  if (!scheduled) {
    scheduled = true;
    setTimeout(drain, 16); // next frame, not a fixed 50ms
  }
}

function drain() {
  scheduled = false;
  if (!isActive()) { queue.length = 0; return; }

  // Service the most central queued item first — that is what the user is
  // looking at right now.
  if (queue.length > 1) {
    queue.sort((a, b) => centreScore(get(a)?.el) - centreScore(get(b)?.el));
  }

  let processed = 0;
  while (queue.length && processed < MAX_BATCH && inFlight.size < MAX_INFLIGHT) {
    const key = queue.shift();
    const entry = get(key);
    if (!entry || entry.verdict) continue;
    // X may have replaced the node while this key waited in the queue.
    const node = resolveLive(key, entry.el);
    if (!node) {
      domLog(`skip:${key}`, 'node became stale; skipping update');
      continue;
    }
    inFlight.add(key);
    processed++;
    const generation = moderationGeneration;
    classifyUnit(key, node).finally(() => {
      inFlight.delete(key);
      if (generation !== moderationGeneration) {
        pendingRoots.add(document.body || document.documentElement);
        scheduleScan(0);
      }
    });
  }
  if (queue.length) setTimeout(drain, 30);
}

async function classifyUnit(key, el) {
  if (!isActive()) return;
  const generation = moderationGeneration;
  try {
    const unit = unitMemo.get(el) || { el, text: el.textContent || '', images: [] };
    const text = unit.text || '';
    let images = mediaPayload(unit.images);
    if (!text.trim() && !images.length) {
      setVerdict(key, { action: 'clean', reason: 'empty' });
      return;
    }

    // ---- TIER 1: text only, and this is the only thing on the critical path.
    // One 128-token window on the 278M model is ~157ms, so a caption is
    // classified and blurred in about that long regardless of how many images
    // the post has. Images are deliberately NOT included here: a network fetch
    // is 200ms-2s and OCR is 1-3s, and awaiting them used to hold a known-bad
    // caption on screen for seconds.
    const verdict = await classify({
      key, text, siteId, referer: location.href, host: location.hostname
    });
    // Reloading/updating an unpacked extension invalidates every content script
    // already injected into an open tab. The bridge shuts this instance down;
    // never turn that transport failure into a clean verdict or remove a blur.
    if (!isActive() || generation !== moderationGeneration ||
        (verdict?.settingsPolicy && verdict.settingsPolicy !== moderationPolicy()) ||
        verdict?.reason === 'context-invalidated') return;
    setVerdict(key, verdict);
    // The image may have lazy-loaded while text inference was running. Always
    // dispatch the newest materialised media set, not the snapshot captured
    // before the await.
    const latestNode = resolveLive(key, el);
    // The feed permanently removed this unit while text inference was running.
    // Its verdict is cached above for a possible return, but there is no live
    // media target to shield or classify now.
    if (!latestNode) return;
    const latestUnit = latestNode ? unitMemo.get(latestNode) : null;
    if (latestUnit) images = mediaPayload(latestUnit.images);
    let mediaLoading = null;
    if (verdict.action !== 'clean' && verdict.action !== 'loading') {
      const painted = paintShields(key, el, verdict);
      if (painted && verdict.action === 'block' && !document.getElementById('safescroll-lock')) {
        lockIfConfigured('Blocked content detected on this feed', isActive).catch(e =>
          console.error('[SafeScroll] scroll lock failed:', e));
      }
    } else if (verdict.action === 'clean' && images.length) {
      // Text is clean, but the final media/OCR verdict is still pending. Move
      // the scanning state from the whole post to just its media so readable
      // text is released without flashing an unchecked image to the user.
      const live = resolveLive(key, el);
      const liveUnit = live && (unitMemo.get(live) || unit);
      mediaLoading = createBlurShield(mediaElementFor(adapter, liveUnit), {
        key, siteId, overrideGuard, target: 'media'
      });
      if (mediaLoading) {
        mediaLoading.update({ action: 'loading', reasons: [] });
        replaceShields(key, { media: mediaLoading });
      }
    }

    // ---- TIER 2: media, off the critical path. Fires without awaiting, so the
    // next unit's text verdict starts immediately. A media finding is pushed
    // back as MSG.VERDICT_REFINED and upgrades this unit's shield in place.
    if (images.length) {
      classifyMedia(key, images)
        .then(response => {
          if (!mediaLoading) return;
          if (response?.deferred) return;
          const finish = () => {
            const entry = get(key);
            // A refined block/flag owns the shield now; only a still-clean unit
            // may remove the temporary media scanning state.
            if (entry?.verdict?.action === 'clean' && entry.shields?.media === mediaLoading) {
              replaceShields(key, {});
            }
          };
          // The offscreen worker broadcasts an upgrade immediately before its
          // response. Give that message a short delivery window before deciding
          // this was a clean media pass.
          if (response?.upgraded) setTimeout(finish, 1000);
          else finish();
        })
        .catch(e => {
          console.warn('[SafeScroll] media pass:', e);
          if (mediaLoading && get(key)?.shields?.media === mediaLoading) replaceShields(key, {});
        });
    }
  } catch (e) {
    console.error('[SafeScroll] classify crashed:', e);
    if (generation === moderationGeneration) setVerdict(key, { action: 'clean', reason: 'error' });
  }
}

const mediaSent = [];
// Earliest possible duplicate guard. The offscreen document dedups too, but by
// then the message has already crossed the extension bus; and a re-send was the
// thing producing the repeated `already-completed media` lines. One media pass
// per key per content-script lifetime — a page navigation creates a fresh
// context (and a fresh Set), so a genuinely new visit is never blocked.
const mediaRequested = new Map(); // key -> fingerprint of the requested image set
const MEDIA_REQUESTED_MAX = 2000;

function mediaPayload(images = []) {
  return images.slice(0, 3).map(i => ({ url: i.url, dataUrl: i.dataUrl ?? null }));
}

function refreshExistingMedia(key, el, unit) {
  if (!isActive()) return;
  const entry = get(key);
  // If text is still queued/in flight, classifyUnit will read the latest unit
  // after its await and send this media itself. Starting a competing pass here
  // could let the later text write overwrite an early image verdict.
  if (!entry?.verdict) return;
  const images = mediaPayload(unit.images);
  if (!images.length) return;

  let mediaLoading = null;
  if (entry.verdict.action === 'clean') {
    mediaLoading = createBlurShield(mediaElementFor(adapter, unit), {
      key, siteId, overrideGuard, target: 'media'
    });
    if (mediaLoading) {
      mediaLoading.update({ action: 'loading', reasons: [] });
      replaceShields(key, { media: mediaLoading });
    }
  }

  classifyMedia(key, images)
    .then(response => {
      if (!mediaLoading) return;
      if (response?.deferred) return;
      const finish = () => {
        const current = get(key);
        if (current?.verdict?.action === 'clean' && current.shields?.media === mediaLoading) {
          replaceShields(key, {});
        }
      };
      if (response?.upgraded) setTimeout(finish, 1000);
      else finish();
    })
    .catch(e => {
      console.warn('[SafeScroll] refreshed media pass:', e);
      if (mediaLoading && get(key)?.shields?.media === mediaLoading) replaceShields(key, {});
    });
}

async function classifyMedia(key, images) {
  if (!isActive()) return { skipped: 'disabled' };
  const fingerprint = mediaFingerprint(images);
  if (mediaRequested.get(key) === fingerprint) {
    domLog(`dedup:${key}`, 'skipping already-requested media pass');
    return { skipped: 'already-requested' };
  }
  mediaRequested.delete(key);
  mediaRequested.set(key, fingerprint);
  if (mediaRequested.size > MEDIA_REQUESTED_MAX) {
    let dropped = 0;
    for (const k of mediaRequested.keys()) {
      mediaRequested.delete(k);
      if (++dropped >= 500) break;
    }
  }
  const rec = { key, n: images.length, ts: Date.now() };
  mediaSent.push(rec);
  if (mediaSent.length > 40) mediaSent.splice(0, mediaSent.length - 40);
  try {
    rec.response = await sendRuntimeMessage({
      type: MSG.CLASSIFY_MEDIA, key, images,
      siteId, referer: location.href, host: location.hostname
    });
  } catch (e) {
    rec.error = String(e);
    // Transport failure is not a result — allow a later retry.
    if (mediaRequested.get(key) === fingerprint) mediaRequested.delete(key);
  }
  return rec.response;
}

// Safety valve: bound registry growth on high-churn feeds.
const pruneTimer = setInterval(() => { if (isActive()) prune(); }, 10000);

function stopContentScript({ invalidated = false } = {}) {
  if (destroyed) return;
  destroyed = true;
  suspendScanning();
  animatedScanner.stop();
  clearInterval(pruneTimer);
  if (invalidated) {
    // The new extension context is injected by Chrome on navigation/refresh.
    // Release any stale loading overlays and emit one actionable message rather
    // than one transport error for every queued Reddit/X/Instagram unit.
    hideAllShields();
    console.warn('[SafeScroll] Extension was reloaded. Refresh this tab to resume moderation.');
  }
}

onExtensionContextInvalidated(() => stopContentScript({ invalidated: true }));
window.addEventListener('pagehide', () => stopContentScript(), { once: true });

// ----------------------------------------------------------------- bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

function start() {
  if (destroyed) return;
  domReady = true;
  resumeScanning();
}

function suspendScanning() {
  if (scanning) {
    mo.disconnect();
    io.disconnect();
    observedNodes = new WeakSet();
    scanning = false;
  }
  moderationGeneration++;
  clearTimeout(debounceTimer);
  clearTimeout(idleTimer);
  pendingRoots.clear();
  queue.length = 0;
  mediaRequested.clear();
  animatedScanner.reset();
  clearAll();
  hideAllShields();
  hideLoadingBanner();
  if (isScrollLocked()) unlock();
}

function resumeScanning() {
  if (!domReady || !isActive() || scanning) return;
  const target = document.body || document.documentElement;
  try {
    mo.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'href', 'data-testid']
    });
  } catch (e) {
    console.error('[SafeScroll] observer failed:', e);
    return;
  }
  scanning = true;
  showLoadingBanner();
  waitForModels({ timeoutMs: 180000 }).then(hideLoadingBanner);
  processRoot(target);
  prune();
  scheduleIdleRescan();
}

// Diagnostic surface for automated verification (CDP tests). Read-only apart
// from the explicit scan()/clear() helpers.
const diagnostics = {
  get stats() {
    return {
      units: size(), cached: cacheSize(), queued: queue.length,
      inFlight: inFlight.size, siteId, enabled, paused, scope
    };
  },
  scan: () => { pendingRoots.add(document.body || document.documentElement); scanPending(); },
  clear: () => { clearAll(); hideAllShields(); },
  // The text actually sent to the classifier, per tracked element. This is the
  // value automated tests must assert on: element.textContent still contains
  // handles/timestamps/action labels, but those must never reach the model.
  texts: () => [...unitMemo.values()].map(u => ({
    tag: u.el?.tagName?.toLowerCase() ?? '?',
    site: siteId,
    text: u.text,
    parts: (u.parts || []).map(p => p.text),
    images: (u.images || []).map(i => ({ url: i.url, hasDataUrl: !!i.dataUrl }))
  })),
  shields: () => [...document.querySelectorAll('.safescroll-shield')].map(s => ({
    target: s.dataset.safescrollTarget,
    action: s.dataset.verdictAction ?? null,
    display: s.style.display
  })),
  // Did the media pass leave the page, and what did it answer?
  media: () => mediaSent.slice()
};
window.__safescroll = diagnostics;

// The popup's per-site pause control talks to the content script so there is a
// single implementation of host matching (content/sitecontrol.js).
// Also receives late verdict upgrades from the offscreen media pass: a caption
// can be blurred on the text verdict in ~160ms and then be upgraded to a
// media-level block seconds later without the user ever seeing it unblurred.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.ANIMATED_VERDICT) {
    animatedScanner.onVerdict(msg);
    return;
  }
  if (msg?.type === MSG.VERDICT_REFINED) {
    if (!isActive()) return;
    const { key, verdict } = msg;
    if (msg.retryDropped && key && msg.mediaFingerprint === mediaRequested.get(key)) {
      mediaRequested.delete(key);
      const pending = get(key)?.shields?.media;
      if (pending) { pending.destroy?.(); delete get(key).shields.media; }
      return;
    }
    if (key && verdict && verdict.settingsPolicy === moderationPolicy() &&
        (!msg.mediaFingerprint || msg.mediaFingerprint === mediaRequested.get(key))) {
      setVerdict(key, verdict);
      // paintShields re-resolves the CURRENT node by stable post id; the
      // binding recorded when the media pass started is usually stale by now.
      paintShields(key, get(key)?.el, verdict);
      if (msg.mediaCompleted) {
        const pending = get(key)?.shields?.media;
        if (pending) { pending.destroy?.(); delete get(key).shields.media; }
      }
    }
    return;
  }
  if (msg?.type !== 'safescroll:ping') return;
  (async () => {
    try {
      const toggled = msg.toggle ? await toggleHostPause(location.hostname) : null;
      if (toggled) {
        applySettings({ enabled, scope, pausedHosts: toggled.hosts });
      }
      sendResponse({
        state: {
          host: location.hostname,
          paused,
          stats: diagnostics.stats
        },
        toggled: !!toggled
      });
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true; // async
});
