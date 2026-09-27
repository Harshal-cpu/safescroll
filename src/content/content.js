// SafeScroll content script: viewport-only processing via
// MutationObserver + IntersectionObserver + 200ms debounce, with registry
// cleanup on element removal / viewport leave (virtualized-feed safe).
import { pickAdapter } from './adapters.js';
import { register, setVerdict, replaceShields, removeEntry, prune, get, size } from './registry.js';
import { createShield, createBlurShield, showLoadingBanner, hideLoadingBanner } from './shield.js';
import { classify, checkModelsReady } from './bridge.js';
import { lockIfConfigured, getSettings, sha256hex } from './lockscreen.js';

const DEBOUNCE_MS = 200;
const IO_THRESHOLD = 0.2;

const adapter = pickAdapter();
const visible = new Set(); // keys currently intersecting the viewport
const inFlight = new Set(); // keys being classified
let enabled = true;
let scope = 'all'; // 'all' = every website (default) | 'core' = only IG/X/YT

const CORE_HOSTS = /instagram\.|twitter\.|(^|\.)x\.com$|youtube\./;
function isCoreSite() {
  return CORE_HOSTS.test(location.hostname) || ['x.com', 'youtube.com', 'instagram.com'].includes(location.hostname);
}

// Master toggle + moderation scope (dashboard setting).
chrome.storage.sync.get({ enabled: true, scope: 'all' }).then(({ enabled: e, scope: s }) => {
  enabled = e;
  scope = s;
  if (!enabled || (scope === 'core' && !isCoreSite())) hideAllShields();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) {
    enabled = changes.enabled.newValue;
    if (!enabled) hideAllShields();
  }
  if (area === 'sync' && changes.scope) {
    scope = changes.scope.newValue;
    if (scope === 'core' && !isCoreSite()) hideAllShields();
  }
});

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

// ----------------------------------------------------------- "model loading" UI
// First install/update: weights can total tens of MB before Cache API caching
// kicks in. Show an explicit state until models report ready.
showLoadingBanner();
checkModelsReady().then(ready => { if (ready) hideLoadingBanner(); });

// ------------------------------------------------------------ IntersectionObserver
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    const key = e.target.dataset?.safescrollKey;
    if (!key) continue;
    if (e.isIntersecting) {
      visible.add(key);
      enqueue(key, e.target);
    } else {
      // Viewport leave => drop registry entry so recycled nodes never carry
      // stale shields (virtualized feeds).
      visible.delete(key);
      removeEntry(key);
      io.unobserve(e.target);
    }
  }
}, { threshold: IO_THRESHOLD });

// ------------------------------------------------------------- MutationObserver
let debounceTimer = null;
const mo = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scan, DEBOUNCE_MS);
});

function startObservers() {
  mo.observe(document.body, { childList: true, subtree: true });
  scan();
}

function scan() {
  if (!enabled) return; // master toggle off — no processing
  if (scope === 'core' && !isCoreSite()) return; // scope limited to core sites
  const units = adapter.units();
  if (units.length) console.log('[SafeScroll]', adapter.siteId, 'scan: units found =', units.length);
  for (const post of units) {
    if (!post || !post.isConnected) continue;
    if (post.dataset.safescrollKey) continue; // already registered
    const keyPromise = adapter.key(post);
    if (!keyPromise) continue;
    keyPromise.then(key => {
      if (!post.isConnected) return; // removed before registration finished
      if (post.dataset.safescrollKey) return;
      post.dataset.safescrollKey = key;
      const shield = createShield(post, { key, siteId: adapter.siteId, overrideGuard });
      shield.update({ action: 'loading' });
      register(key, post, { post: shield });
      io.observe(post);
      if (post.getBoundingClientRect().width) enqueue(key, post); // likely in view
    });
  }
  prune();
}

// ----------------------------------------------------------------- classification
const queue = [];
let scheduled = false;

function enqueue(key, post) {
  if (!enabled) return; // master toggle off
  const entry = get(key);
  if (!entry || entry.verdict || inFlight.has(key)) return;
  if (queue.includes(key)) return;
  queue.push(key);
  if (!scheduled) {
    scheduled = true;
    setTimeout(drain, 50); // batch
  }
}

async function drain() {
  scheduled = false;
  while (queue.length) {
    const key = queue.shift();
    const entry = get(key);
    if (!entry || entry.verdict || !entry.el.isConnected) continue;
    inFlight.add(key);
    try {
      const post = entry.el;
      const text = adapter.text(post);
      const imageUrls = adapter.imageUrls(post);
      console.log('[SafeScroll] classify request:', key.slice(0, 10), '| text len:', text.length, '| images:', imageUrls.length);
      const verdict = await classify({ key, text, imageUrls, siteId: adapter.siteId });
      console.log('[SafeScroll] verdict:', verdict.action, JSON.stringify(verdict.reasons ?? verdict.reason ?? ''), key.slice(0, 10));
      setVerdict(key, verdict);

      // GRANULAR blurring: blur only the part that was actually toxic —
      //   text-tier reasons (text/lexicon) -> blur the text container
      //   media-tier reasons (image/ocr)    -> blur the media container
      // Clean tiers render normally; fully-clean posts have no shields at all.
      if (verdict.action !== 'clean') {
        const reasons = verdict.reasons ?? [];
        const actionFor = rs => {
          if (rs.some(r => r.action === 'block')) return 'block';
          if (rs.some(r => r.action === 'flag')) return 'flag';
          return 'clean';
        };
        const textAction = actionFor(reasons.filter(r => ['text', 'lexicon'].includes(r.source)));
        const mediaAction = actionFor(reasons.filter(r => ['image', 'ocr-text', 'lexicon-ocr'].includes(r.source)));
        const tEl = adapter.textEl?.(post);
        const mEl = adapter.mediaEl?.(post);
        const shields = {};
        if (textAction !== 'clean') {
          const ts = createBlurShield(tEl, { key, siteId: adapter.siteId, overrideGuard, target: 'text' });
          (ts ?? createShield(post, { key, siteId: adapter.siteId, overrideGuard })).update({ ...verdict, action: textAction });
          shields.text = ts;
        }
        if (mediaAction !== 'clean') {
          const ms = createBlurShield(mEl, { key, siteId: adapter.siteId, overrideGuard, target: 'media' });
          (ms ?? createShield(post, { key, siteId: adapter.siteId, overrideGuard })).update({ ...verdict, action: mediaAction });
          shields.media = ms;
        }
        if (!shields.text && !shields.media) {
          // no granular target found — fall back to whole-post shield
          shields.post = createShield(post, { key, siteId: adapter.siteId, overrideGuard });
          shields.post.update(verdict);
        }
        replaceShields(key, shields);
      }

      // Child-mode Scroll Lock: a BLOCK freezes the page behind a PIN screen.
      if (verdict.action === 'block' && !document.getElementById('safescroll-lock')) {
        lockIfConfigured('Blocked content detected on this feed').catch(e =>
          console.error('[SafeScroll] scroll lock failed:', e));
      }
    } catch (e) {
      console.error('[SafeScroll] classify crashed:', e);
      setVerdict(key, { action: 'clean', reason: 'error' });
    } finally {
      inFlight.delete(key);
    }
  }
}

// Safety valve: if the registry grows unbounded (feed churn), prune + cap.
setInterval(() => {
  prune();
  if (size() > 500) console.warn('[SafeScroll] registry exceeded 500 entries after prune — investigate feed churn');
}, 10000);

// Child mode / profile changes could change thresholds live.
chrome.storage.onChanged.addListener(() => { /* thresholds are read offscreen per-request */ });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObservers);
} else {
  startObservers();
}
