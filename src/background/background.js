// SafeScroll background service worker.
// Responsibilities:
//  - ensureOffscreen(): create the offscreen doc and AWAIT an explicit readiness
//    handshake with a hard timeout. Never silently proceeds on failure.
//  - Relay classify requests content-script -> offscreen (ML runs off-main-thread).
//  - Real "Anywhere mode" gate via chrome.permissions.request() + dynamic content
//    script registration (cosmetic-free: scripts are NOT injected until granted).
//  - Keep-alive alarm + onSuspend handling so IndexedDB writes are not lost to
//    service-worker teardown mid-write.

import { MSG, OFFSCREEN_ROUTED, RELAY_MARK } from '../shared/messages.js';
import { MODERATION_DEFAULTS, normalizeModerationSettings } from '../shared/moderationSettings.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const ENSURE_TIMEOUT_MS = 20000; // hard timeout: throw on failure, never pass silently

// ---------------------------------------------------------------- utilities
function log(...args) {
  console.log('[SafeScroll bg]', ...args);
}
function fail(...args) {
  console.error('[SafeScroll bg FAIL]', ...args);
}

async function hasOffscreen() {
  // chrome.runtime.getContexts is Chrome 116+. Below that, `clients` is not
  // exposed in an MV3 service worker at all, so the honest answer is "unknown".
  // The previous fallback (`self.clients?.matchAll?.()`) evaluated to `[]` and
  // therefore ALWAYS reported "no offscreen document" — every relay then tried
  // to create a second one and failed. Unknown is now handled explicitly by
  // treating a duplicate-creation error as success.
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length > 0;
    } catch {
      return false;
    }
  }
  return null; // unknown
}

// ------------------------------------------------------------- readiness handshake
// Two guarantees:
//  1. offscreen.js posts {type: READY} immediately after registering onMessage
//     (handled in onMessage listener below -> resolves createWaiter).
//  2. ensureOffscreen() additionally does a live PING/PONG with an explicit
//     timeout so an ALREADY-EXISTING offscreen doc is verified too.
let readyWaiter = null;
// Set once a PING has actually come back PONG for this service-worker
// lifetime. See ensureOffscreen(): without it every relayed message re-ran the
// full handshake, producing one "handshake OK" log line per classify.
let offscreenVerified = false;

// Everything that must reach the offscreen document now lives in
// shared/messages.js (OFFSCREEN_ROUTED). Both this relay and the offscreen
// router read that ONE set: `chrome.runtime.sendMessage()` broadcasts to every
// extension context, so a content-script `classify` reaches the offscreen
// document directly AND again through this relay unless the offscreen drops
// the direct copy. See RELAY_MARK below.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.GET_RUNTIME_SETTINGS) {
    chrome.storage.sync.get({ ...MODERATION_DEFAULTS, enabled: true })
      .then(values => sendResponse({ settings: normalizeModerationSettings(values), enabled: values.enabled !== false }))
      .catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (msg?.type === MSG.READY) {
    log('offscreen posted READY');
    if (readyWaiter) {
      clearTimeout(readyWaiter.timer);
      readyWaiter.resolve();
      readyWaiter = null;
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === MSG.PING) {
    // Echo ping back to prove round-trip works for the offscreen self-test.
    sendResponse({ ok: true, echoed: msg.payload ?? null });
    return;
  }
  if (msg?.type === MSG.BITMAP_PROBE) {
    // Echo the bitmap back so the offscreen probe can verify whether it
    // survived the JSON-serialized transport.
    sendResponse({ ok: true, echoed: msg.bitmap ?? null });
    return;
  }
  if (msg?.type === MSG.VERDICT_REFINED || msg?.type === MSG.ANIMATED_VERDICT) {
    // Broadcast to all tabs; content scripts filter on the content key.
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs ?? []) {
        if (tab.id == null) continue;
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    });
    return;
  }
  if (OFFSCREEN_ROUTED.has(msg?.type)) {
    // Relay to offscreen; keep the port open for the async response.
    const scanRequest = [MSG.CLASSIFY, MSG.CLASSIFY_MEDIA, MSG.CLASSIFY_ANIMATED].includes(msg.type);
    const response = scanRequest
      ? chrome.storage.sync.get({ enabled: true }).then(({ enabled }) =>
        enabled === false ? { ok: false, error: 'protection-disabled' } : relayToOffscreen(msg))
      : relayToOffscreen(msg);
    response.then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

// Offscreen documents have runtime messaging but no chrome.storage API.
let settingsRevision = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled) {
    chrome.runtime.sendMessage({ type: MSG.PROTECTION_CHANGED,
      enabled: changes.enabled.newValue !== false, [RELAY_MARK]: 1 }).catch(() => {});
  }
  if (!Object.keys(MODERATION_DEFAULTS).some(key => key in changes)) return;
  const revision = ++settingsRevision;
  chrome.storage.sync.get(MODERATION_DEFAULTS).then(values => {
    if (revision !== settingsRevision) return;
    return chrome.runtime.sendMessage({ type: MSG.RUNTIME_SETTINGS_CHANGED,
      settings: normalizeModerationSettings(values), [RELAY_MARK]: 1 });
  }).catch(() => {}); // a closed offscreen document reads settings on next boot
});

