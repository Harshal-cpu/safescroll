// Moderation registry. Every processed unit is registered here; entries are
// cleared when the DOM element is REMOVED or leaves the viewport.
//
// BUG FIXED (this made the extension unsafe): the previous implementation
// called removeEntry() on IntersectionObserver leave, which DESTROYED the
// shield — but the element kept its `data-safescroll-key`, so scan() skipped it
// forever. Result: scrolling a blocked post out of view and back in left it
// completely unmoderated. Virtualized feeds compounded it: a recycled node
// inherited the previous item's key and therefore its verdict.
//
// The fix separates two concerns that were previously conflated:
//   - the VERDICT CACHE  — keyed by content identity, survives element removal
//                          and re-entry, so a known-bad unit is never shown
//                          even for one frame.
//   - the ELEMENT BINDING— key -> live element + shields. Rebound on demand.
//
// A re-entering element with a cached verdict is re-shielded SYNCHRONOUSLY in
// the IntersectionObserver callback, before any async work, so there is no
// window in which toxic content is visible.

const registry = new Map(); // key -> { el, shields: {post?, text?, media?}, verdict, identity }
const verdictCache = new Map(); // key -> verdict  (bounded LRU)
const identityCache = new Map(); // key -> stable post id (bounded LRU, survives removal)
const elToKey = new WeakMap(); // Element -> key
const CACHE_MAX = 5000;
const IDENTITY_MAX = 2000;

export function register(key, el, shields = {}) {
  const prev = registry.get(key);
  // The page replaced the node for this key. Drop the shields bound to the OLD
  // node first — otherwise a blur can outlive its post on a host the page no
  // longer uses, and the reference keeps a detached tree alive.
  if (prev && prev.el !== el) {
    for (const old of Object.values(prev.shields ?? {})) old?.destroy?.();
  }
  registry.set(key, {
    el, shields, verdict: null,
    identity: prev?.identity ?? identityCache.get(key) ?? null
  });
  elToKey.set(el, key);
  const cached = verdictCache.get(key);
  if (cached) {
    registry.get(key).verdict = cached;
    for (const shield of Object.values(shields)) shield?.update?.(cached);
  }
  return cached;
}

export function get(key) {
  return registry.get(key);
}

export function keyFor(el) {
  return elToKey.get(el);
}

export function setVerdict(key, verdict) {
  if (verdict) {
    verdictCache.set(key, verdict);
    if (verdictCache.size > CACHE_MAX) {
      // LRU-ish trim: Map preserves insertion order, so the head is oldest.
      const drop = verdictCache.size - CACHE_MAX;
      let i = 0;
      for (const k of verdictCache.keys()) {
        verdictCache.delete(k);
        if (++i >= drop) break;
      }
    }
  }
  const entry = registry.get(key);
  if (!entry) return;
  entry.verdict = verdict;
  // A clean result finishes the temporary scanning state. Remove its DOM
  // entirely (rather than merely display:none) so the host's original
  // positioning is restored and clean pages do not accumulate hidden shields.
  if (verdict?.action === 'clean') {
    for (const shield of Object.values(entry.shields ?? {})) shield?.destroy?.();
    entry.shields = {};
    return;
  }
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
  if (entry.el) {
    // Only clear the key marker if nobody else has claimed this element.
    if (elToKey.get(entry.el) === key) elToKey.delete(entry.el);
  }
  registry.delete(key);
  // NOTE: verdictCache AND identityCache deliberately retain the entry so a
  // returning element is re-shielded instantly from cache, and a still-live
  // post can be re-found by its stable id even after prune() dropped the
  // binding (X replaces the node, prune sees it disconnected, resolveLive
  // needs the id to find the replacement).
}

/**
 * Rebind a re-entering element to an existing key/verdict without re-running
 * the model. Returns true when a cached verdict was applied.
 */
export function rebind(key, el) {
  const cached = verdictCache.get(key);
  const existing = registry.get(key);
  if (existing && existing.el === el) return !!cached;
  // Keep the stable post id across a rebind: it is what lets a later async
  // result find the post's CURRENT element after X replaced this one.
  const identity = existing?.identity ?? identityCache.get(key) ?? null;
  if (existing) removeEntry(key);
  const entry = { el, shields: {}, verdict: cached ?? null, identity };
  registry.set(key, entry);
  elToKey.set(el, key);
  return !!cached;
}

/** Record the stable post id (e.g. X status number) for a key.
 *  First write wins — an id never changes for a given content key. */
export function setIdentity(key, identity) {
  if (!identity) return;
  if (!identityCache.has(key)) {
    identityCache.set(key, identity);
    if (identityCache.size > IDENTITY_MAX) identityCache.delete(identityCache.keys().next().value);
  }
  const entry = registry.get(key);
  if (entry && !entry.identity) entry.identity = identity;
}

/** Stable post id for a key, or null when the adapter produced none.
 *  Survives entry removal (see removeEntry). */
export function getIdentity(key) {
  const entry = registry.get(key);
  return entry?.identity ?? identityCache.get(key) ?? null;
}

export function cachedVerdict(key) {
  return verdictCache.get(key) ?? null;
}

/** Drop entries whose element is no longer connected to the document. */
export function prune() {
  for (const [key, entry] of registry) {
    if (!entry.el?.isConnected) removeEntry(key);
  }
}

export function size() {
  return registry.size;
}

export function cacheSize() {
  return verdictCache.size;
}

export function clearAll() {
  for (const key of [...registry.keys()]) removeEntry(key);
  verdictCache.clear();
  identityCache.clear();
}
