// Universal unit detection: find the "posts", "comments" and "media" on ANY
// website, without a per-site adapter.
//
// Why this exists: the previous generic adapter matched only
// `article, [role=article], div.g, li.b_algo, [data-sokoban-container]` and
// fell back to `main li, [role=feed] > div`. On Reddit, TikTok, Stack Overflow,
// Discord, forums, most CMS templates and most news sites that matches ZERO
// elements, so the extension did nothing at all.
//
// Strategy, in priority order (first non-empty tier wins):
//   1. SEMANTIC  — explicit comment/post/review selectors used by the major
//                  platforms and CMS templates.
//   2. STRUCTURAL— "repeated sibling group" detection: a parent whose children
//                  share a tag+class signature and similar text shape. This is
//                  the feed/comment-list pattern used by virtually every site,
//                  including ones nobody has an adapter for.
//   3. BLOCKS    — the page has no lists at all (an article page). Fall back to
//                  per-section units so comments and paragraphs are separable.
//
// Everything is bounded: at most MAX_UNITS units and MAX_NODES nodes visited.

import { hasChromeAncestor, isVisible } from './extract.js';

const MAX_UNITS = 400;
const MAX_NODES = 60000;
const MAX_DEPTH = 60;
const MIN_UNIT_CHARS = 24;

// ---------------------------------------------------------------- tier 1
// Comment / post / review selectors. Grouped by the platform or template that
// introduced them. Ordered most-specific first.
const SEMANTIC_UNITS = [
  // --- major platforms
  'shreddit-comment',                                   // new Reddit
  'faceplate-tracker[source="comment"]',                // old Reddit comments
  '[data-testid="post-container"]',                     // new Reddit posts
  'div[data-testid="comment"]',                         // X replies / many clones
  'ytd-comment-thread-renderer',                        // YouTube comments
  'article[data-testid="tweet"]',                       // X timeline
  'div[role="article"]',                                // Facebook feed posts
  'div[data-pagelet^="FeedUnit"]',                      // Facebook feed units
  'div[data-testid="tweetText"]',                       // (too small alone; guarded below)
  'div[role="article"][aria-label]',                    // Google Discover-ish
  'div._5pcr',                                          // Facebook groups post
  'div[dir="auto"][role="article"]',                    // Tumblr / misc
  'div.story',                                          // Snapchat public story
  'li[data-testid="tweet"]',
  'div[data-testid="cellInnerDiv"]',                    // Twitter timeline cell
  'section[data-testid="post"]',
  'div[data-test-id]',                                  // misc blogs
  'div.post', 'div.blog-post', 'div.blogentry', 'article.post',
  // --- comments (the highest-value content on the whole web)
  'li.comment', 'div.comment', 'div.comment-body', 'div.comment-content',
  'ol.comments li', 'ul.comments li', '#comments li', '#comment-list li',
  'div[id^="comment-"]', 'li[id^="comment"]',
  'div.c-comment', 'div.wp-comment', 'li.reply', 'div.reply-comment',
  'div.message', 'div.msg', 'td.msg', 'div.post-body',
  'div[data-testid="comment-content"]',
  'div[aria-label="Comment"]', 'div[aria-label="Reply"]',
  'blockquote.comment', 'blockquote.reply',
  // --- reviews / forum / Q&A
  'div.review', 'li.review', 'div.review-body', 'div.reviewComment',
  'div.answer', 'div.vote', 'div.post-layout', 'div.threadpost',
  'tr.athing',                                          // Hacker News rows
  'div.js-comment', 'div.tweet-comment', 'li.reply-item',
  // --- e-commerce / listings (reviews, seller text)
  'li.product', 'div.product', 'div.listing', 'div.review-card',
  'div.result-item', 'div.search-result', 'li.result',
  'div.card', 'div.tile', 'li.card',
  // --- generic role semantics
  '[role="listitem"]', '[role="feed"] > *', '[role="article"]',
  'article', 'main article', 'section article'
];

// Selectors that mark a CHILD text container but are not units themselves.
// Guarded separately: these are too small to be a post on their own.
const MICRO_SEL = [
  'div[data-testid="tweetText"]', 'div[data-testid="tweetText"] p'
];

// Images: site-level media roots that should be treated as units even when
// there is no textual post around them (meme pages, image boards, galleries).
const MEDIA_ROOTS = [
  'div[data-testid="tweetPhoto"]', 'div[data-testid="tweetPhoto"] img',
  'div[role="group"] img', 'figure', 'picture',
  'div.photo', 'div.media', 'div.image-container',
  'div[data-testid="instagram-post"]', 'div.gallery-item'
];

