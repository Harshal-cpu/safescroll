// IndexedDB store (lives in the offscreen document — offscreen docs are not
// torn down as aggressively as service workers) with durability guarantees:
//   - every persistVerdict() enters a durable pending queue BEFORE the write
//   - flushPendingWrites() is invoked on keep-alive alarms and unload
//   - failures are logged loudly, never silently swallowed
import { MSG } from '../shared/messages.js';

const DB_NAME = 'safescroll';
const DB_VERSION = 2;
const STORE_VERDICTS = 'verdicts';
const STORE_FEEDBACK = 'feedback';
const STORE_PENDING = 'pending-writes';
const STORE_IMAGES = 'image-verdicts';
// Existing users can have persisted "clean" image results produced before the
// NSFWJS Title-Case label bug was fixed and before violence detection existed.
// Never reuse those false negatives after an extension update. Bump this value
// whenever image models, label mapping, preprocessing, or thresholds change.
const IMAGE_POLICY_VERSION = 'nsfw-labels-v2+violence-v1';
// Old post verdicts may contain an image action without its image URL or omit
// same-severity media findings. Reclassify them after this rendering fix.
// Invalidate verdicts saved while the optional comment model was active.
const VERDICT_POLICY_VERSION = 'granular-media-v2-comment-rollback';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_VERDICTS)) db.createObjectStore(STORE_VERDICTS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_FEEDBACK)) db.createObjectStore(STORE_FEEDBACK, { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains(STORE_PENDING)) db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
        // v2: per-image-URL verdicts. The dominant cost on a photo feed is the
        // network fetch + decode, not the classifier, and the same image URLs
        // recur constantly across views, scrolls and sessions.
        if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES, { keyPath: 'url' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('tx aborted'));
  });
}

// --------------------------------------------------------------- verdict reads
// LATENCY: these are what make repeat visits instant. persistVerdict() has
// always written here, but nothing ever READ it back, so scrolling past a post
// and returning — or simply reloading the page — re-ran the 278M text model on
// identical content (~300ms per window, up to 6 windows).
export async function getVerdict(key, settingsPolicy = null) {
  if (!key) return null;
  // Read-your-writes. persistVerdict() lands in a coalescing buffer first and
  // only reaches IndexedDB WRITE_FLUSH_MS (1500ms) later, so a pure IDB read
  // missed every verdict written in that window — and each miss re-ran the text
  // model on content that had just been classified, which is what produced the
  // duplicated verdict lines and the second CLASSIFY_MEDIA request.
  if (writeBuffer.has(key)) {
    const pending = writeBuffer.get(key);
    return settingsPolicy === null || pending?.settingsPolicy === settingsPolicy ? pending : null;
  }
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VERDICTS, 'readonly');
      const req = tx.objectStore(STORE_VERDICTS).get(key);
      req.onsuccess = () => resolve(
        req.result?.policyVersion === VERDICT_POLICY_VERSION &&
        (settingsPolicy === null || req.result?.verdict?.settingsPolicy === settingsPolicy)
          ? (req.result?.verdict ?? null)
          : null
      );
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // A cache miss must never break classification.
    console.warn('[SafeScroll store] verdict read failed:', e);
    return null;
  }
}

// --------------------------------------------------------- image verdict cache
// Keyed by image URL. On a photo feed (x.com, Instagram, any gallery) the
// classifier itself is cheap (~30ms) but the FETCH + DECODE is 200ms-2s and the
// same URLs recur across views and sessions. This turns a repeat image into a
// ~1ms cache read.
export function isCacheableImageVerdict(verdict) {
  if (!['clean', 'flag', 'block'].includes(verdict?.action)) return false;
  const reasons = [verdict.reason, verdict.detail?.reason,
    verdict.detail?.nsfw?.reason, verdict.detail?.violence?.reason];
  return !reasons.some(reason => /fetch-failed|classify-failed|image-error|no-valid|not-run/.test(String(reason ?? '')));
}

