// Site adapters. Every adapter follows the same contract:
//   units(root):          candidate post roots (viewport candidates)
//   key(unit):            stable dedupe key
//   text(unit):           caption/title text
//   imageUrls(unit):      media URLs worth classifying
// CRITICAL (per architecture constraint): inner queries MUST use
// post.querySelectorAll (scoped to the post root) — never document.querySelectorAll.

// Stable hash for dedupe keys.
export async function hash(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
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
export const twitterAdapter = {
  siteId: 'twitter',
  units(root = document) {
    return [...root.querySelectorAll('article[data-testid="tweet"]')];
  },
  async key(post) {
    const link = post.querySelector('a[href*="/status/"]');
    const id = link?.href.match(/status\/(\d+)/)?.[1];
    const text = this.text(post).slice(0, 200);
    return hash(`x:${id ?? 'none'}:${text}:${domPath(post)}`);
  },
  text(post) {
    return post.querySelector('[data-testid="tweetText"]')?.innerText?.trim() ?? '';
  },
  textEl(post) {
    return post.querySelector('[data-testid="tweetText"]');
  },
  mediaEl(post) {
    // the media container (photo/video), not the whole post
    return post.querySelector('img[src*="pbs.twimg.com/media"], img[alt="Image"], video[aria-label], div[data-testid="videoPlayer"]')?.parentElement;
  },
  imageUrls(post) {
    return [...post.querySelectorAll('img[src*="pbs.twimg.com/media"], img[alt="Image"]')]
      .map(i => i.currentSrc || i.src)
      .filter(u => /^https:/.test(u));
  }
};

// -------------------------------------------------------------------- Instagram
export const instagramAdapter = {
  siteId: 'instagram',
  units(root = document) {
    return [...root.querySelectorAll('article')];
  },
  async key(post) {
    const link = post.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    const slug = link?.href.match(/\/(p|reel)\/([^/]+)/)?.[0];
    const text = this.text(post).slice(0, 300);
    if (slug) return hash(`ig:${slug}:${text}`);
    // Fallback key: MUST combine text hash with DOM position and hash more
    // than 120 characters of input, so short/duplicate captions can't collide.
    const material = `ig-fallback:${text}:pos=${domPath(post)}:len=${text.length}`;
    return hash(material.padEnd(121, '~'));
  },
  text(post) {
    const cap = post.querySelector('h1, ._a9zs, div[role="button"] > div > div > span');
    return cap?.innerText?.trim() ?? '';
  },
  textEl(post) {
    return post.querySelector('h1, ._a9zs, div[role="button"] > div > div > span');
  },
  mediaEl(post) {
    return post.querySelector('img[srcset], img[src*="cdninstagram"], img[src*="fbcdn"], video')?.parentElement;
  },
  imageUrls(post) {
    return [...post.querySelectorAll('img[srcset], img[src*="cdninstagram"], img[src*="fbcdn"]')]
      .map(i => i.currentSrc || i.src)
      .filter(u => /^https:/.test(u));
  }
};

// ---------------------------------------------------------------------- YouTube
export const youtubeAdapter = {
  siteId: 'youtube',
  units(root = document) {
    return [
      ...root.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-comment-thread-renderer, ytd-watch-metadata')
    ];
  },
  async key(post) {
    const link = post.querySelector('a#video-title-link, a#thumbnail, a[href*="watch"]');
    const id = link?.href?.match(/[?&]v=([\w-]+)/)?.[1] ?? link?.href;
    const text = this.text(post).slice(0, 200);
    // comment threads: author channel id = stable per commenter
    const cid = post.querySelector('#author-comment-id, ytd-comment-view-model')?.getAttribute('data-id') ?? '';
    return hash(`yt:${id ?? 'none'}:${cid}:${text}:${domPath(post)}`);
  },
  text(post) {
    if (post.tagName === 'YTD-COMMENT-THREAD-RENDERER' || post.tagName === 'YTD-COMMENT-VIEW-MODEL') {
      return post.querySelector('#content-text, #text')?.innerText?.trim() ?? '';
    }
    const t = post.querySelector('#video-title, h1.title, h3')?.innerText?.trim() ?? '';
    const desc = post.querySelector('#description-inline-expander, .yt-formatted-string#description-text, #description')?.innerText?.trim() ?? '';
    return `${t} ${desc}`.trim();
  },
  textEl(post) {
    if (post.tagName === 'YTD-COMMENT-THREAD-RENDERER' || post.tagName === 'YTD-COMMENT-VIEW-MODEL') {
      return post.querySelector('#content-text, #text')?.parentElement;
    }
    return post.querySelector('#video-title, h1.title, h3')?.parentElement;
  },
  mediaEl(post) {
    if (post.tagName === 'YTD-COMMENT-THREAD-RENDERER' || post.tagName === 'YTD-COMMENT-VIEW-MODEL') return null; // text-only
    return post.querySelector('#player, ytd-player, img.ytCinematicContainerViewModelBackgroundImage, img[src*="ytimg.com/vi/"], video, ytd-thumbnail')?.parentElement;
  },
  imageUrls(post) {
    if (post.tagName === 'YTD-COMMENT-THREAD-RENDERER') return []; // avatars only — skip
    // Video thumbnails are weak signals; titles/descriptions carry the signal.
    return [...post.querySelectorAll('img.ytCinematicContainerViewModelBackgroundImage, img[src*="ytimg.com/vi/"]')]
      .map(i => i.currentSrc || i.src)
      .filter(u => /^https:/.test(u))
      .slice(0, 1);
  }
};

// ---------------------------------------------------------------------- Generic
// Used on ALL non-core sites (Anywhere mode is now the default): news sites,
// blogs, forums, and SEARCH ENGINES (Google results = div.g, Bing = li.b_algo,
// DuckDuckGo = article). Candidate roots are found with a coarse selector; ALL
// inner queries are scoped to the result root via post.querySelectorAll.
export const genericAdapter = {
  siteId: 'generic',
  units(root = document) {
    const roots = [
      ...root.querySelectorAll(
        'article, [role="article"], div.g, li.b_algo, [data-sokoban-container]'
      )
    ];
    // Fallback for skeleton-less sites: common feed containers.
    if (!roots.length) {
      roots.push(...root.querySelectorAll('main li, [role="feed"] > div'));
    }
    return roots;
  },
  async key(post) {
    const text = this.text(post).slice(0, 300);
    const firstLink = post.querySelector('a[href]')?.href ?? '';
    const material = `gen:${text}:link=${firstLink}:pos=${domPath(post)}:len=${text.length}`;
    return hash(material.padEnd(121, '~'));
  },
  text(post) {
    // Scoped to the post root — NOT document.querySelectorAll.
    const candidates = [
      ...post.querySelectorAll('h1, h2, h3, p, span, [role="heading"], blockquote')
    ];
    return candidates.map(c => c.innerText?.trim()).filter(Boolean).join(' ').slice(0, 1000);
  },
  textEl(post) {
    // Scoped to the post root — NOT document.querySelectorAll.
    return post.querySelector('h1, h2, h3, p, [role="heading"], blockquote')?.parentElement ?? post;
  },
  mediaEl(post) {
    // Scoped to the post root — NOT document.querySelectorAll.
    return post.querySelector('img[src^="https://"], img[src^="http://"], video, g-img')?.parentElement;
  },
  imageUrls(post) {
    // Scoped to the post root — NOT document.querySelectorAll.
    return [...post.querySelectorAll('img[src^="https://"], img[src^="http://"]')]
      .filter(i => (i.naturalWidth || i.width) > 120 && !i.src.includes('avatar') && !i.src.includes('logo') && !/favicon|sprite|icon/i.test(i.src))
      .map(i => i.currentSrc || i.src)
      .slice(0, 2);
  }
};

export function pickAdapter() {
  const host = location.hostname;
  if (host.includes('instagram')) return instagramAdapter;
  if (host.includes('twitter') || host === 'x.com' || host.endsWith('.x.com')) return twitterAdapter;
  if (host.includes('youtube')) return youtubeAdapter;
  return genericAdapter;
}
