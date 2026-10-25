import { MSG } from '../shared/messages.js';
import { MODERATION_DEFAULTS } from '../shared/moderationSettings.js';

const viaOffscreen = async (msg, retries = 2) => {
  // route through background (guarantees offscreen is running first);
  // retry once or twice to win the cold-start responder race
  for (let i = 0; i <= retries; i++) {
    const r = await chrome.runtime.sendMessage(msg);
    if (r && Object.keys(r).length > 0) return r;
    await new Promise(res => setTimeout(res, 600));
  }
  return undefined;
};

// ---------------------------------------------- statistics
async function renderStats() {

  try {
    const resp = await viaOffscreen({ type: 'get-session-stats' });
    if (!resp?.ok) throw new Error(resp?.error ?? 'unavailable');
    document.getElementById('statBlocked').textContent = resp.blocked;
    document.getElementById('statFlagged').textContent = resp.flagged;
    document.getElementById('statClean').textContent = resp.clean;
    document.getElementById('statTotal').textContent = resp.total;

    const tbody = document.querySelector('#statsBySource tbody');
    tbody.textContent = '';
    const entries = Object.entries(resp.bySource ?? {});
    if (!entries.length) {
      tbody.innerHTML = '<tr><td>No verdicts yet — open a feed and let it classify.</td></tr>';
      return;
    }
    for (const [k, v] of entries) {
      const [source, action] = k.split(':');
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = `via ${source}`;
      const td2 = document.createElement('td'); td2.textContent = action;
      const td3 = document.createElement('td'); td3.textContent = v;
      tr.append(td1, td2, td3);
      tbody.appendChild(tr);
    }
  } catch (e) {
    console.error('[SafeScroll options] stats:', e);
    document.getElementById('statTotal').textContent = 'unavailable';
    // cold-start race: offscreen IndexedDB may not be ready — retry shortly
    setTimeout(refreshActivity, 2500);
  }
}

// ---------------------------------------------- recent verdicts
const activityClock = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
});
async function renderRecent() {
  const tbody = document.querySelector('#recentVerdicts tbody');
  try {
    const resp = await viaOffscreen({ type: 'get-recent-verdicts' });
    if (!resp?.ok) throw new Error(resp?.error ?? 'unavailable');
    tbody.textContent = '';
    if (!resp.rows.length) {
      tbody.innerHTML = '<tr><td>No verdicts yet.</td></tr>';
      return;
    }
    for (const row of resp.rows) {
      const tr = document.createElement('tr');
      const occurredAt = new Date(row.ts);
      const time = activityClock.format(occurredAt);
      const action = row.verdict?.action ?? '?';
      const sources = (row.verdict?.reasons ?? []).map(r => r.source).join(', ') || '—';
      const td1 = document.createElement('td'); td1.textContent = time;
      td1.title = occurredAt.toString();
      const td2 = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge ' + (action === 'block' ? 'err' : action === 'flag' ? 'warn' : 'ok');
      badge.textContent = action;
      td2.appendChild(badge);
      const td3 = document.createElement('td'); td3.textContent = sources;
      tr.append(td1, td2, td3);
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td>History unavailable: ${String(e)} — retrying…</td></tr>`;
    setTimeout(refreshActivity, 2500);
  }
}

let activityRefreshRunning = false;
let activityRefreshQueued = false;
async function refreshActivity() {
  if (activityRefreshRunning) {
    activityRefreshQueued = true;
    return;
  }
  activityRefreshRunning = true;
  do {
    activityRefreshQueued = false;
    await renderRecent();
    await renderStats();
  } while (activityRefreshQueued);
  activityRefreshRunning = false;
}
refreshActivity();
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === MSG.VERDICTS_UPDATED) refreshActivity();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshActivity();
});

// ---------------------------------------------- model information
async function renderModelInfo() {
  const tbody = document.querySelector('#modelInfo tbody');
  tbody.textContent = '';
  try {
    const resp = await viaOffscreen({ type: 'get-model-info' });
    if (!resp?.ok) throw new Error(resp?.error ?? 'unavailable');
    for (const m of resp.tiers) {
      const tr = document.createElement('tr');
      const td = v => { const t = document.createElement('td'); t.textContent = v; return t; };
      const state = document.createElement('span');
      state.className = 'badge ' + (m.loadState === 'ready' ? 'ok' : m.loadState === 'failed' ? 'err' : 'warn');
      state.textContent = m.loadState;
      const stateCell = document.createElement('td');
      stateCell.appendChild(state);
      tr.append(td(m.tier), td(m.model), td(m.params), td(`${m.sizeMB} MB`), td(m.source), stateCell);
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6">Model info unavailable: ${String(e)}</td></tr>`;
  }
}
renderModelInfo();

// ----------------------------------------------------------- master protection
const enabledDashboardEl = document.getElementById('enabledDashboard');
chrome.storage.sync.get({ enabled: true }).then(({ enabled }) => {
  enabledDashboardEl.checked = enabled;
});
enabledDashboardEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ enabled: enabledDashboardEl.checked });
});

