import { MSG } from '../shared/messages.js';

const VIDEO_LIMIT_SECONDS = 60;
const FRAME_TIMES = [0, 0.5, 1];

export function isGifSource(url) {
  return /^data:image\/gif;base64,/i.test(url || '') || /\.gif(?:[?#]|$)/i.test(url || '');
}

export function isShortVideo(duration) {
  return Number.isFinite(duration) && duration > 0 && duration <= VIDEO_LIMIT_SECONDS;
}

function sourceOf(el) {
  if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
  return el.currentSrc || el.src || el.querySelector('source')?.src || '';
}

export function createAnimatedMediaScanner({ send, createShield, overrideGuard, isEnabled, policy, siteId }) {
  const states = new Map();
  const byId = new Map();
  let serial = 0;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = states.get(entry.target);
      if (!state) continue;
      state.visible = entry.isIntersecting;
      if (state.visible) {
        if (state.kind === 'video' && state.sampled.size < FRAME_TIMES.length) state.baseTime = state.el.currentTime;
        start(state);
      }
      else cancelFrame(state);
    }
  }, { rootMargin: '100px' });

  function cancelFrame(state) {
    if (state.callbackId != null) state.el.cancelVideoFrameCallback?.(state.callbackId);
    state.callbackId = null;
  }

  function forget(state) {
    cancelFrame(state);
    state.el.removeEventListener('loadeddata', state.onReady);
    state.el.removeEventListener('loadedmetadata', state.onReady);
    state.el.removeEventListener('play', state.onReady);
    state.shield?.destroy?.();
    state.layoutObserver?.disconnect();
    observer.unobserve(state.el);
    states.delete(state.el);
    byId.delete(state.id);
  }

  function current(state) {
    return isEnabled() && state.el.isConnected && sourceOf(state.el) === state.source;
  }

  function submit(state, frameIndex, dataUrl, attempt = 0) {
    if (!current(state)) return;
    void send({ type: MSG.CLASSIFY_ANIMATED, kind: state.kind,
      scanId: state.id, frameIndex, dataUrl, referer: location.href })
      .then(reply => {
        if (reply?.skipped === 'busy' && attempt < 2 && current(state) && state.visible) {
          setTimeout(() => submit(state, frameIndex, dataUrl, attempt + 1), 1500);
        }
      })
      .catch(() => {});
  }

  function capture(state, mediaTime) {
    if (!current(state) || !state.visible || !isShortVideo(state.el.duration) ||
        state.el.readyState < 2 || state.sampled.size >= FRAME_TIMES.length) return;
    const elapsed = Math.max(0, mediaTime - (state.baseTime ?? mediaTime));
    if (elapsed > 2.5) return;
    const index = FRAME_TIMES.findLastIndex(time => elapsed >= time);
    if (state.sampled.has(index)) return;
    if (index < 0 || !state.el.videoWidth || !state.el.videoHeight) return;
    const scale = Math.min(1, 900 / Math.max(state.el.videoWidth, state.el.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(state.el.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(state.el.videoHeight * scale));
    try {
      canvas.getContext('2d').drawImage(state.el, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
      state.sampled.add(index);
      submit(state, index, dataUrl);
    } catch {
      // Cross-origin media without CORS permission taints canvas. No verdict
      // is claimed for pixels the browser does not permit us to read.
      state.unreadable = true;
      cancelFrame(state);
    }
  }

  function scheduleFrame(state) {
    if (!current(state) || !state.visible || state.unreadable ||
        state.callbackId != null || state.sampled.size >= FRAME_TIMES.length ||
        typeof state.el.requestVideoFrameCallback !== 'function') return;
    state.callbackId = state.el.requestVideoFrameCallback((_now, info) => {
      state.callbackId = null;
      capture(state, info.mediaTime);
      if (info.mediaTime - (state.baseTime ?? info.mediaTime) <= 2.5) scheduleFrame(state);
    });
  }

  function start(state) {
    if (!current(state) || !state.visible) return;
    if (state.kind === 'gif') {
      if (state.sent || !state.source) return;
      state.sent = true;
      state.gifAttempts = (state.gifAttempts || 0) + 1;
      void send({ type: MSG.CLASSIFY_ANIMATED, kind: 'gif', scanId: state.id,
        url: state.source, referer: location.href }).then(reply => {
          if (reply?.skipped === 'busy' && state.gifAttempts < 3 && current(state)) {
            setTimeout(() => { state.sent = false; start(state); }, 1500);
          }
        }).catch(() => {});
      return;
    }
    if (!isShortVideo(state.el.duration)) return;
    capture(state, state.el.currentTime);
    scheduleFrame(state);
  }

  function observeRoot(root) {
    if (!root?.querySelectorAll || !isEnabled()) return;
    for (const state of states.values()) if (!state.el.isConnected) forget(state);
    const candidates = [...(root.matches?.('video, img') ? [root] : []), ...root.querySelectorAll('video, img')];
    for (const el of candidates) {
      const kind = el.tagName === 'VIDEO' ? 'video' : 'gif';
      const source = sourceOf(el);
      if (kind === 'gif' && !isGifSource(source)) continue;
      if (!source || !el.isConnected) continue;
      const old = states.get(el);
      if (old?.source === source) continue;
      if (old) forget(old);
      const state = { el, kind, source, id: `ssanim:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}:${serial++}`,
        sampled: new Set(), visible: false, sent: false, callbackId: null, shield: null,
        onReady: () => start(state) };
      states.set(el, state);
      byId.set(state.id, state);
      if (kind === 'video') {
        el.addEventListener('loadeddata', state.onReady);
        el.addEventListener('loadedmetadata', state.onReady);
        el.addEventListener('play', state.onReady);
      }
      observer.observe(el);
    }
  }

  function onVerdict(msg) {
    const state = byId.get(msg?.scanId);
    const verdict = msg?.verdict;
    if (!state || !current(state) || verdict?.settingsPolicy !== policy() ||
        !['block', 'flag'].includes(verdict?.action) ||
        state.shield?.dataset.userOverrode === '1') return;
    if (state.action === 'block' || (state.action === 'flag' && verdict.action === 'flag')) return;
    const parent = state.el.parentElement;
    if (!parent || ['BODY', 'HTML', 'MAIN'].includes(parent.tagName)) return;
    if (!state.shield) {
      state.shield = createShield(parent, { target: 'media', key: state.id, siteId,
        overrideGuard, verdict: { action: verdict.action } });
      if (!state.shield) return;
      const position = () => {
        if (!state.shield?.isConnected || !state.el.isConnected) return;
        if (state.shield.classList?.contains('safescroll-inline')) return;
        const media = state.el.getBoundingClientRect();
        const host = state.shield.parentElement.getBoundingClientRect();
        Object.assign(state.shield.style, {
          inset: 'auto', left: `${media.left - host.left}px`, top: `${media.top - host.top}px`,
          width: `${media.width}px`, height: `${media.height}px`
        });
      };
      state.layoutObserver = new ResizeObserver(position);
      state.layoutObserver.observe(state.el);
      state.layoutObserver.observe(state.shield.parentElement || parent);
      position();
    }
    state.action = verdict.action;
    state.shield.update({ action: verdict.action,
      reasons: [{ source: `${state.kind} frame ${msg.frameIndex + 1}: ${verdict.source || 'media'}`,
        action: verdict.action }] });
  }

  function reset() { for (const state of [...states.values()]) forget(state); }
  function stop() { reset(); observer.disconnect(); }
  return { observeRoot, onVerdict, reset, stop };
}