export async function getImageVerdict(url) {
  if (!url) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_IMAGES, 'readonly');
      const req = tx.objectStore(STORE_IMAGES).get(url);
      req.onsuccess = () => resolve(
        req.result?.policyVersion === IMAGE_POLICY_VERSION &&
        isCacheableImageVerdict(req.result?.verdict)
          ? (req.result?.verdict ?? null)
          : null
      );
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[SafeScroll store] image verdict read failed:', e);
    return null;
  }
}

export async function putImageVerdict(url, verdict) {
  if (!url || !isCacheableImageVerdict(verdict)) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    tx.objectStore(STORE_IMAGES).put({
      url, verdict, policyVersion: IMAGE_POLICY_VERSION, ts: Date.now()
    });
    await txDone(tx);
  } catch (e) {
    console.warn('[SafeScroll store] image verdict write failed:', e);
  }
}

/** Drop every cached verdict (dashboard "clear cache" affordance). */
export async function clearVerdicts() {
  writeBuffer.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const db = await openDb();
  const tx = db.transaction([STORE_VERDICTS, STORE_IMAGES, STORE_PENDING], 'readwrite');
  tx.objectStore(STORE_VERDICTS).clear();
  tx.objectStore(STORE_IMAGES).clear();
  tx.objectStore(STORE_PENDING).clear();
  await txDone(tx);
  chrome.runtime.sendMessage({ type: MSG.VERDICTS_UPDATED }).catch(() => {});
  return true;
}

// --------------------------------------------------------------- verdict writes
// LATENCY: verdict persistence runs three IndexedDB transactions per item
// (park -> write -> unpark). On a fast scroll that is dozens of transactions a
// second competing with inference for the same thread. Writes are therefore
// coalesced: a verdict is a pure cache entry, so batching it loses nothing.
// The durable pending-queue is kept for the flush path.
const writeBuffer = new Map();
let flushTimer = null;
const WRITE_FLUSH_MS = 1500;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushWriteBuffer().catch(e => console.error('[SafeScroll store] buffered flush failed:', e));
  }, WRITE_FLUSH_MS);
}

export async function flushWriteBuffer() {
  if (!writeBuffer.size) return;
  const batch = [...writeBuffer.entries()];
  writeBuffer.clear();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_VERDICTS, 'readwrite');
    const store = tx.objectStore(STORE_VERDICTS);
    for (const [key, verdict] of batch) store.put({
      key, verdict, policyVersion: VERDICT_POLICY_VERSION, ts: verdict?.ts ?? Date.now()
    });
    await txDone(tx);
    chrome.runtime.sendMessage({ type: MSG.VERDICTS_UPDATED }).catch(() => {});
  } catch (e) {
    // Put them back so the next flush retries; nothing is lost.
    for (const [k, v] of batch) writeBuffer.set(k, v);
    console.error('[SafeScroll store] write batch failed:', e);
  }
}

/** Durable, coalesced verdict write. */
export async function persistVerdict(key, verdict) {
  if (!key) return;
  writeBuffer.set(key, verdict);
  scheduleFlush();
  // Park durably only for significant verdicts, so a crash mid-scroll cannot
  // lose a BLOCK. Clean verdicts are a pure cache and are safe to drop.
  if (verdict?.action !== 'clean') {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_PENDING, 'readwrite');
      tx.objectStore(STORE_PENDING).add({
        key, verdict, policyVersion: VERDICT_POLICY_VERSION, ts: Date.now()
      });
      await txDone(tx);
    } catch (e) {
      console.error('[SafeScroll store] park failed:', e);
    }
  }
}

// Parked non-clean verdicts are written to the main store and un-parked.
export async function flushPendingWrites() {
  await flushWriteBuffer();
  const db = await openDb();
  const tx = db.transaction([STORE_PENDING, STORE_VERDICTS], 'readwrite');
  const pending = tx.objectStore(STORE_PENDING);
  const verdicts = tx.objectStore(STORE_VERDICTS);
  const cursorReq = pending.openCursor();
  let count = 0;
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    if (cursor.value.policyVersion === VERDICT_POLICY_VERSION) {
      verdicts.put({
        key: cursor.value.key, verdict: cursor.value.verdict,
        policyVersion: VERDICT_POLICY_VERSION, ts: cursor.value.ts
      });
    }
    pending.delete(cursor.primaryKey);
    count++;
    cursor.continue();
  };
  await txDone(tx);
  if (count) console.log(`[SafeScroll store] flushed ${count} parked verdict write(s)`);
}