function matchesAny(el, selectorList) {
  for (const sel of selectorList) {
    try { if (el.matches(sel)) return true; } catch { /* invalid selector */ }
  }
  return false;
}

// ---------------------------------------------------------------- tier 2
// Signature of an element for sibling-grouping purposes. Class names are
// volatile (CSS modules hash them) so we take only the FIRST class token, and
// strip digits so `item-1`/`item-2`/`item-3` group together.
function signature(el) {
  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === 'string' && el.className
    ? el.className.trim().split(/\s+/)[0].replace(/\d+/g, '#')
    : '';
  const role = el.getAttribute('role') || '';
  const testid = (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '').replace(/\d+/g, '#');
  return `${tag}|${cls}|${role}|${testid}`;
}

function shapeScore(text) {
  if (text.length < 20) return 0;
  if (text.length < 60) return 1;
  if (text.length < 300) return 2;
  if (text.length < 1200) return 3;
  return 2;
}

/**
 * Find repeated-sibling groups: containers whose children look like siblings
 * (same signature, similar text shape, at least MIN_GROUP of them). Each such
 * child becomes a unit. This is the universal feed/comment-list pattern.
 */
function structuralUnits(root, budget, near = () => true) {
  const units = [];
  const groupMap = new Map(); // parent -> Map(sig -> [{el, text, shape}])
  const stack = [root];
  let depth = 0;

  while (stack.length && budget.n < MAX_NODES && units.length < MAX_UNITS) {
    const node = stack.pop();
    if (++depth > MAX_DEPTH * 4) break;
    if (node.nodeType !== 1) continue;
    budget.n++;

    if (node.children.length) {
      if (node.children.length <= 200) {
        for (const child of node.children) {
          stack.push(child);
          if (budget.n >= MAX_NODES) break;
        }
      }
      // Group THIS node's children.
      if (node.children.length >= 2 && node.children.length <= 400) {
        let map = groupMap.get(node);
        if (!map) { map = new Map(); groupMap.set(node, map); }
        for (const child of node.children) {
          if (!isVisible(child)) continue;
          if (hasChromeAncestor(child)) continue;
          // Cheap layout pre-filter: during a full-document scan we must not
          // spend a textContent read on a card three screens away.
          if (!near(child)) continue;
          const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
          const sig = signature(child);
          const shape = shapeScore(text);
          if (!map.has(sig)) map.set(sig, []);
          map.get(sig).push({ el: child, text, shape });
        }
      }
    }
  }

  // Resolve groups: a group qualifies when it has >= 2 siblings with a decent
  // amount of text and their shapes agree.
  const accepted = [];
  for (const [parent, map] of groupMap) {
    for (const [sig, items] of map) {
      if (items.length < 2) continue;
      // Skip groups that are pure navigation (already chrome-filtered, but a
      // <ul> of links survives because <li> isn't chrome itself).
      const withText = items.filter(it => it.text.length >= MIN_UNIT_CHARS);
      if (withText.length < 2) continue;
      const shapes = new Set(withText.map(it => it.shape));
      if (shapes.size > 2) continue; // too heterogeneous -> not a list
      const avg = withText.reduce((a, b) => a + b.text.length, 0) / withText.length;
      // Reject giant containers (page wrappers), require list-like density.
      if (avg > 4000) continue;
      accepted.push({ parent, sig, items: withText, score: withText.length * Math.min(avg, 600) });
    }
  }
  // Highest-scoring groups win; we then drop any unit nested inside another.
  accepted.sort((a, b) => b.score - a.score);
  const claimed = new Set();
  for (const g of accepted) {
    for (const it of g.items) {
      if (units.length >= MAX_UNITS) break;
      if (claimed.has(it.el)) continue;
      // Skip if an ancestor is already a unit (keep the outermost granularity).
      let anc = it.el.parentElement, nested = false;
      for (let i = 0; anc && i < 40; i++) {
        if (claimed.has(anc)) { nested = true; break; }
        anc = anc.parentElement;
      }
      if (nested) continue;
      claimed.add(it.el);
      units.push(it.el);
    }
  }
  return { units, claimed, budget };
}

