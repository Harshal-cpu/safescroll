import { MSG } from '../shared/messages.js';

const stateEl = document.getElementById('modelState');
const enabledEl = document.getElementById('enabled');

// ---- master on/off toggle ----
chrome.storage.sync.get({ enabled: true }).then(({ enabled }) => { enabledEl.checked = enabled; });
enabledEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ enabled: enabledEl.checked });
});

// ---- model status ----
function renderModelState(r) {
  if (r?.modelsError) {
    stateEl.textContent = 'load failed';
    stateEl.className = 'badge err';
    stateEl.title = r.modelsError;
    console.error('[SafeScroll] model load failed:', r.modelsError);
  } else if (r?.modelsReady) {
    stateEl.textContent = 'ready';
    stateEl.className = 'badge ok';
  } else if (r?.stageState) {
    const stages = Object.entries(r.stageState).map(([k, v]) => `${k}:${v}`).join(' ');
    stateEl.textContent = r.loadStarted ? stages : 'not started';
    stateEl.className = 'badge off';
    stateEl.title = r.modelsError ?? '';
  } else {
    stateEl.textContent = 'loading…';
  }
}

function pollStatus() {
  chrome.runtime.sendMessage({ type: MSG.STATUS }).then(renderModelState).catch(() => {
    stateEl.textContent = 'bg error';
    stateEl.className = 'badge err';
  });
}
pollStatus();
const statusPoll = setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  chrome.runtime.sendMessage({ type: MSG.STATUS }).then(r => {
    renderModelState(r);
    if (r?.modelsReady || r?.modelsError) clearInterval(statusPoll);
  }).catch(() => {});
}, 1500);
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === MSG.MODELS_READY) { renderModelState({ modelsReady: !msg.error, modelsError: msg.error }); clearInterval(statusPoll); }
});

// ---- session stats (this browser session, from offscreen store) ----
chrome.runtime.sendMessage({ type: 'get-session-stats' }).then(r => {
  if (r?.ok) {
    document.getElementById('statBlocked').textContent = r.blocked;
    document.getElementById('statFlagged').textContent = r.flagged;
  }
}).catch(() => {});

// ---- pipeline self-test ----
document.getElementById('selfTestBtn').addEventListener('click', async () => {
  const out = document.getElementById('selfTestResult');
  out.style.display = 'flex';
  out.textContent = 'running…';
  try {
    let r;
    for (let i = 0; i < 3; i++) {
      r = await chrome.runtime.sendMessage({ type: 'self-test' });
      if (r && Object.keys(r).length > 0) break;
      await new Promise(res => setTimeout(res, 600));
    }
    if (r?.ok) {
      const v = r.verdict;
      const score = v?.detail?.score != null ? v.detail.score.toFixed(3) : '?';
      out.innerHTML = `<span class="badge ${v?.action === 'block' ? 'ok' : 'err'}">${v?.action ?? 'error'}</span> score=${score} (expect block ≥0.9)`;
    } else {
      out.innerHTML = `<span class="badge err">FAILED</span> ${r?.error ?? 'no response'}`;
    }
  } catch (e) {
    out.innerHTML = `<span class="badge err">FAILED</span> ${String(e)}`;
  }
});

// ---- dashboard: reliable open (a plain <a> from a popup dies on blur) ----
document.getElementById('openDash').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- moderation scope (all sites by default; changeable in dashboard) ----
const scopeEl = document.getElementById('scopeState');
chrome.storage.sync.get({ scope: 'all' }).then(({ scope }) => {
  scopeEl.textContent = scope === 'core' ? 'core sites only' : 'all sites';
  scopeEl.className = 'badge ' + (scope === 'core' ? 'off' : 'ok');
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'sync' && ch.scope) {
    scopeEl.textContent = ch.scope.newValue === 'core' ? 'core sites only' : 'all sites';
    scopeEl.className = 'badge ' + (ch.scope.newValue === 'core' ? 'off' : 'ok');
  }
});