window.addEventListener('beforeunload', () => { flushPendingWrites().catch(() => {}); });

// ------------------------------------------------------------------- feedback
export async function submitFeedback(feedback) {
  const db = await openDb();
  const tx = db.transaction(STORE_FEEDBACK, 'readwrite');
  tx.objectStore(STORE_FEEDBACK).add({
    ...feedback,
    ts: Date.now()
  });
  await txDone(tx);
  console.log('[SafeScroll store] feedback logged for manual batch review');
}

export async function exportFeedback(format = 'json') {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE_FEEDBACK, 'readonly');
    const req = tx.objectStore(STORE_FEEDBACK).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });

  if (format === 'csv') {
    const header = 'ts,key,verdictAction,expectedAction,siteId,comment';
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [header, ...rows.map(r => [r.ts, r.key, r.verdictAction, r.expectedAction, r.siteId, r.comment].map(esc).join(','))].join('\n');
    return { filename: `safescroll-feedback-${Date.now()}.csv`, content: csv, mime: 'text/csv' };
  }
  return { filename: `safescroll-feedback-${Date.now()}.json`, content: JSON.stringify(rows, null, 2), mime: 'application/json' };
}

export async function getRecentVerdicts(limit = 20) {
  await flushWriteBuffer();
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE_VERDICTS, 'readonly');
    const req = tx.objectStore(STORE_VERDICTS).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);
}

export async function getSessionStats() {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE_VERDICTS, 'readonly');
    const req = tx.objectStore(STORE_VERDICTS).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const blocked = rows.filter(r => r.verdict?.action === 'block').length;
  const flagged = rows.filter(r => r.verdict?.action === 'flag').length;
  const clean = rows.filter(r => r.verdict?.action === 'clean').length;
  // per-source breakdown (which tier caused the verdict)
  const bySource = {};
  for (const r of rows) {
    for (const reason of r.verdict?.reasons ?? []) {
      const k = `${reason.source}:${reason.action}`;
      bySource[k] = (bySource[k] ?? 0) + 1;
    }
  }
  return { ok: true, blocked, flagged, clean, total: rows.length, bySource };
}

// ------------------------------------------------- ImageBitmap transport probe
// Explicitly tests whether ImageBitmap survives structured-clone through
// chrome.runtime.sendMessage. Expected on Chrome: NO (messages are JSON-
// serialized) — which is fine, because the pipeline already sends image
// payloads as ImageData/dataURL. This is an informational self-check, not an
// error; the LOUD failure is reserved for a probe crash (unexpected).
export async function assertImageBitmapTransport() {
  try {
    const canvas = new OffscreenCanvas(2, 2);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 2, 2);
    const bitmap = await createImageBitmap(canvas);
    const resp = await chrome.runtime.sendMessage({ type: MSG.BITMAP_PROBE, bitmap });
    const cameBack = resp?.echoed;
    const survives = !!cameBack && typeof cameBack === 'object' && cameBack.width > 0;
    if (survives) {
      console.info('[SafeScroll offscreen] ImageBitmap transport check: SURVIVES (unexpected on Chrome; pipeline still uses dataURL transport — no action needed).');
    } else {
      console.info('[SafeScroll offscreen] ImageBitmap transport check: not supported across chrome.runtime.sendMessage (EXPECTED on Chrome — JSON serialization). Pipeline already sends images as dataURL/ImageData. No action needed.');
    }
    return survives;
  } catch (e) {
    // Only a genuine probe crash is an error worth failing loudly about.
    console.error('[SafeScroll offscreen] ImageBitmap transport probe crashed (unexpected):', e);
    return false;
  }
}
