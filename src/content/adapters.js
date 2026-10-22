// Site adapters. Every adapter follows the same contract:
//   units(root):   candidate post roots as ELEMENTS
//   materialise(): text parts + images for one element (done lazily, on
//                  viewport entry — never for the whole document)
//   key(unit):     stable dedupe key
//
// CRITICAL: inner queries MUST use el.querySelectorAll (scoped to the post
// root) — never document.querySelectorAll.
//
// VIEWPORT-ONLY (latency): `units()` only *detects* candidate elements, which
// is a cheap selector + textContent pass. Text extraction, image capture and
// key hashing happen in materialise(), which the content script calls only when
// an element intersects the viewport. On a feed with 200 posts in the DOM this
// is the difference between ~8 classifications and 200.

// Stable hash for dedupe keys.
// CRITICAL FIX: the previous implementation used crypto.subtle.digest, which is
// UNDEFINED on any non-HTTPS page (not a secure context). Every hash() call
// threw on http:// sites, so nothing was ever registered. quickHash is a
// synchronous non-crypto hash — the key only needs to be a stable identity, not
// a security property.
import { quickHash, stableId, extractParts, joinParts, extractImages, rasteriseAll } from './extract.js';
import { detectUnitElements } from './detect.js';

export { quickHash, stableId };
export function hash(input) {
  return quickHash(String(input));
}

/**
 * Turn a detected element into a full unit. Called only for elements the user
 * can actually see, so the expensive DOM reads happen a handful of times per
 * screenful instead of hundreds of times per page load.
 *
 * Adapters may override `extract(el)` to implement site-accurate extraction.
 * The default below is deliberately generic: it reads leaf BLOCK elements,
 * which is right for articles and forums but WRONG for social feeds, where the
 * visible text sits in a div/span and the surrounding markup is UI chrome
 * (handles, timestamps, action bars). Getting that wrong is what produces
 * mismatched blur targets and polluted classifier input.
 */
export function materialise(el, adapter = null) {
  if (adapter?.extract) {
    try {
      const custom = adapter.extract(el);
      if (custom) return custom;
    } catch (e) {
      console.error('[SafeScroll] adapter.extract failed, falling back:', e);
    }
  }
  const parts = extractParts(el);
  return { el, parts, text: joinParts(parts), images: extractImages(el) };
}

// Async classification can outlive a virtualized feed node. Keep that normal
// stale-node transition outside individual adapters: several mediaEl methods
// intentionally assume they receive a materialised unit and dereference .el.
export function mediaElementFor(adapter, unit) {
  if (!unit) return null;
  return adapter?.mediaEl?.(unit) ?? null;
}

// DOM position path — used by the Instagram fallback key so that short or
// duplicate captions can't collide.
function domPath(el) {
  const parts = [];
  let node = el;
  while (node && node !== document.body && parts.length < 12) {
    const parent = node.parentElement;
    if (!parent) break;
    const idx = [...parent.children].indexOf(node);
    parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return parts.join('>');
}

// --------------------------------------------------------------------- Twitter / X
// X's timeline DOM (verified against the live DOM, not guessed):
//
//   <article data-testid="tweet">          <- the unit
//     div[data-testid="User-Name"]         <- @handle, display name, ·, timestamp
//     div[data-testid="tweetText"]         <- THE ACTUAL POST TEXT (a div, not a p)
//        <span>text…</span>
//     div[data-testid="tweetPhoto"]        <- 1-4 <img src="pbs.twimg.com/media/…">
//     div[role="group"][aria-label=…]      <- "Reply Repost Like Share Views"  CHROME
//     div[data-testid="quoteTweet"]        <- quoted tweet, has its OWN tweetText
//     div[data-testid="socialContext"]     <- "Reposted from …"               CHROME
//     [data-testid="card.wrapper"]         <- link previews                  CHROME
//     [data-testid="videoPlayer"]          <- video (no still frame available)
//
// The generic extractor reads leaf BLOCKS, and X uses div/span, so it fell
// through to the div/span path and returned the handle, the timestamp and the
// action-bar labels as if they were post text. That is what made X "mismatch":
// the classifier was fed UI chrome, and the blur landed on the wrong element.
// The parts of a tweet we deliberately ignore when choosing a blur target.
const X_CHROME = [
  '[data-testid="User-Name"]',
  '[data-testid="UserAvatar-Container"]',
  '[data-testid="socialContext"]',
  '[role="group"]',
  '[data-testid="card.wrapper"]',
  '[data-testid="placementTracking"]',
  'time'
].join(',');

/**
 * All tweetText blocks in a tweet, including a quoted tweet's own body.
 * Anything inside X_CHROME is skipped, so the handle/timestamp/action labels
 * can never reach the classifier.
 */
function xTweetTexts(el) {
  const parts = [];
  for (const n of el.querySelectorAll('[data-testid="tweetText"]')) {
    if (n.closest(X_CHROME)) continue;
    const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length >= 4) parts.push({ el: n, text: t });
  }
  return parts;
}

