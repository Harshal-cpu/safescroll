// Child-mode page lock: scroll lock + PIN gate.
// - Scroll Lock setting (chrome.storage.sync 'scrollLock'): when Child Mode is
//   active and a post is BLOCKED, page scrolling freezes under a lock screen
//   until the parent enters the PIN.
// - Parent PIN gate: in Child Mode, shield overrides ("Show anyway") require
//   the PIN. Wrong PIN = denied.
// PIN storage: UNSALTED single-round SHA-256 of a 4-digit PIN — documented,
// accepted limitation for this project's scope (deters casual tampering only).
//
// NON-HTTPS FIX: crypto.subtle only exists in a secure context, so on any
// plain http:// site the previous implementation THREW inside the PIN handler
// and the override silently behaved as if no PIN were set. A pure-JS SHA-256
// fallback keeps the gate working (identically) on every page.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

/** Pure-JS SHA-256, hex output. Used when crypto.subtle is unavailable. */
export function sha256hexSync(text) {
  const bytes = new TextEncoder().encode(String(text));
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296), false);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('');
}

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** Async wrapper that prefers the platform primitive and falls back safely. */
export async function sha256hex(text) {
  try {
    if (globalThis.crypto?.subtle) {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
      return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through to the JS implementation */ }
  return sha256hexSync(text);
}

export async function getSettings() {
  const { scrollLock = false, childMode = {} } = await chrome.storage.sync.get({
    scrollLock: false, childMode: {}
  });
  return { scrollLock, childMode };
}

let lockOverlay = null;

export function isScrollLocked() {
  return !!lockOverlay;
}

// Freeze scrolling while the lock overlay is up.
function freezeScroll() {
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}
function unfreezeScroll() {
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
}

export async function lockIfConfigured(reason = 'Blocked content detected') {
  const { scrollLock, childMode } = await getSettings();
  if (!scrollLock || !childMode?.enabled || !childMode?.pinHash) return false;
  if (lockOverlay) return true; // already locked

  lockOverlay = document.createElement('div');
  lockOverlay.id = 'safescroll-lock';
  Object.assign(lockOverlay.style, {
    position: 'fixed', inset: '0', zIndex: '999999',
    background: 'rgba(8,8,14,0.97)', color: '#f2f2f7',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    font: '15px/1.6 system-ui, sans-serif', textAlign: 'center', gap: '10px'
  });

  const title = document.createElement('div');
  title.textContent = '🔒 Screen locked by SafeScroll';
  title.style.cssText = 'font-size:20px;font-weight:700;';

  const sub = document.createElement('div');
  sub.textContent = `${reason}. Parent PIN required to unlock.`;
  sub.style.cssText = 'opacity:.8;font-size:13px;max-width:420px;';

  const input = document.createElement('input');
  input.type = 'password';
  input.inputMode = 'numeric';
  input.maxLength = 4;
  input.placeholder = '4-digit PIN';
  Object.assign(input.style, {
    width: '120px', padding: '10px', fontSize: '18px', textAlign: 'center',
    letterSpacing: '8px', borderRadius: '8px', border: '1px solid #555',
    background: '#1d1d29', color: '#f2f2f7', outline: 'none'
  });

  const msg = document.createElement('div');
  msg.style.cssText = 'font-size:12px;color:#ff7b72;min-height:16px;';

  const btn = document.createElement('button');
  btn.textContent = 'Unlock';
  Object.assign(btn.style, {
    padding: '10px 24px', borderRadius: '8px', border: '0',
    background: '#2ea043', color: '#fff', fontSize: '14px', cursor: 'pointer'
  });

  async function tryUnlock() {
    const hash = await sha256hex(input.value);
    if (hash === childMode.pinHash) {
      unlock();
    } else {
      msg.textContent = 'Wrong PIN.';
      input.value = '';
      input.focus();
    }
  }
  btn.addEventListener('click', tryUnlock);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });

  lockOverlay.append(title, sub, input, btn, msg);
  document.documentElement.appendChild(lockOverlay);
  freezeScroll();
  setTimeout(() => input.focus(), 50);
  console.warn('[SafeScroll] SCROLL LOCK engaged (child mode):', reason);
  return true;
}

export function unlock() {
  lockOverlay?.remove();
  lockOverlay = null;
  unfreezeScroll();
  console.log('[SafeScroll] scroll lock released (PIN accepted)');
}
