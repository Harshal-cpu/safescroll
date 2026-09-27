// Child-mode page lock: scroll lock + PIN gate.
// - Scroll Lock setting (chrome.storage.sync 'scrollLock'): when Child Mode is
//   active and a post is BLOCKED, page scrolling freezes under a lock screen
//   until the parent enters the PIN.
// - Parent PIN gate: in Child Mode, shield overrides ("Show anyway") require
//   the PIN. Wrong PIN = denied.
// PIN storage: UNSALTED single-round SHA-256 of a 4-digit PIN — documented,
// accepted limitation for this project's scope (deters casual tampering only).

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
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