// X renders several user-authored surfaces outside tweet <article> nodes:
// profile bios, direct messages, notifications, trends and miscellaneous
// timeline cells. The old adapter never returned these roots, so their text
// could not reach the classifier at all.
const X_AUXILIARY_UNITS = [
  '[data-testid="UserDescription"]',
  '[data-testid="messageEntry"]',
  '[data-testid="notification"]',
  '[data-testid="trend"]',
  '[data-testid="cellInnerDiv"]'
].join(',');

const X_AUXILIARY_TEXT = [
  '[data-testid="UserDescription"]',
  '[data-testid="messageText"]',
  '[data-testid="DMMessage"]',
  '[data-testid="notification"] [dir="auto"]',
  '[data-testid="trend"] [dir="auto"]',
  '[data-testid="cellInnerDiv"] [dir="auto"]',
  '[dir="auto"]'
].join(',');

function isTweetRoot(el) {
  return !!el?.matches?.('article[data-testid="tweet"]');
}

/** Meaningful X text outside tweets, excluding names, counters and controls. */
function xAuxiliaryTexts(el) {
  const nodes = [];
  if (el.matches?.(X_AUXILIARY_TEXT)) nodes.push(el);
  nodes.push(...el.querySelectorAll(X_AUXILIARY_TEXT));

  const parts = [];
  const seenText = new Set();
  for (const n of nodes) {
    if (n.closest('article[data-testid="tweet"]')) continue;
    if (n.closest(X_CHROME)) continue;
    if (n.closest('button, [role="button"], [aria-hidden="true"]')) continue;
    // Prefer the deepest text carrier. Parent/child duplicates are common in
    // X's nested dir="auto" wrappers and would otherwise classify twice.
    const child = n.querySelector?.(X_AUXILIARY_TEXT);
    if (child && child !== n) {
      const childText = (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim();
      const own = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
      if (childText === own) continue;
    }
    const text = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4 || seenText.has(text)) continue;
    seenText.add(text);
    parts.push({ el: n, text });
  }
  // Some X surfaces (help text, community/about panels, long-form sections)
  // use semantic HTML instead of dir="auto". Reuse the bounded generic
  // extractor only when the X-specific pass found nothing.
  if (!parts.length) {
    for (const part of extractParts(el)) {
      if (part.el.closest(X_CHROME)) continue;
      if (part.text.length < 4 || seenText.has(part.text)) continue;
      seenText.add(part.text);
      parts.push(part);
    }
  }
  return parts;
}

function xUnitElements(root) {
  const out = [];
  const seen = new Set();
  const add = el => {
    if (!el?.isConnected || seen.has(el)) return;
    // Tweets are always handled as their article root. Auxiliary candidates
    // must neither sit inside a tweet nor wrap one.
    if (!isTweetRoot(el) && (el.closest('article[data-testid="tweet"]') || el.querySelector('article[data-testid="tweet"]'))) return;
    seen.add(el);
    out.push(el);
  };

  if (root.matches?.('article[data-testid="tweet"]')) add(root);
  root.querySelectorAll('article[data-testid="tweet"]').forEach(add);

  const aux = [];
  if (root.matches?.(X_AUXILIARY_UNITS)) aux.push(root);
  aux.push(...root.querySelectorAll(X_AUXILIARY_UNITS));
  // Prefer a specific user-content root over a generic cell that contains it.
  for (const el of aux) {
    if (el.matches('[data-testid="cellInnerDiv"]') &&
        el.querySelector('[data-testid="UserDescription"], [data-testid="messageEntry"], [data-testid="notification"], [data-testid="trend"]')) continue;
    add(el);
  }

  // Finally reuse the universal detector for X surfaces whose data-testid is
  // new or absent. Avoid every overlap with a more precise X root so one piece
  // of text gets one key, one classifier request and one shield.
  try {
    for (const el of detectUnitElements(root)) {
      if (out.some(known => known === el || known.contains(el) || el.contains(known))) continue;
      add(el);
    }
  } catch { /* the explicit X selectors above remain available */ }
  return out;
}

