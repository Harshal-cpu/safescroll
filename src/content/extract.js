// Universal text + media extraction from an arbitrary DOM subtree.
//
// Design constraints (these are the rules that keep the open web working):
//  1. NEVER document-wide queries. Everything is scoped to the unit root.
//  2. Skip CHROME (nav/header/footer/forms/dialogs/widgets) or we moderate
//     cookie banners and menu labels instead of content.
//  3. Text is extracted from LEAF block elements (one per paragraph), not from
//     wrappers, so a single toxic paragraph can be blurred on its own.
//  4. Every visual read is memoised/bounded — this runs on every site.
//
// No async, no crypto: this must work on plain http:// pages where
// crypto.subtle does not exist (not a secure context).

// --------------------------------------------------------------------- chrome
// Elements that are never user content. `header`/`footer` are deliberately NOT
// here: inside <article>/<main> they are real content (byline, source, date).
export const CHROME_SEL = [
  'nav', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="complementary"]', '[role="search"]', '[role="menu"]',
  '[role="menubar"]', '[role="menuitem"]', '[role="toolbar"]',
  '[role="tablist"]', '[role="dialog"]', '[role="alertdialog"]',
  'form', 'button', 'select', 'option', 'optgroup', 'input', 'textarea',
  'label', 'fieldset', 'legend', 'datalist', 'output',
  'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'script', 'style', 'link', 'meta'
].join(',');

// Class/id fragments that mark site furniture. Matched against className and
// id, word-ish, so "navigation" matches but "innovative" does not.
const FURNITURE_RE =
  /(^|[\s_\-])(nav|navbar|navigation|menu|sidebar|side-?bar|breadcrumb|pagination|paginator|cookie|consent|gdpr|modal|popup|overlay|tooltip|dropdown|toolbar|masthead|top-?bar|widget|advert|advertisement|ad-?slot|sponsor|promo|social-?share|share-?bar|recirc|trending|skip-?link|search-?box|login|dialog|popup-?window|backdrop)([\s_\-]|$)/i;

// Block-level text carriers. Ordered by how much we trust them.
const BLOCK_SEL = 'p, li, blockquote, pre, figcaption, dd, dt, td, h1, h2, h3, h4, h5, h6, cite, q, summary, address, caption';

const MIN_PART_CHARS = 12;
const MAX_PARTS = 60;
const MAX_PART_CHARS = 2000;
const MAX_TEXT_CHARS = 12000;

// Marks subtrees already known to be chrome, so we never pay closest() twice.
const chromeMemo = new WeakSet();

/** True when `el` sits inside site furniture (nav, form, cookie banner, ...). */
export function isChrome(el) {
  if (!el) return true;
  if (chromeMemo.has(el)) return true;
  const hit = CHROME_SEL.split(',').some(s => {
    try { return el.matches(s); } catch { return false; }
  }) || FURNITURE_RE.test(el.id || '') || FURNITURE_RE.test(typeof el.className === 'string' ? el.className : '');
  if (hit) { chromeMemo.add(el); return true; }
  return false;
}

/**
 * Walk up from `el` looking for chrome. Memoised per node so repeated calls
 * across a big page stay cheap. Bounded depth guards against pathological DOMs.
 */
export function hasChromeAncestor(el) {
  if (!el) return true;
  let node = el;
  for (let i = 0; node && i < 64; i++) {
    if (chromeMemo.has(node)) return true;
    node = node.parentElement;
  }
  // Second pass: test (and memoise) each ancestor for the selectors. Done
  // separately so a positive result is remembered for the whole subtree.
  node = el;
  const chain = [];
  for (let i = 0; node && i < 64; i++) { chain.push(node); node = node.parentElement; }
  for (const n of chain) {
    if (chromeMemo.has(n)) return true;
    if (isChrome(n)) {
      for (const c of chain.slice(chain.indexOf(n))) chromeMemo.add(c);
      return true;
    }
  }
  return false;
}

/** Rendered? Cheap and good enough — catches display:none, hidden, 0-size. */
export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.hidden) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  return el.getClientRects().length > 0;
}

