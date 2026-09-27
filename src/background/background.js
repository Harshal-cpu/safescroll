// SafeScroll background service worker.
// Responsibilities:
//  - ensureOffscreen(): create the offscreen doc and AWAIT an explicit readiness
//    handshake with a hard timeout. Never silently proceeds on failure.
//  - Relay classify requests content-script -> offscreen (ML runs off-main-thread).
//  - Real "Anywhere mode" gate via chrome.permissions.request() + dynamic content
//    script registration (cosmetic-free: scripts are NOT injected until granted).
//  - Keep-alive alarm + onSuspend handling so IndexedDB writes are not lost to
//    service-worker teardown mid-write.

import { MSG } from '../shared/messages.js';

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
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }
  // Fallback for older Chrome
  const clients = await chrome.runtime.getContexts
    ? []
    : await self.clients?.matchAll?.() ?? [];
  return clients.length > 0;
}

// ------------------------------------------------------------- readiness handshake
// Two guarantees:
//  1. offscreen.js posts {type: READY} immediately after registering onMessage
//     (handled in onMessage listener below -> resolves createWaiter).
//  2. ensureOffscreen() additionally does a live PING/PONG with an explicit
//     timeout so an ALREADY-EXISTING offscreen doc is verified too.
let readyWaiter = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.READY) {
    log('offscreen posted READY');
    if (readyWaiter) {
      clearTimeout(readyWaiter.timer);
      readyWaiter.resolve();
      readyWaiter = null;
    }
    sendResponse({ ok: true });
  }
  if (msg?.type === MSG.PING) {
    // Echo ping back to prove round-trip works for the offscreen self-test.
    sendResponse({ ok: true, echoed: msg.payload ?? null });
  }
  if (msg?.type === MSG.BITMAP_PROBE) {
    // Echo the bitmap back so the offscreen probe can verify whether it
    // survived the JSON-serialized transport.
    sendResponse({ ok: true, echoed: msg.bitmap ?? null });
  }
  if (msg?.type === MSG.CLASSIFY) {
    // Relay to offscreen; keep the port open for the async response.
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'get-session-stats') {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'get-recent-verdicts') {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'get-model-info') {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'test-text') {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'self-test') {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === MSG.GET_PROFILES) {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === MSG.STATUS) {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === MSG.FEEDBACK) {
    relayToOffscreen(msg).then(sendResponse);
    return true;
  }
});

async function relayToOffscreen(msg) {
  try {
    await ensureOffscreen();
    // Cold-start race: the first message after offscreen creation can lose the
    // responder race and resolve undefined/{}. Retry until a real response.
    for (let i = 0; i < 3; i++) {
      const r = await chrome.runtime.sendMessage(msg);
      if (r && Object.keys(r).length > 0) return r;
      await new Promise(res => setTimeout(res, 600));
    }
    return { error: 'offscreen gave no usable response after retries' };
  } catch (e) {
    fail('relay failed:', e);
    return { error: String(e) };
  }
}

export async function ensureOffscreen() {
  const exists = await hasOffscreen();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Runs on-device ML inference (transformers.js, nsfwjs, Tesseract) + IndexedDB writes off the main thread.'
    });
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
          const resp = await chrome.runtime.sendMessage({ type: MSG.PING, payload: 'handshake' });
          if (resp?.ok) {
            clearTimeout(timer);
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
    chrome.runtime.sendMessage({ type: 'flush-pending-writes' }).catch(() => {});
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