export const twitterAdapter = {
  siteId: 'twitter',
  units(root = document) {
    return xUnitElements(root);
  },
  /** The live unit that owns a mutation inside X's virtualized timeline. */
  containingUnit(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el?.closest) return null;
    return el.closest('article[data-testid="tweet"]') ?? el.closest(X_AUXILIARY_UNITS);
  },
  extract(el) {
    const tweet = isTweetRoot(el);
    const parts = tweet ? xTweetTexts(el) : xAuxiliaryTexts(el);
    const text = parts.map(p => p.text).join('\n');
    // Photos only. A video's poster is a weak single-frame signal and must not
    // produce a verdict for the whole video.
    const images = [];
    if (tweet) {
      for (const img of el.querySelectorAll('[data-testid="tweetPhoto"] img')) {
        if (images.length >= 4) break;
        const photo = img.closest?.('[data-testid="tweetPhoto"]');
        if (photo?.querySelector?.('video, [data-testid="videoPlayer"]')) continue;
        const url = img.currentSrc || img.src || '';
        if (!/^https?:/i.test(url) || url.startsWith('data:')) continue;
        images.push({ url, el: img, dataUrl: null });
      }
    } else {
      images.push(...extractImages(el));
    }
    // Return an empty X unit for video-only posts. Returning null here invokes
    // generic extraction, which can treat the video thumbnail or UI chrome as
    // post content and blur a video that we deliberately did not classify.
    return { el, parts, text, images: rasteriseAll(images), minChars: 4 };
  },
  key(post) {
    const el = post.el;
    const link = el.querySelector('a[href*="/status/"]');
    const id = link?.href.match(/status\/(\d+)/)?.[1];
    // Hash the complete materialised unit. Truncating at 200 characters made a
    // later-expanded toxic tail look identical to the already-clean preview.
    const text = post.text;
    // STABLE IDENTITY FOR X. The status id is immutable; the DOM node is not.
    // DOM position is deliberately NOT part of the key when a status id is
    // available: X re-renders and reorders posts constantly, so a
    // position-dependent key minted a NEW identity for the same post on every
    // re-render and re-ran text + image + OCR on it (the duplicate-processing
    // bug). Fallback keeps the old scheme for units with no status link.
    // Version the key because older releases cached video-poster verdicts as
    // if they were photo verdicts. Those persisted results must not re-blur a
    // video after this extraction fix.
    if (id) return hash(`x:photo-only-v2:${id}:${text}`);
    return hash(`x:photo-only-v2:none:${text}:${domPath(el)}`);
  },
  /** Stable post id (status number) for this unit, or null if it has none. */
  identity(post) {
    const link = post.el.querySelector('a[href*="/status/"]');
    return link?.href.match(/status\/(\d+)/)?.[1] ?? null;
  },
  /**
   * Re-locate a post after X destroyed and recreated its element. Uses the
   * stable status id, never a stored DOM reference. Returns EVERY container
   * that links to that status (a quote-post above can share the id), so the
   * caller can reject containers that already belong to a different key.
   */
  locateAll(postId) {
    if (!postId || !/^\d+$/.test(String(postId))) return [];
    const out = [];
    for (const link of document.querySelectorAll(`a[href*="/status/${postId}"]`)) {
      const container = link.closest('article, [data-testid="tweet"]');
      if (container && !out.includes(container)) out.push(container);
      if (out.length >= 8) break;
    }
    return out;
  },
  /** First candidate from locateAll — the common case. */
  locate(postId) {
    return this.locateAll(postId)[0] ?? null;
  },
  textEl(post) {
    // The largest tweetText — that is what a reader would point at.
    const parts = post.parts || [];
    if (!parts.length) return null;
    return parts.reduce((a, b) => (b.text.length > a.text.length ? b : a)).el;
  },
  mediaEl(post) {
    return post.el.querySelector('[data-testid="tweetPhoto"]') ?? post.images?.[0]?.el?.parentElement ?? null;
  }
};

