// Moderation registry. Every processed post is registered here; entries are
// cleared when the DOM element is REMOVED (MutationObserver) or leaves the
// viewport (IntersectionObserver leave callback) — required so stale shields
// never re-attach to recycled nodes on virtualized feeds (Twitter/YouTube).

const registry = new Map(); // key -> { el, shields: {post?, text?, media?}, verdict }

export function register(key, el, shields = {}) {
  registry.set(key, { el, shields, verdict: null });
}

export function get(key) {
  return registry.get(key);
}

export function setVerdict(key, verdict) {
  const entry = registry.get(key);
  if (!entry) return;
  entry.verdict = verdict;
  for (const shield of Object.values(entry.shields ?? {})) {
    shield?.update?.(verdict);
  }
}

export function replaceShields(key, shields = {}) {
  const entry = registry.get(key);
  if (!entry) return;
  // destroy old (e.g., the post-level loading shield) then install granular ones
  for (const old of Object.values(entry.shields ?? {})) old?.destroy?.();
  entry.shields = shields;
}

export function removeEntry(key) {
  const entry = registry.get(key);
  if (!entry) return;
  for (const shield of Object.values(entry.shields ?? {})) shield?.destroy?.();
  registry.delete(key);
}

// Drop entries whose element is no longer connected to the document.
export function prune() {
  for (const [key, entry] of registry) {
    if (!entry.el?.isConnected) removeEntry(key);
  }
}

export function size() {
  return registry.size;
}
