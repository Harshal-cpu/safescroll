import { MSG } from '../shared/messages.js';

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
    setTimeout(() => renderStats(), 2500);
  }
}
renderStats();

// ---------------------------------------------- recent verdicts
async function renderRecent() {
  const tbody = document.querySelector('#recentVerdicts tbody');
  tbody.textContent = '';
  try {
    const resp = await viaOffscreen({ type: 'get-recent-verdicts' });
    if (!resp?.ok) throw new Error(resp?.error ?? 'unavailable');
    if (!resp.rows.length) {
      tbody.innerHTML = '<tr><td>No verdicts yet.</td></tr>';
      return;
    }
    for (const row of resp.rows) {
      const tr = document.createElement('tr');
      const time = new Date(row.ts).toLocaleTimeString();
      const action = row.verdict?.action ?? '?';
      const sources = (row.verdict?.reasons ?? []).map(r => r.source).join(', ') || '—';
      const td1 = document.createElement('td'); td1.textContent = time;
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
    setTimeout(() => renderRecent(), 2500);
  }
}
renderRecent();

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
      tr.append(td(m.tier), td(m.model), td(m.params), td(`${m.sizeMB} MB`), td(m.source), state);
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6">Model info unavailable: ${String(e)}</td></tr>`;
  }
}
renderModelInfo();

// ---------------------------------------------- text tester
document.getElementById('testBtn').addEventListener('click', async () => {
  const out = document.getElementById('testResult');
  const text = document.getElementById('testText').value.trim();
  if (!text) return;
  out.innerHTML = '<span class="badge warn">classifying…</span>';
  try {
    const resp = await viaOffscreen({ type: 'test-text', text });
    if (!resp?.ok) throw new Error(resp?.error ?? 'failed');
    const v = resp.verdict;
    const score = v?.detail?.score != null ? v.detail.score.toFixed(3) : '?';
    const cls = v?.action === 'block' ? 'err' : v?.action === 'flag' ? 'warn' : 'ok';
    const lex = resp.lexicon ? ` · lexicon: ${resp.lexicon.action}` : '';
    out.innerHTML = `<span class="badge ${cls}">${v?.action}</span> score=${score} (block≥0.9, flag≥0.5)${lex}`;
  } catch (e) {
    out.innerHTML = `<span class="badge err">error</span> ${String(e)}`;
  }
});

// ---------------------------------------------- thresholds from LIVE PROFILES
async function renderThresholds() {
  const tbody = document.querySelector('#thresholds tbody');
  tbody.textContent = '';
  try {
    const resp = await viaOffscreen({ type: MSG.GET_PROFILES });
    if (!resp?.profiles) throw new Error(resp?.error ?? 'no profiles');
    flatten(resp.profiles, '').forEach(([path, value]) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = path;
      const td2 = document.createElement('td'); td2.textContent = value;
      tr.append(td1, td2);
      tbody.appendChild(tr);
    });
  } catch (e) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="3">Failed to load live profiles: ${String(e)}</td>`;
    tbody.appendChild(tr);
    console.error('[SafeScroll options]', e);
  }
}

function flatten(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, path));
    else out.push([path, String(v)]);
  }
  return out;
}
renderThresholds();

// ------------------------------------------------------------------ scope
const scopeEl = document.getElementById('scope');
chrome.storage.sync.get({ scope: 'all' }).then(({ scope }) => { scopeEl.value = scope; });
scopeEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ scope: scopeEl.value });
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
  document.getElementById('childState').innerHTML = childMode?.enabled && childMode?.pinHash
    ? 'State: <strong style="color:#7ee787">ACTIVE</strong> — overrides require the parent PIN.'
    : 'State: <strong>off</strong> — set a PIN to activate.';
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

// ------------------------------------------------------------------ export buttons
function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('exportJson').addEventListener('click', async () => {
  const r = await viaOffscreen({ type: MSG.EXPORT_FEEDBACK, format: 'json' });
  if (r?.content) download(r.content, r.filename, r.mime);
});
document.getElementById('exportCsv').addEventListener('click', async () => {
  const r = await viaOffscreen({ type: MSG.EXPORT_FEEDBACK, format: 'csv' });
  if (r?.content) download(r.content, r.filename, r.mime);
});