// -------------------------------------------------------------------- Instagram
// Instagram deliberately gets its own comment units. Treating one <article>
// as one blob merged the caption with every expanded comment, and comments in
// the post dialog often live outside the article altogether.
const INSTAGRAM_COMMENT_SELECTOR = [
  '[data-testid="comment"]',
  'article ul > li',
  'article ul > div',
  'article [role="listitem"]',
  'article [role="list"] > div',
  '[role="dialog"] ul > li',
  '[role="dialog"] ul > div',
  '[role="dialog"] [role="listitem"]',
  '[role="dialog"] [role="list"] > div'
].join(',');

const INSTAGRAM_TEXT_SELECTOR = 'h1, [data-testid="post-caption"], p, [dir="auto"], span';
const INSTAGRAM_UI_TEXT = /^(?:like|likes|reply|replies|follow|following|more|see translation|edited|view(?: all)?(?: \d+)? comments?|\d+[smhdwy])$/i;

function normalizedText(el) {
  return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function instagramCommentElements(root) {
  const candidates = [];
  if (root.matches?.(INSTAGRAM_COMMENT_SELECTOR)) candidates.push(root);
  candidates.push(...(root.querySelectorAll?.(INSTAGRAM_COMMENT_SELECTOR) ?? []));
  const out = [];
  const seen = new Set();
  for (const el of candidates) {
    if (!el?.isConnected || seen.has(el) || el.closest('[data-safescroll="shield"]')) continue;
    const text = normalizedText(el);
    if (text.length < 4) continue;
    // A real IG comment/caption row has an author/profile link, a heading, or
    // an explicit comment/listitem semantic. This rejects carousel dots and
    // action-menu list items that happen to sit under the article/dialog.
    const authored = el.matches('[data-testid="comment"], [role="listitem"]') ||
      !!el.querySelector('h3, h4, a[href^="/"]:not([href^="/p/"]):not([href^="/reel/"])');
    if (!authored) continue;
    seen.add(el);
    out.push(el);
  }
  return out;
}

function instagramTextParts(el, { excludeComments = false, single = false } = {}) {
  const nodes = [];
  if (el.matches?.(INSTAGRAM_TEXT_SELECTOR)) nodes.push(el);
  nodes.push(...el.querySelectorAll(INSTAGRAM_TEXT_SELECTOR));
  const parts = [];
  const seenText = new Set();
  for (const node of nodes) {
    if (excludeComments && node.closest(INSTAGRAM_COMMENT_SELECTOR)) continue;
    // Instagram wraps expandable captions in role="button"; excluding that
    // ancestor drops the post text entirely. Native buttons remain chrome,
    // while role-button action labels are rejected by INSTAGRAM_UI_TEXT below.
    if (node.closest('button, header, nav, time, [aria-hidden="true"]')) continue;
    // Usernames/timestamps are links; actual caption/comment prose is rendered
    // in a sibling span or paragraph. Hashtags inside prose remain represented
    // by their surrounding caption carrier.
    if (node.closest('a') === node || node.parentElement?.closest('a')) continue;
    const direct = [...node.childNodes]
      .filter(n => n.nodeType === 3)
      .map(n => n.nodeValue || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = direct.length >= 4 ? direct :
      (node.matches('h1, p, [dir="auto"], [data-testid="post-caption"]') ? normalizedText(node) : '');
    if (text.length < 4 || INSTAGRAM_UI_TEXT.test(text) || seenText.has(text)) continue;
    seenText.add(text);
    parts.push({ el: node, text });
  }

  // Semantic markup changes frequently. The generic paragraph extractor is a
  // safe fallback, but a comment with an already-resolved text span must not
  // add its whole row (username + comment + controls) as a larger competing
  // part: `single` would select that wrapper and blur/classify the author too.
  if (!single || !parts.length) {
    for (const part of extractParts(el)) {
      if (excludeComments && part.el.closest(INSTAGRAM_COMMENT_SELECTOR)) continue;
      if (part.el.closest('button, header, nav, time')) continue;
      if (INSTAGRAM_UI_TEXT.test(part.text) || seenText.has(part.text)) continue;
      seenText.add(part.text);
      parts.push(part);
    }
  }
  if (!single) return parts.slice(0, 12);
  if (!parts.length) {
    const text = normalizedText(el);
    return text.length >= 4 ? [{ el, text }] : [];
  }
  return [parts.reduce((best, part) => part.text.length > best.text.length ? part : best)];
}

function instagramPostTexts(el) {
  return instagramTextParts(el, { excludeComments: true });
}

function instagramCommentText(el) {
  return instagramTextParts(el, { single: true });
}

export const instagramAdapter = {
  siteId: 'instagram',
  units(root = document) {
    const out = [];
    const seen = new Set();
    const add = el => {
      if (!el?.isConnected || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    if (root.matches?.('article')) add(root);
    root.querySelectorAll?.('article').forEach(add);
    instagramCommentElements(root).forEach(add);
    return out;
  },
  containingUnit(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest?.(INSTAGRAM_COMMENT_SELECTOR) ?? el?.closest?.('article') ?? null;
  },
  extract(el) {
    const comment = el.matches?.(INSTAGRAM_COMMENT_SELECTOR);
    const parts = comment ? instagramCommentText(el) : instagramPostTexts(el);
    const text = parts.map(p => p.text).join('\n');
    const images = comment ? [] : rasteriseAll(extractImages(el));
    if (!text && !images.length) return null;
    return { el, parts, text, images, minChars: 4 };
  },
  key(post) {
    const el = post.el;
    if (el.matches?.(INSTAGRAM_COMMENT_SELECTOR)) {
      const commentId = el.getAttribute('data-comment-id') || el.id ||
        el.querySelector('a[href*="comment_id="], a[href*="/c/"]')?.getAttribute('href') || '';
      return hash(`ig-comment:${commentId}:${post.text}:${domPath(el)}`);
    }
    const link = el.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    const slug = link?.href.match(/\/(p|reel)\/([^/]+)/)?.[0];
    const text = post.text;
    if (slug) return hash(`ig:${slug}:${text}`);
    // Fallback key: MUST combine text hash with DOM position and hash more
    // than 120 characters of input, so short/duplicate captions can't collide.
    const material = `ig-fallback:${text}:pos=${domPath(el)}:len=${text.length}`;
    return hash(material.padEnd(121, '~'));
  },
  textEl(post) {
    if (post.parts?.length) {
      return post.parts.reduce((a, b) => b.text.length > a.text.length ? b : a).el;
    }
    return post.el;
  },
  mediaEl(post) {
    return post.el.querySelector('img[srcset], img[src*="cdninstagram"], img[src*="fbcdn"], video')?.parentElement;
  }
};

// ------------------------------------------------------------------------ Reddit
// Reddit's current UI uses custom elements; old.reddit.com still uses `thing`
// containers. A dedicated adapter covers both without depending on generated
// class names and keeps each comment independent from its parent thread.
const REDDIT_POST_SELECTOR = [
  'shreddit-post',
  '[data-testid="post-container"]',
  'article[data-testid="post-container"]',
  '.thing.link[data-fullname^="t3_"]'
].join(',');

// Reddit runs more than one web renderer at a time. Feed cards on home,
// community and profile pages may be semantic articles or a tracker wrapper
// instead of a shreddit-post. These selectors are intentionally based on
// stable semantics/attributes rather than generated class names.
const REDDIT_FALLBACK_POST_SELECTOR = [
  'faceplate-tracker[source="post"]',
  'article[role="article"]',
  '[role="article"][data-post-id]',
  '[data-post-id^="t3_"]',
  '[thingid^="t3_"]'
].join(',');

// Shreddit renders each custom post host inside a plain article. The article
// is the reliable loading-shield target: content appended to a Shadow DOM host
// is only visible when that component happens to expose a suitable slot.
const REDDIT_POST_WRAPPER_SELECTOR = [
  'article',
  'faceplate-tracker[source="post"]',
  '[role="article"]',
  '[data-post-id^="t3_"]',
  '[thingid^="t3_"]'
].join(',');

// User-authored descriptions live outside feed cards, so a post-only adapter
// would never see them. Keep this list narrow enough to avoid menus/counters.
const REDDIT_AUXILIARY_SELECTOR = [
  '[data-testid="profile-description"]',
  '[data-testid="user-profile-description"]',
  '[data-testid="community-description"]',
  '[data-testid="subreddit-description"]',
  'shreddit-profile-page [slot="description"]',
  'shreddit-subreddit-header [slot="description"]'
].join(',');

const REDDIT_COMMENT_SELECTOR = [
  'shreddit-comment',
  'faceplate-tracker[source="comment"]',
  '[data-testid="comment"]',
  '.thing.comment[data-fullname^="t1_"]'
].join(',');

const REDDIT_CONTAINING_SELECTOR = [
  REDDIT_POST_SELECTOR,
  REDDIT_FALLBACK_POST_SELECTOR,
  REDDIT_AUXILIARY_SELECTOR
].join(',');

function redditPostRoot(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el) return null;
  const concrete = el.matches?.(REDDIT_POST_SELECTOR)
    ? el
    : el.closest?.(REDDIT_POST_SELECTOR) ?? el.querySelector?.(REDDIT_POST_SELECTOR);
  if (concrete) {
    const wrapper = concrete.parentElement?.closest?.(REDDIT_POST_WRAPPER_SELECTOR);
    // Never promote to a shared feed/page article. One wrapper must own one
    // concrete post, otherwise the custom post remains the safer unit.
    if (wrapper && wrapper.querySelectorAll(REDDIT_POST_SELECTOR).length === 1) return wrapper;
    return concrete;
  }
  if (el.matches?.(REDDIT_FALLBACK_POST_SELECTOR)) return el;
  return el.closest?.(REDDIT_FALLBACK_POST_SELECTOR) ?? null;
}

function redditContainingElement(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el) return null;
  const comment = el.closest?.(REDDIT_COMMENT_SELECTOR);
  if (comment) return comment;
  return redditPostRoot(el) ?? el.closest?.(REDDIT_AUXILIARY_SELECTOR) ?? null;
}

function isRedditPageShell(el) {
  return !!el?.matches?.('body, main, [role="main"], #main-content, shreddit-app');
}

function redditUnitElements(root) {
  const out = [];
  const seen = new Set();
  const add = (el, { avoidOverlap = false } = {}) => {
    if (!el?.isConnected || seen.has(el) || el.closest('[data-safescroll="shield"]')) return;
    // The tracker is only a wrapper in the current UI. Prefer its concrete
    // shreddit-comment child to avoid classifying and shielding the same text.
    if (el.matches('faceplate-tracker[source="comment"]') && el.querySelector('shreddit-comment')) return;
    if (avoidOverlap && out.some(known => known === el || known.contains(el) || el.contains(known))) return;
    seen.add(el);
    out.push(el);
  };
  if (root.matches?.(REDDIT_POST_SELECTOR)) add(redditPostRoot(root));
  root.querySelectorAll?.(REDDIT_POST_SELECTOR).forEach(el => add(redditPostRoot(el)));
  if (root.matches?.(REDDIT_COMMENT_SELECTOR)) add(root);
  root.querySelectorAll?.(REDDIT_COMMENT_SELECTOR).forEach(add);
  for (const selector of [REDDIT_FALLBACK_POST_SELECTOR, REDDIT_AUXILIARY_SELECTOR]) {
    if (root.matches?.(selector)) add(redditPostRoot(root) ?? root, { avoidOverlap: true });
    root.querySelectorAll?.(selector).forEach(el => add(redditPostRoot(el) ?? el, { avoidOverlap: true }));
  }

  // Preserve Reddit-specific precision, then fill any renderer gaps with the
  // bounded universal detector. This is what covers new feed-card variants,
  // standalone media, and future community/profile layouts without waiting
  // for another selector release. Normalize children back to a known Reddit
  // root when possible and reject overlaps to prevent duplicate shields.
  try {
    // Fallback discovery is viewport-bounded so a large subreddit/profile
    // does not pay structural-detection cost for hundreds of offscreen cards.
    // The periodic scan picks them up as scrolling brings them near the user.
    for (const candidate of detectUnitElements(root, { viewportOnly: true })) {
      const containing = redditContainingElement(candidate);
      // Universal block fallback can return Reddit's entire #main-content when
      // a search/profile page has no stable post host yet. Treating that page
      // shell as one unit duplicates every child and can blur navigation/search
      // chrome. Individual posts, comments and descriptions are added above.
      if (!containing && isRedditPageShell(candidate)) continue;
      const el = containing ?? candidate;
      add(el, { avoidOverlap: true });
    }
  } catch { /* stable Reddit selectors above remain available */ }
  return out;
}

function redditTextParts(el, comment) {
  const selector = comment
    ? '[slot="comment"], [data-testid="comment-content"], [data-click-id="text"], .usertext-body .md, .md p, p'
    : '[slot="title"], [data-testid="post-title"], [data-adclicklocation="title"], a.title, h1, h2, shreddit-post-text-body, [slot="text-body"], [data-click-id="text"], .usertext-body .md, .md p';
  const parts = [];
  const seenText = new Set();
  const auxiliary = el.matches?.(REDDIT_AUXILIARY_SELECTOR);
  const add = (node, raw) => {
    if (!node) return;
    if (!comment && node.closest(REDDIT_COMMENT_SELECTOR)) return;
    if (node.closest('button, nav, faceplate-dropdown-menu, [aria-hidden="true"]')) return;
    if (!auxiliary && node.closest('header')) return;
    // This custom element's live Shadow DOM has only a named text-body slot.
    // Appending a shield to the host creates an unassigned child that never
    // paints. Prefer its visible light-DOM anchor/paragraph descendants.
    if (!comment && node.matches?.('shreddit-post-text-body') &&
        node.querySelector('[slot="text-body"], .md, p, blockquote')) return;
    const text = String(raw ?? normalizedText(node)).replace(/\s+/g, ' ').trim();
    if (text.length < 4 || seenText.has(text)) return;
    seenText.add(text);
    parts.push({ el: node, text });
  };

  if (!comment) {
    const concrete = el.matches?.(REDDIT_POST_SELECTOR) ? el : el.querySelector(REDDIT_POST_SELECTOR);
    const attrTitle = el.getAttribute('post-title') || concrete?.getAttribute('post-title');
    if (attrTitle) add(el.querySelector('[slot="title"], [data-adclicklocation="title"], a.title, h1, h2') || el, attrTitle);
  }
  if (el.matches?.(selector)) add(el);
  el.querySelectorAll(selector).forEach(node => add(node));
  for (const part of extractParts(el)) add(part.el, part.text);
  return parts.slice(0, 16);
}

function redditRenderableTextTarget(target) {
  if (!target) return null;
  if (target.matches?.('shreddit-post-text-body')) {
    return target.querySelector('[slot="text-body"], .md, p, blockquote') ??
      target.closest('article') ?? target.parentElement;
  }
  return target;
}

function redditStableId(el) {
  const nestedPost = el.matches?.(REDDIT_POST_SELECTOR) ? null : el.querySelector?.(REDDIT_POST_SELECTOR);
  for (const source of [el, nestedPost].filter(Boolean)) {
    for (const attr of ['thingid', 'data-fullname', 'comment-id', 'post-id', 'id']) {
      const value = source.getAttribute(attr);
      if (value && /^(?:t1_|t3_)?[A-Za-z0-9_-]{3,}$/.test(value)) return value;
    }
  }
  return el.getAttribute('permalink') || nestedPost?.getAttribute('permalink') ||
    el.querySelector('a[href*="/comments/"]')?.getAttribute('href') || '';
}

export const redditAdapter = {
  siteId: 'reddit',
  units(root = document) {
    return redditUnitElements(root);
  },
  containingUnit(node) {
    return redditContainingElement(node);
  },
  extract(el) {
    const comment = el.matches?.(REDDIT_COMMENT_SELECTOR);
    const parts = redditTextParts(el, comment);
    const text = parts.map(p => p.text).join('\n');
    const images = comment ? [] : rasteriseAll(extractImages(el));
    if (!text && !images.length) return null;
    return { el, parts, text, images, minChars: 4 };
  },
  key(unit) {
    const kind = unit.el.matches?.(REDDIT_COMMENT_SELECTOR)
      ? 'comment'
      : unit.el.matches?.(REDDIT_CONTAINING_SELECTOR) || unit.el.querySelector?.(REDDIT_POST_SELECTOR) ? 'post' : 'surface';
    return hash(`reddit:${kind}:${redditStableId(unit.el)}:${unit.text}:${domPath(unit.el)}`);
  },
  identity(unit) {
    return redditStableId(unit.el) || null;
  },
  textEl(unit) {
    if (!unit.parts?.length) return unit.el;
    const target = unit.parts.reduce((a, b) => b.text.length > a.text.length ? b : a).el;
    return redditRenderableTextTarget(target);
  },
  mediaEl(unit) {
    const extracted = unit.images?.[0]?.el;
    if (extracted) return extracted.parentElement ?? extracted;
    const media = unit.el.querySelector(
      'shreddit-media-lightbox, shreddit-player, [data-testid="post-image"], img[src*="redd.it"], img[src*="redditmedia"], video'
    );
    return media ? (media.parentElement ?? media) : null;
  }
};

// ---------------------------------------------------------------------- YouTube
export const youtubeAdapter = {
  siteId: 'youtube',
  units(root = document) {
    const selector = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-comment-thread-renderer, ytd-watch-metadata';
    const out = root.matches?.(selector) ? [root] : [];
    out.push(...root.querySelectorAll(selector));
    return out;
  },
  containingUnit(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest?.('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-comment-thread-renderer, ytd-watch-metadata') ?? null;
  },
  key(post) {
    const el = post.el;
    const link = el.querySelector('a#video-title-link, a#thumbnail, a[href*="watch"]');
    const id = link?.href?.match(/[?&]v=([\w-]+)/)?.[1] ?? link?.href;
    const text = post.text;
    // comment threads: author channel id = stable per commenter
    const cid = el.querySelector('#author-comment-id, ytd-comment-view-model')?.getAttribute('data-id') ?? '';
    return hash(`yt:${id ?? 'none'}:${cid}:${text}:${domPath(el)}`);
  },
  textEl(post) {
    const el = post.el;
    if (el.tagName === 'YTD-COMMENT-THREAD-RENDERER' || el.tagName === 'YTD-COMMENT-VIEW-MODEL') {
      return el.querySelector('#content-text, #text')?.parentElement;
    }
    return el.querySelector('#video-title, h1.title, h3')?.parentElement;
  },
  mediaEl(post) {
    const el = post.el;
    if (el.tagName === 'YTD-COMMENT-THREAD-RENDERER' || el.tagName === 'YTD-COMMENT-VIEW-MODEL') return null; // text-only
    return el.querySelector('#player, ytd-player, img.ytCinematicContainerViewModelBackgroundImage, img[src*="ytimg.com/vi/"], video, ytd-thumbnail')?.parentElement;
  }
};

// ---------------------------------------------------------------------- Generic
// Used on ALL non-core sites: news sites, blogs, forums, wikis, docs, search
// engines, image boards, social platforms without an adapter. Backed by the
// universal detector in detect.js (semantic selectors -> structural repeated
// sibling groups -> block fallback), so it degrades gracefully instead of
// matching nothing.
export const genericAdapter = {
  siteId: 'generic',
  units(root = document) {
    try {
      return detectUnitElements(root);
    } catch (e) {
      console.error('[SafeScroll] detectUnitElements failed:', e);
      return [];
    }
  },
  key(unit) {
    // Content-derived identity. Deliberately NOT domPath-based for the generic
    // adapter: virtualized lists recycle nodes, and a position key would make a
    // recycled node inherit the previous item's verdict.
    const id = stableId(unit.el);
    const text = unit.text;
    const imgs = (unit.images || []).map(i => i.url).join(',').slice(0, 200);
    return hash(`gen:${id}:${text}:${imgs}:${text.length}`);
  },
  textEl(unit) {
    // Blur the dominant text part, not the whole unit — a 2000-word article
    // must not vanish because one paragraph was toxic.
    if (unit.parts?.length) {
      return unit.parts.reduce((a, b) => (b.text.length > a.text.length ? b : a)).el;
    }
    return unit.el;
  },
  mediaEl(unit) {
    const img = unit.images?.[0]?.el;
    return img ? (img.parentElement ?? img) : null;
  }
};

export function pickAdapter() {
  const host = location.hostname;
  if (host.includes('instagram')) return instagramAdapter;
  if (host.includes('twitter') || host === 'x.com' || host.endsWith('.x.com')) return twitterAdapter;
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) return redditAdapter;
  if (host.includes('youtube')) return youtubeAdapter;
  return genericAdapter;
}
