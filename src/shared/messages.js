export const MSG = {
  READY: 'offscreen-ready',
  PING: 'offscreen-ping',
  MODELS_READY: 'models-ready',
  MODELS_PROGRESS: 'models-progress',
  CLASSIFY: 'classify',
  GET_PROFILES: 'get-profiles',
  FEEDBACK: 'feedback',
  BITMAP_PROBE: 'bitmap-probe',
  BITMAP_PROBE_RESULT: 'bitmap-probe-result',
  STATUS: 'status',
  GET_RUNTIME_SETTINGS: 'get-runtime-settings',
  RUNTIME_SETTINGS_CHANGED: 'runtime-settings-changed',
  ANYWHERE_ENABLE: 'anywhere-enable',
  ANYWHERE_DISABLE: 'anywhere-disable',
  ANYWHERE_STATE: 'anywhere-state',
  EXPORT_FEEDBACK: 'export-feedback',
  CLEAR_VERDICT_CACHE: 'clear-verdict-cache',
  // Media-only pass, sent as a separate message AFTER the text verdict has been
  // rendered, so image fetching (200ms-2s) and OCR (1-3s) never delay the blur.
  CLASSIFY_MEDIA: 'classify-media',
  CLASSIFY_ANIMATED: 'classify-animated',
  ANIMATED_VERDICT: 'animated-verdict',
  // Pushed to every tab when a background media pass upgrades an already-shown
  // text verdict. The content script filters on `key`.
  VERDICT_REFINED: 'verdict-refined',
  // Diagnostic: what the media pass actually did (settings, budget, OCR text,
  // per-image results). Read-only; exists because "the meme never blurs" has
  // too many silent failure points to guess at.
  MEDIA_DIAG: 'media-diag'
};

/**
 * Message types the background service worker forwards to the offscreen
 * document.
 *
 * WHY THIS MUST BE A CONTRACT, NOT A LOCAL SET:
 * `chrome.runtime.sendMessage()` BROADCASTS to every extension context except
 * the sender. So a content-script `classify` reaches BOTH the background
 * service worker AND the offscreen document. The background relays it to
 * offscreen again -> the offscreen handler runs TWICE for one send: two model
 * inferences, two OCR passes, two OCR budget tokens. This set is the single
 * source of truth shared by background (relay) and offscreen (first delivery
 * wins), so the two cannot drift apart.
 */
export const OFFSCREEN_ROUTED = new Set([
  MSG.CLASSIFY,
  MSG.CLASSIFY_MEDIA,
  MSG.CLASSIFY_ANIMATED,
  MSG.GET_PROFILES,
  MSG.STATUS,
  MSG.FEEDBACK,
  MSG.EXPORT_FEEDBACK,
  MSG.CLEAR_VERDICT_CACHE,
  MSG.PING,
  'flush-pending-writes',
  'get-session-stats',
  'get-recent-verdicts',
  'get-model-info',
  'test-text',
  'self-test'
]);

/** Set on a message once the service worker has taken ownership of it. */
export const RELAY_MARK = '__ssRelay';