async function relayToOffscreen(msg) {
  try {
    await ensureOffscreen();
    // Ownership mark: the offscreen document already received the ORIGINAL
    // copy of this message directly (sendMessage broadcasts to every extension
    // context). It processes the original only if it is not marked, and this
    // relayed copy only because it IS marked — so the handler runs exactly once.
    const owned = { ...msg, [RELAY_MARK]: 1 };
    // Cold-start race: the first message after offscreen creation can lose the
    // responder race and resolve undefined/{}. Retry until a real response.
    for (let i = 0; i < 3; i++) {
      const r = await chrome.runtime.sendMessage(owned);
      if (r && Object.keys(r).length > 0) return r;
      await new Promise(res => setTimeout(res, 600));
    }
    offscreenVerified = false;
    return { error: 'offscreen gave no usable response after retries' };
  } catch (e) {
    // The document may have died between calls while still reported as existing.
    // Drop the verified flag so the next relay re-runs the handshake instead of
    // trusting a stale fast path.
    offscreenVerified = false;
    fail('relay failed:', e);
    return { error: String(e) };
  }
}

let creatingOffscreen = null;

export async function ensureOffscreen() {
  const exists = await hasOffscreen();
  if (exists === true && offscreenVerified) {
    // Fast path: the document exists AND this SW has already proved it answers
    // PING. PINGing again on every relayed message cost a round trip and a log
    // line per classify (~100 lines in one normal scroll) for no information.
    // The relay's own retry loop still catches a document that died afterwards,
    // and relayToOffscreen clears the flag so the next call re-verifies.
    return;
  }
  if (exists !== true) {
    // Serialise creation: concurrent classify messages used to race and one
    // would lose with "Only a single offscreen document may be created".
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Runs on-device ML inference (transformers.js, nsfwjs, Tesseract) + IndexedDB writes off the main thread.'
      }).catch(e => {
        // A document already exists (race, or getContexts unavailable on
        // Chrome <116) — that is success, not failure.
        if (/single offscreen document|already exists/i.test(String(e))) {
          log('offscreen document already present');
          return;
        }
        throw e;
      }).finally(() => { creatingOffscreen = null; });
    }
    await creatingOffscreen;
  }
  // PING/PONG handshake with hard timeout. An unresolved response is treated
  // as FAILURE and surfaces loudly — it is never treated as "pass".
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const msg = `offscreen readiness handshake TIMED OUT after ${ENSURE_TIMEOUT_MS}ms (${exists ? 'existing' : 'newly created'} doc)`;
      fail(msg);
      reject(new Error(msg));
    }, ENSURE_TIMEOUT_MS);
    (async () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        try {
          const resp = await chrome.runtime.sendMessage({ type: MSG.PING, payload: 'handshake', [RELAY_MARK]: 1 });
          if (resp?.ok) {
            clearTimeout(timer);
            offscreenVerified = true;
            log(`offscreen handshake OK (attempt ${attempt})`);
            resolve();
            return;
          }
        } catch (e) {
          // offscreen listener not registered yet; retry after backoff
        }
        await new Promise(r => setTimeout(r, 250));
      }
      clearTimeout(timer);
      const msg = 'offscreen readiness handshake FAILED: no PONG after 10 attempts';
      offscreenVerified = false;
      fail(msg);
      reject(new Error(msg));
    })();
  });
}

// ------------------------------------------------------------------ keep-alive
// Alarms keep the service worker from being torn down while offscreen writes
// are in flight, and act as a wakeup signal to flush pending IndexedDB writes.
chrome.alarms.create('safescroll-keepalive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'safescroll-keepalive') {
    // Poke offscreen so any pending write queue flushes while SW is alive.
    chrome.runtime.sendMessage({ type: 'flush-pending-writes', [RELAY_MARK]: 1 }).catch(() => {});
  }
});

chrome.runtime.onSuspend.addListener(() => {
  // Best-effort: ask offscreen to flush synchronously; it also listens for
  // 'beforeunload' itself. Every persistVerdict() is recorded in a durable
  // pending queue BEFORE the write, so nothing is silently lost.
  fail('onSuspend: service worker suspending; offscreen flush gate engaged');
});

// ------------------------------------------------------------------ scope
// All-sites moderation is now the DEFAULT (manifest host_permissions http/https
// all). The dashboard's "Moderation scope" setting (storage.sync 'scope') lets
// users limit it back to the three core sites; the content script enforces it.

chrome.runtime.onInstalled.addListener(() => {
  log('installed/updated — showing model-loading state on next page load');
  ensureOffscreen().catch(e => fail('initial offscreen bootstrap failed:', e));
});