// ------------------------------------------------------------------ scope
const scopeEl = document.getElementById('scope');
chrome.storage.sync.get({ scope: 'all' }).then(({ scope }) => { scopeEl.value = scope; });
scopeEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ scope: scopeEl.value });
});

// ------------------------------------------------------------- paused sites
// Mirrors content/sitecontrol.js. Options page cannot message every tab, so it
// reads/writes storage directly; the content script reacts via onChanged.
async function renderPausedSites() {
  const tbody = document.querySelector('#pausedSites tbody');
  const { pausedHosts = [] } = await chrome.storage.sync.get({ pausedHosts: [] });
  tbody.textContent = '';
  const hosts = Array.isArray(pausedHosts) ? pausedHosts : [];
  document.getElementById('pausedEmpty').style.display = hosts.length ? 'none' : 'block';
  for (const host of hosts) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = host;
    const td2 = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'button danger';
    btn.textContent = 'Resume';
    btn.addEventListener('click', async () => {
      const { pausedHosts: cur = [] } = await chrome.storage.sync.get({ pausedHosts: [] });
      await chrome.storage.sync.set({ pausedHosts: cur.filter(h => h !== host) });
      renderPausedSites();
    });
    td2.appendChild(btn);
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
}
renderPausedSites();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.pausedHosts) renderPausedSites();
  if (changes.enabled) enabledDashboardEl.checked = !!changes.enabled.newValue;
});

// ------------------------------------------------------------------ Scroll Lock
const scrollLockEl = document.getElementById('scrollLock');
chrome.storage.sync.get({ scrollLock: false }).then(({ scrollLock }) => { scrollLockEl.checked = scrollLock; });
scrollLockEl.addEventListener('change', async () => {
  if (scrollLockEl.checked && !confirm('Scroll Lock works with Child Lock: when enabled AND Child Lock is on, a blocked post freezes the whole page until the parent PIN is entered. Enable?')) {
    scrollLockEl.checked = false;
    return;
  }
  await chrome.storage.sync.set({ scrollLock: scrollLockEl.checked });
});

// ------------------------------------------------------------------ Child Lock
async function renderChildState() {
  const { childMode } = await chrome.storage.sync.get({ childMode: {} });
  const state = document.getElementById('childState');
  const active = !!(childMode?.enabled && childMode?.pinHash);
  state.textContent = active ? 'Active' : 'Off';
  state.className = `status-text${active ? ' active' : ''}`;
}
renderChildState();

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

document.getElementById('setPin').addEventListener('click', async () => {
  const pin = document.getElementById('pin').value;
  if (!/^\d{4}$/.test(pin)) return alert('PIN must be exactly 4 digits');
  const { childMode } = await chrome.storage.sync.get({ childMode: {} });
  const pinHash = await sha256hex(pin);
  await chrome.storage.sync.set({ childMode: { ...childMode, enabled: true, pinHash } });
  document.getElementById('pin').value = '';
  renderChildState();
  alert('Child Lock enabled. Overrides and Scroll Lock now require this PIN. (Unsalted single-round SHA-256 — see documented limitation below.)');
});

document.getElementById('clearPin').addEventListener('click', async () => {
  const { childMode } = await chrome.storage.sync.get({ childMode: {} });
  const pin = prompt('Enter current PIN to disable Child Lock:');
  if (childMode?.pinHash && (await sha256hex(pin ?? '')) !== childMode.pinHash) {
    return alert('Wrong PIN.');
  }
  await chrome.storage.sync.set({ childMode: { enabled: false, pinHash: null } });
  renderChildState();
  alert('Child Lock disabled.');
});

const blockMildEl = document.getElementById('blockMild');
chrome.storage.sync.get({ childMode: {} }).then(({ childMode }) => {
  blockMildEl.checked = !!childMode?.blockMild;
});
blockMildEl.addEventListener('change', async () => {
  const { childMode } = await chrome.storage.sync.get({ childMode: {} });
  await chrome.storage.sync.set({ childMode: { ...childMode, blockMild: blockMildEl.checked } });
});

// ------------------------------------------------------------ performance toggles
// The background relays these stored settings to the offscreen document.
for (const [id, key, dflt] of [
  ['ocrEnabled', 'ocrEnabled', MODERATION_DEFAULTS.ocrEnabled],
  ['imageEnabled', 'imageEnabled', MODERATION_DEFAULTS.imageEnabled]
]) {
  const el = document.getElementById(id);
  chrome.storage.sync.get({ [key]: dflt }).then(v => { el.checked = !!v[key]; });
  el.addEventListener('change', async () => {
    await chrome.storage.sync.set({ [key]: el.checked });
  });
}

// ------------------------------------------------------------ clear cache
document.getElementById('clearCache').addEventListener('click', async () => {
  const out = document.getElementById('clearCacheResult');
  out.textContent = 'clearing…';
  try {
    const r = await viaOffscreen({ type: MSG.CLEAR_VERDICT_CACHE });
    out.textContent = r?.ok ? 'Cache cleared.' : `Failed: ${r?.error ?? 'no response'}`;
    if (r?.ok) refreshActivity();
  } catch (e) {
    out.textContent = `Failed: ${e}`;
  }
});
