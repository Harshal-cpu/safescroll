// Shield overlay UI — BLUR EFFECT design with GRANULAR targets:
// the text container and media container of a post are blurred SEPARATELY
// (toxic text blurs only the text; NSFW image blurs only the image).
// States: loading / blocked / flagged. "Show anyway" is PIN-gated in Child
// Mode via meta.overrideGuard; "Report wrong verdict" feeds the corpus.

function attachShield(host, meta = {}) {
  const shield = document.createElement('div');
  shield.className = 'safescroll-shield';
  shield.dataset.safescroll = 'shield';
  shield.dataset.safescrollTarget = meta.target ?? 'post';
  Object.assign(shield.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '9990',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    background: 'rgba(255,255,255,0.06)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    borderRadius: '8px',
    pointerEvents: 'auto',
    cursor: 'default',
    overflow: 'hidden'
  });

  const pill = document.createElement('div');
  Object.assign(pill.style, {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    padding: '12px 18px', borderRadius: '12px', background: 'rgba(10,10,14,0.72)',
    color: '#f2f2f7', font: '13px/1.4 system-ui, sans-serif', textAlign: 'center',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)', maxWidth: '90%'
  });

  const title = document.createElement('div');
  title.textContent = 'SafeScroll';
  title.style.cssText = 'font-weight:700;font-size:13px;letter-spacing:0.3px;opacity:.85;';

  const status = document.createElement('div');
  status.textContent = 'Checking content…';

  const reason = document.createElement('div');
  reason.style.cssText = 'opacity:0.75;font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;';

  const btnStyle =
    'padding:5px 12px;border:1px solid #777;border-radius:999px;background:transparent;color:#f2f2f7;cursor:pointer;font-size:11px;white-space:nowrap;';

  const overrideBtn = document.createElement('button');
  overrideBtn.textContent = 'Show anyway';
  overrideBtn.style.cssText = btnStyle;
  overrideBtn.addEventListener('click', async () => {
    overrideBtn.disabled = true;
    overrideBtn.textContent = '…';
    let approved = true;
    if (meta.overrideGuard) approved = await meta.overrideGuard();
    overrideBtn.disabled = false;
    overrideBtn.textContent = 'Show anyway';
    if (approved) {
      shield.hide(true);
    } else {
      status.textContent = '❌ Parent PIN required';
      setTimeout(() => { status.textContent = '🛑 Blocked'; }, 2500);
    }
  });

  const reportBtn = document.createElement('button');
  reportBtn.textContent = 'Report wrong verdict';
  reportBtn.style.cssText = btnStyle;
  reportBtn.addEventListener('click', () => {
    import('./bridge.js').then(({ reportFeedback }) =>
      reportFeedback({ key: meta.key, verdictAction: shield.dataset.verdictAction, expectedAction: 'clean', siteId: meta.siteId })
    );
    reportBtn.textContent = 'Reported ✓';
    reportBtn.disabled = true;
  });

  btnRow.append(overrideBtn, reportBtn);
  pill.append(title, status, reason, btnRow);
  shield.append(pill);

  shield.update = verdict => {
    shield.dataset.verdictAction = verdict?.action ?? 'clean';
    if (!verdict || verdict.action === 'clean') {
      shield.style.display = 'none';
      return;
    }
    shield.style.display = 'flex';
    const reasons = (verdict.reasons || []).map(r => `${r.source}: ${r.action}`).join(' · ');
    if (verdict.action === 'block') {
      status.textContent = '🛑 Toxic content blurred';
      reason.textContent = reasons;
      pill.style.background = 'rgba(120,10,10,0.8)';
      shield.style.backdropFilter = 'blur(18px)';
      shield.style.WebkitBackdropFilter = 'blur(18px)';
    } else if (verdict.action === 'flag') {
      status.textContent = '⚠️ Low-severity content blurred';
      reason.textContent = reasons;
      pill.style.background = 'rgba(120,90,10,0.75)';
      shield.style.backdropFilter = 'blur(8px)';
      shield.style.WebkitBackdropFilter = 'blur(8px)';
    } else if (verdict.action === 'loading') {
      status.textContent = 'Checking content…';
      reason.textContent = '';
      pill.style.background = 'rgba(10,10,14,0.72)';
      shield.style.backdropFilter = 'blur(6px)';
      shield.style.WebkitBackdropFilter = 'blur(6px)';
    }
  };

  shield.hide = userOverride => {
    shield.style.display = 'none';
    if (userOverride) shield.dataset.userOverrode = '1';
  };

  shield.destroy = () => shield.remove();

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(shield);
  return shield;
}

// Full-post shield (fallback when no granular target is found).
export function createShield(el, meta = {}) {
  return attachShield(el, { ...meta, target: 'post' });
}

// Granular shield over a specific child container (text block or media block).
export function createBlurShield(targetEl, meta = {}) {
  if (!targetEl) return null;
  return attachShield(targetEl, { ...meta, target: meta.target ?? 'media' });
}

// First-run "model loading" banner.
export function showLoadingBanner() {
  if (document.getElementById('safescroll-loading-banner')) return;
  const b = document.createElement('div');
  b.id = 'safescroll-loading-banner';
  b.textContent = 'SafeScroll: preparing on-device models…';
  Object.assign(b.style, {
    position: 'fixed', bottom: '12px', left: '12px', zIndex: '99999',
    background: 'rgba(20,20,30,0.92)', color: '#fff', padding: '8px 14px',
    borderRadius: '8px', font: '12px system-ui, sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.4)'
  });
  document.documentElement.appendChild(b);
}

export function hideLoadingBanner() {
  document.getElementById('safescroll-loading-banner')?.remove();
}