function ownText(el) {
  // text of this element's DIRECT text children only — no descendant text.
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function fullText(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract leaf-ish text parts from a unit root.
 * Returns [{ el, text }] — one entry per paragraph-ish block, top-level only
 * (a <p> inside a <blockquote> is emitted once, by the <p>).
 */
export function extractParts(root) {
  const parts = [];
  if (!root) return parts;
  const candidates = root.querySelectorAll
    ? root.querySelectorAll(BLOCK_SEL)
    : [];
  const seen = new Set();
  for (const c of candidates) {
    if (parts.length >= MAX_PARTS) break;
    if (seen.has(c)) continue;
    if (!isVisible(c)) continue;
    const direct = ownText(c);
    let text = direct;
    let el = c;
    // A wrapper with no direct text (e.g. <div class="c"><span>hi</span></div>
    // reached via <li>) — fall back to the whole subtree text.
    if (text.length < MIN_PART_CHARS) {
      const whole = fullText(c);
      if (whole.length > text.length) { text = whole; }
    }
    if (text.length < MIN_PART_CHARS) continue;
    if (text.length > MAX_PART_CHARS) text = text.slice(0, MAX_PART_CHARS) + '…';
    // Skip if an ancestor within the unit was already emitted (dedupe nesting).
    let anc = c.parentElement;
    let nested = false;
    for (let i = 0; anc && anc !== root && i < 8; i++) {
      if (seen.has(anc)) { nested = true; break; }
      anc = anc.parentElement;
    }
    if (nested) continue;
    seen.add(c);
    parts.push({ el, text });
  }
  // Elements with text but no block ancestor at all (bare <div> posts, most
  // modern sites): find the deepest div-ish node holding the text.
  if (!parts.length) {
    const all = root.querySelectorAll ? root.querySelectorAll('div, span, section') : [];
    for (const d of all) {
      if (parts.length >= MAX_PARTS) break;
      if (seen.has(d) || !isVisible(d)) continue;
      const direct = ownText(d);
      const text = direct.length >= MIN_PART_CHARS ? direct : fullText(d);
      if (text.length < MIN_PART_CHARS) continue;
      let hasPartChild = false;
      for (const ch of d.children) if (seen.has(ch)) { hasPartChild = true; break; }
      if (hasPartChild) continue;
      seen.add(d);
      parts.push({ el: d, text: text.slice(0, MAX_PART_CHARS) });
    }
  }
  return parts;
}

export function joinParts(parts) {
  let s = '';
  for (const p of parts) {
    s += (s ? '\n' : '') + p.text;
    if (s.length > MAX_TEXT_CHARS) break;
  }
  return s.slice(0, MAX_TEXT_CHARS);
}

// --------------------------------------------------------------------- media
const IMG_BLOCKLIST =
  /(^|[\/_.\-])(logo|icon|avatar|sprite|emoji|spacer|pixel|blank|placeholder|gravatar|favicon|badge|btn|button|banner-?ad|pixel-?1x1|transparent|spinner|loader|placeholder-?image)([\/_.\-]|$)/i;

const MIN_IMG_W = 140;
const MIN_IMG_H = 110;
const MAX_IMAGES_PER_UNIT = 3;

/** Collect image URLs worth classifying inside a unit. */
export function extractImages(root, { exclude = null, limit = MAX_IMAGES_PER_UNIT } = {}) {
  if (!root || !root.querySelectorAll) return [];
  const out = [];
  const seen = new Set();
  const imgs = root.querySelectorAll('img');
  for (const img of imgs) {
    if (out.length >= limit) break;
    if (exclude && exclude.has(img)) continue;
    if (!isVisible(img)) continue;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < MIN_IMG_W || h < MIN_IMG_H) continue;
    let url = img.currentSrc || img.src || '';
    if (!url) continue;
    if (url.startsWith('data:')) {
      // Inline data-URI images: keep only if plausibly a real photo.
      if (url.length < 20000) continue;
    }
    if (url.startsWith('blob:')) continue;
    if (!/^https?:/i.test(url)) continue;
    if (IMG_BLOCKLIST.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, el: img, dataUrl: maybeRaster(img) });
  }
  return out;
}

