// Bridge to the background service worker.
let modelsReady = false;
let readyPromise = null;
let listenerInstalled = false;
let contextInvalidated = false;
const invalidationListeners = new Set();

export function isExtensionContextInvalidatedError(error) {
  const message = String(error?.message ?? error ?? '');
  return /extension context invalidated/i.test(message);
}

function markContextInvalidated(error) {
  if (contextInvalidated || !isExtensionContextInvalidatedError(error)) return false;
  contextInvalidated = true;
  for (const listener of invalidationListeners) {
    try { listener(); } catch { /* shutdown listeners are best-effort */ }
  }
  invalidationListeners.clear();
  return true;
}

export function onExtensionContextInvalidated(listener) {
  if (contextInvalidated) queueMicrotask(listener);
  else invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export async function sendRuntimeMessage(message) {
  if (contextInvalidated) throw new Error('Extension context invalidated.');
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    markContextInvalidated(error);
    throw error;
  }
}

function installReadyListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'models-ready') {
      modelsReady = !msg.error;
    } else if (msg?.type === 'models-progress') {
      // Progress events are informational; the banner is hidden on ready.
    }
  });
}

export async function classify(payload) {
  try {
    const resp = await sendRuntimeMessage({ type: 'classify', ...payload });
    if (resp?.error) {
      console.error('[SafeScroll] classify failed loudly:', resp.error, '| verdict fallback:', resp.verdict);
      return { action: 'clean', reason: 'pipeline-error' };
    }
    if (!resp?.verdict) console.warn('[SafeScroll] classify: no verdict in response:', resp);
    return resp?.verdict ?? { action: 'clean', reason: 'no-verdict' };
  } catch (e) {
    if (isExtensionContextInvalidatedError(e)) {
      return { action: 'unavailable', reason: 'context-invalidated' };
    }
    console.error('[SafeScroll] classify transport failed:', e);
    return { action: 'clean', reason: 'transport-error' };
  }
}

export async function reportFeedback(feedback) {
  return sendRuntimeMessage({ type: 'feedback', feedback }).catch(e => {
    if (isExtensionContextInvalidatedError(e)) return;
    console.error('[SafeScroll] feedback failed:', e);
  });
}

export async function checkModelsReady() {
  try {
    const resp = await sendRuntimeMessage({ type: 'status' });
    modelsReady = !!resp?.modelsReady;
    if (resp?.modelsError) console.error('[SafeScroll] model load error:', resp.modelsError);
  } catch (e) {
    if (isExtensionContextInvalidatedError(e)) return false;
    console.error('[SafeScroll] status check failed:', e);
  }
  return modelsReady;
}

/**
 * Wait until the on-device models report ready, so the loading banner doesn't
 * vanish on a 300MB cold start. Resolves either way — a failure here must not
 * leave a permanent banner over someone's page.
 */
export function waitForModels({ onReady, timeoutMs = 180000, intervalMs = 1000 } = {}) {
  installReadyListener();
  if (readyPromise) return readyPromise;
  readyPromise = new Promise(resolve => {
    const started = Date.now();
    const tick = async () => {
      if (contextInvalidated) { onReady?.(); return resolve(false); }
      try {
        if (await checkModelsReady()) { onReady?.(); return resolve(true); }
      } catch { /* keep polling */ }
      if (Date.now() - started > timeoutMs) { onReady?.(); return resolve(false); }
      setTimeout(tick, intervalMs);
    };
    setTimeout(tick, 300);
  });
  return readyPromise;
}

export { modelsReady };