// ---------------------------------------------------------------- tier 3
// Article-style pages with no list structure: carve the page into sections so
// a toxic paragraph in a wall of text can still be isolated.
function blockUnits(root, claimed, near = () => true) {
  const units = [];
  const seen = new Set();
  const selectors = ['main', 'article', 'section', '#content', '#main', '.content', 'body'];
  let container = null;
  for (const sel of selectors) {
    try {
      const found = root.querySelector?.(sel);
      if (found && (found.textContent || '').length > 400) { container = found; break; }
    } catch { /* ignore */ }
  }
  if (!container) return units;

  const blocks = [];
  for (const sec of container.querySelectorAll('section, article, .section, .post, .entry-content, .article-body, .comment-section, #comments, .comments')) {
    if (!claimed.has(sec) && isVisible(sec) && !hasChromeAncestor(sec) && (sec.textContent || '').length >= MIN_UNIT_CHARS) {
      if (near(sec)) blocks.push(sec);
    }
  }
  if (!blocks.length) {
    // No sections — use the container itself, then let the splitter carve it.
    if (near(container)) blocks.push(container);
  }
  for (const b of blocks) {
    if (seen.has(b)) continue;
    seen.add(b);
    units.push(b);
    if (units.length >= 40) break;
  }
  return units;
}

// ---------------------------------------------------------------- driver
// VIEWPORT-ONLY BY DESIGN. This returns ELEMENTS, never materialised units:
// no text extraction, no image capture, no hashing. The content script
// materialises an element only when it actually intersects the viewport, so
// scrolling a 200-post feed costs ~8 extractions, not 200.
//
// `opts.viewportOnly` additionally drops candidates that are far off-screen
// during a full-document scan. They are still picked up later by the
// IntersectionObserver pass, which observes every element this returns.
const PRELOAD_MARGIN = 800;

function rectIntersectsViewport(el, margin) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  return r.bottom > -margin && r.top < window.innerHeight + margin;
}

/**
 * Detect candidate unit elements under `root`.
 * @returns {Element[]}
 */
export function detectUnitElements(root = document, { viewportOnly = false } = {}) {
  const budget = { n: 0 };
  const out = [];
  const claimed = new Set();
  const margin = viewportOnly ? PRELOAD_MARGIN : 0;
  const near = el => !viewportOnly || rectIntersectsViewport(el, margin);

  // --- Tier 1: semantic
  for (const sel of SEMANTIC_UNITS) {
    if (out.length >= MAX_UNITS) break;
    let found;
    try {
      found = root.matches?.(sel)
        ? [root, ...root.querySelectorAll(sel)]
        : root.querySelectorAll(sel);
    } catch { continue; }
    for (const el of found) {
      if (out.length >= MAX_UNITS) break;
      if (claimed.has(el)) continue;
      if (!isVisible(el)) continue;
      if (hasChromeAncestor(el)) continue;
      if (matchesAny(el, MICRO_SEL)) continue; // too small to stand alone
      if (!near(el)) continue;
      // Must have real content: text or an image. textContent is cheap and
      // does not force layout, so this stays affordable.
      const rough = (el.textContent || '').trim().length;
      const hasImg = el.querySelector('img') !== null;
      if (rough < MIN_UNIT_CHARS && !hasImg) continue;
      claimed.add(el);
      out.push(el);
    }
  }

  // --- Tier 2: structural
  if (out.length < MAX_UNITS) {
    const st = structuralUnits(root, budget, near);
    for (const el of st.units) {
      if (out.length >= MAX_UNITS) break;
      if (claimed.has(el)) continue;
      let anc = el.parentElement, nested = false;
      for (let i = 0; anc && i < 40; i++) { if (claimed.has(anc)) { nested = true; break; } anc = anc.parentElement; }
      if (nested) continue;
      claimed.add(el);
      out.push(el);
    }
    for (const c of st.claimed) claimed.add(c);
  }

  // --- Tier 3: block fallback
  if (!out.length) {
    for (const el of blockUnits(root, claimed, near)) {
      claimed.add(el);
      out.push(el);
    }
  }

  // --- Standalone media: pages whose content is images (meme boards, galleries)
  if (out.length < 8) {
    for (const sel of MEDIA_ROOTS) {
      let found;
      try {
        found = root.matches?.(sel)
          ? [root, ...root.querySelectorAll(sel)]
          : root.querySelectorAll(sel);
      } catch { continue; }
      for (const el of found) {
        if (out.length >= MAX_UNITS) break;
        if (claimed.has(el) || !isVisible(el) || hasChromeAncestor(el)) continue;
        if (!near(el)) continue;
        claimed.add(el);
        out.push(el);
      }
    }
  }

  return out;
}
