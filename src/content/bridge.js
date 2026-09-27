// Bridge to the background service worker.
let modelsReady = false;

export async function classify(payload) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'classify', ...payload });
    if (resp?.error) {
      console.error('[SafeScroll] classify failed loudly:', resp.error, '| verdict fallback:', resp.verdict);
      return { action: 'clean', reason: 'pipeline-error' };
    }
    if (!resp?.verdict) console.warn('[SafeScroll] classify: no verdict in response:', resp);
    return resp?.verdict ?? { action: 'clean', reason: 'no-verdict' };
  } catch (e) {
    console.error('[SafeScroll] classify transport failed:', e);
    return { action: 'clean', reason: 'transport-error' };
  }
}

export async function reportFeedback(feedback) {
  return chrome.runtime.sendMessage({ type: 'feedback', feedback }).catch(e => {
    console.error('[SafeScroll] feedback failed:', e);
  });
}

export async function checkModelsReady() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'status' });
    modelsReady = !!resp?.modelsReady;
    if (resp?.modelsError) console.error('[SafeScroll] model load error:', resp.modelsError);
  } catch (e) {
    console.error('[SafeScroll] status check failed:', e);
  }
  return modelsReady;
}

export { modelsReady };