/**
 * Attach page-captured pixels to image descriptors that were built by a
 * site-specific adapter (which cannot import the rasteriser privately).
 */
export function rasteriseAll(images) {
  return (images || []).map(i => (i.dataUrl ? i : { ...i, dataUrl: maybeRaster(i.el) }));
}

/**
 * Best-effort pixels for the offscreen document.
 *
 * A canvas is only readable when the image is same-origin or was requested
 * with crossOrigin=anonymous — otherwise toDataURL throws SecurityError. Both
 * cases are common in the wild (many CDNs send CORS headers), and it saves the
 * offscreen doc a network round trip when it works. Failure is silent by design.
 *
 * RESOLUTION IS AN OCR REQUIREMENT, NOT JUST A NICETY. Meme text is small and
 * often high-contrast; capturing at 448px (the original choice) destroys it and
 * Tesseract returns nothing. 900px @ q0.90 is the compromise: still ~90KB over
 * the message channel, but enough pixels for meme text to survive. The offscreen
 * document downscales to 512 for the NSFW model, which is all it needs.
 */
function maybeRaster(img, maxSide = 900, quality = 0.9) {
  try {
    if (!img.complete || !img.naturalWidth) return null;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw < MIN_IMG_W || nh < MIN_IMG_H) return null;
    const scale = Math.min(1, maxSide / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * scale));
    const h = Math.max(1, Math.round(nh * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  } catch {
    return null; // tainted canvas — the offscreen doc will fetch the URL instead
  }
}

// ------------------------------------------------------------------ splitting
// A unit whose text is far too long to be one blur target (a 40-paragraph
// article) must be split, otherwise one toxic sentence blacks out a whole page.
//
// This is also the main LATENCY lever. Text inference costs ~300ms per
// 128-token window, so the split threshold directly caps per-unit latency:
// at 700 chars a unit is at most 2 windows (~600ms) instead of 6 (~1800ms).
// Split aggressively and let the splitter guarantee no single unit is huge.
const SPLIT_THRESHOLD = 700;
const SPLIT_MIN_CHILD = 140;

/**
 * Split an oversized unit into child units, each with its own text parts and
 * its own images. Returns a flat list (possibly the original, unsplit).
 */
export function splitUnit(el) {
  const parts = extractParts(el);
  const total = joinParts(parts);
  if (total.length <= SPLIT_THRESHOLD) return null;
  const kids = [...el.children].filter(k => k !== el && isVisible(k) && !hasChromeAncestor(k));
  const bigKids = kids.filter(k => fullText(k).length >= SPLIT_MIN_CHILD);
  if (bigKids.length < 2) return null;
  return bigKids.map(kid => {
    const kidParts = extractParts(kid);
    return {
      el: kid,
      parts: kidParts,
      text: joinParts(kidParts),
      images: extractImages(kid)
    };
  });
}

// ------------------------------------------------------------------- identity
// A content-derived key (not a DOM-path key). Recycled virtualized nodes get a
// NEW key when their content changes, which is what stops a stale verdict from
// being inherited by different content.
export function quickHash(str) {
  // FNV-1a 32-bit ×2 with different offsets -> 64-bit-ish hex. Sync, works in
  // any context including non-secure http:// pages.
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Stable per-post identifier when the page exposes one (id, permalink, ...). */
export function stableId(el) {
  const attrNames = ['data-testid', 'data-id', 'data-post-id', 'data-comment-id', 'id'];
  for (const a of attrNames) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v && v.length < 120) return `${a}:${v}`;
  }
  const link = el.querySelector && el.querySelector('a[href*="/p/"], a[href*="/status/"], a[href*="?v="], a[href*="/comments/"], a[permalink]');
  if (link) {
    const href = link.getAttribute('href') || '';
    if (href && href.length < 200) return `href:${href}`;
  }
  return '';
}
