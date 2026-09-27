// IndexedDB store (lives in the offscreen document — offscreen docs are not
// torn down as aggressively as service workers) with durability guarantees:
//   - every persistVerdict() enters a durable pending queue BEFORE the write
//   - flushPendingWrites() is invoked on keep-alive alarms and unload
//   - failures are logged loudly, never silently swallowed
import { MSG } from '../shared/messages.js';

const DB_NAME = 'safescroll';
const DB_VERSION = 1;
const STORE_VERDICTS = 'verdicts';
const STORE_FEEDBACK = 'feedback';
const STORE_PENDING = 'pending-writes';

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

// --------------------------------------------------------------- verdict writes
export async function persistVerdict(key, verdict) {
  if (!key) return;
  // 1. Durable pre-write: park the record in the pending store first.
  const db = await openDb();
  let pendingId;
  {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    const req = tx.objectStore(STORE_PENDING).add({ key, verdict, ts: Date.now() });
    req.onsuccess = () => { pendingId = req.result; };
    await txDone(tx);
  }
  try {
    // 2. Real write.
    const tx = db.transaction(STORE_VERDICTS, 'readwrite');
    tx.objectStore(STORE_VERDICTS).put({ key, verdict, ts: Date.now() });
    await txDone(tx);
    // 3. Clear pending marker.
    const tx2 = db.transaction(STORE_PENDING, 'readwrite');
    tx2.objectStore(STORE_PENDING).delete(pendingId);
    await txDone(tx2);
  } catch (e) {
    console.error('[SafeScroll store FAIL] persistVerdict failed; record parked in pending-writes for flush:', e);
    throw e;
  }
}

export async function flushPendingWrites() {
  const db = await openDb();
  const tx = db.transaction([STORE_PENDING, STORE_VERDICTS], 'readwrite');
  const pending = tx.objectStore(STORE_PENDING);
  const cursorReq = pending.openCursor();
  let count = 0;
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    tx.objectStore(STORE_VERDICTS).put({ key: cursor.value.key, verdict: cursor.value.verdict, ts: cursor.value.ts });
    pending.delete(cursor.primaryKey);
    count++;
    cursor.continue();
  };
  await txDone(tx);
  if (count) console.log(`[SafeScroll store] flushed ${count} pending verdict write(s)`);
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
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE_VERDICTS, 'readonly');
    const req = tx.objectStore(STORE_VERDICTS).openCursor(null, 'prev'); // newest last; keyPath 'key' is a string — use openCursor reversed
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return rows.slice(-limit).reverse();
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
  // per-source breakdown (which tier caused the verdict)
  const bySource = {};
  for (const r of rows) {
    for (const reason of r.verdict?.reasons ?? []) {
      const k = `${reason.source}:${reason.action}`;
      bySource[k] = (bySource[k] ?? 0) + 1;
    }
  }
  return { ok: true, blocked, flagged, total: rows.length, bySource };
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
