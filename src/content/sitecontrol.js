// Per-site control: "pause SafeScroll on this site" + host matching.
// All-sites injection is the product requirement, so users need an escape
// hatch per host (a bug tracker, a code review tool, a design system — places
// where blurring text is actively harmful).

/**
 * Registrable-domain approximation without a public-suffix list dependency.
 * Handles the common two-label public suffixes (co.uk, com.au, com.br, ...).
 * Good enough for a user-facing pause list.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.sg', 'com.hk',
  'co.nz', 'co.za', 'co.kr', 'com.tw', 'com.my', 'co.il', 'com.pl', 'com.ua'
]);

export function hostKey(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** True when this host (or its parent domain) is paused. */
export function isHostPaused(pausedHosts, hostname) {
  if (!Array.isArray(pausedHosts) || !pausedHosts.length) return false;
  const key = hostKey(hostname);
  return pausedHosts.some(p => p === key || p === hostname || key.endsWith('.' + p));
}

export async function getPausedHosts() {
  const { pausedHosts = [] } = await chrome.storage.sync.get({ pausedHosts: [] });
  return Array.isArray(pausedHosts) ? pausedHosts : [];
}

export async function toggleHostPause(hostname) {
  const key = hostKey(hostname);
  const hosts = await getPausedHosts();
  const idx = hosts.indexOf(key);
  let paused;
  if (idx >= 0) { hosts.splice(idx, 1); paused = false; }
  else { hosts.push(key); paused = true; }
  await chrome.storage.sync.set({ pausedHosts: hosts });
  return { paused, hosts, key };
}
