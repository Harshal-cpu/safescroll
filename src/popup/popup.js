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
    stateEl.className = 'status-pill error';
    stateEl.title = r.modelsError;
    console.error('[SafeScroll] model load failed:', r.modelsError);
  } else if (r?.modelsReady) {
    stateEl.textContent = 'ready';
    stateEl.className = 'status-pill success';
  } else if (r?.stageState) {
    const stages = Object.entries(r.stageState).map(([k, v]) => `${k}:${v}`).join(' ');
    stateEl.textContent = r.loadStarted ? stages : 'not started';
    stateEl.className = 'status-pill neutral';
    stateEl.title = r.modelsError ?? '';
  } else {
    stateEl.textContent = 'loading…';
    stateEl.className = 'status-pill warning';
  }
}

function pollStatus() {
  chrome.runtime.sendMessage({ type: MSG.STATUS }).then(renderModelState).catch(() => {
    stateEl.textContent = 'bg error';
    stateEl.className = 'status-pill error';
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
  const button = document.getElementById('selfTestBtn');
  out.hidden = false;
  out.textContent = 'running…';
  button.disabled = true;
  button.textContent = 'Running…';
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
  } finally {
    button.disabled = false;
    button.textContent = 'Run test';
  }
});

// ---- dashboard: reliable open (a plain <a> from a popup dies on blur) ----
document.getElementById('openDash').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- moderation scope (all sites by default; changeable in dashboard) ----
const scopeEl = document.getElementById('scopeState');
chrome.storage.sync.get({ scope: 'all' }).then(({ scope }) => {
  scopeEl.textContent = scope === 'core' ? 'core sites only' : 'all sites';
  scopeEl.className = 'status-pill ' + (scope === 'core' ? 'neutral' : 'success');
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'sync' && ch.scope) {
    scopeEl.textContent = ch.scope.newValue === 'core' ? 'core sites only' : 'all sites';
    scopeEl.className = 'status-pill ' + (ch.scope.newValue === 'core' ? 'neutral' : 'success');
  }
});

// ---- per-site pause ------------------------------------------------------
// The content script owns this logic; the popup asks the active tab's content
// script so there is exactly one implementation of host matching.
const siteHostEl = document.getElementById('siteHost');
const pauseBtn = document.getElementById('pauseSite');
const siteStatsEl = document.getElementById('siteStats');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(toggle = false) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error('no active tab');
  return chrome.tabs.sendMessage(tab.id, { type: 'safescroll:ping', toggle }, { frameId: 0 });
}

function renderSite(state) {
  if (!state) {
    siteHostEl.textContent = 'not available here';
    pauseBtn.disabled = true;
    siteStatsEl.textContent = 'SafeScroll does not run on this page (browser or extension page).';
    return;
  }
  siteHostEl.textContent = state.host;
  pauseBtn.disabled = false;
  pauseBtn.textContent = state.paused ? 'Resume here' : 'Pause here';
  pauseBtn.className = `button ${state.paused ? 'primary' : 'danger'}`;
  const s = state.stats;
  siteStatsEl.textContent =
    `On this page: ${s.units} tracked, ${s.cached} verdicts cached, ${s.queued} queued. ` +
    'All inference is on-device — no user data leaves the browser.';
}

async function refreshSite() {
  try {
    const resp = await sendToTab();
    renderSite(resp?.state ?? null);
  } catch {
    renderSite(null);
  }
}

pauseBtn.addEventListener('click', async () => {
  try {
    const resp = await sendToTab(true);
    if (resp?.toggled) renderSite(resp.state);
  } catch {
    renderSite(null);
  }
});

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (tab?.url) {
    try { siteHostEl.textContent = new URL(tab.url).hostname; } catch { /* opaque URL */ }
  }
  refreshSite();
});
