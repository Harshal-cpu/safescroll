// Shield overlay UI — BLUR EFFECT design with GRANULAR targets:
// the text container and media container of a post are blurred SEPARATELY
// (toxic text blurs only the text; NSFW image blurs only the image).
// States: loading / blocked / flagged. "Show anyway" is PIN-gated in Child
// Mode via meta.overrideGuard.
//
// OPEN-WEB SAFETY RULES added here:
//  * Never attach to <html>, <body> or anything covering the whole viewport —
//    a page-wide blur on a generic site is a denial of service, not moderation.
//  * Refuse targets that are effectively the whole document; fall back to the
//    parent, and if that is also too large, to a corner badge that blurs just
//    the offending text run in place.
//  * Shields are position:absolute inside a position:relative host; we restore
//    the host's original inline position on destroy so we don't mutate the
//    page's own styles permanently.

const MAX_COVERAGE = 0.85; // a shield may not cover more than 85% of the viewport

/**
 * Pick a shield presentation that is guaranteed to fit the target instead of
 * forcing the full four-row card into short X text/media regions.  This is a
 * pure function so the breakpoints remain easy to regression-test.
 */
export function shieldLayoutForSize(width, height) {
  const w = Number.isFinite(Number(width)) ? Math.max(0, Number(width)) : 0;
  const h = Number.isFinite(Number(height)) ? Math.max(0, Number(height)) : 0;
  if (h < 48 || w < 130) return 'tiny';
  if (h < 82 || w < 210) return 'micro';
  if (h < 150 || w < 340) return 'compact';
  return 'full';
}

function viewportArea() {
  return Math.max(1, window.innerWidth * window.innerHeight);
}

/** Fraction of the viewport a fixed-position element would cover. */
function coverage(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return 0;
  // Elements taller than the viewport can only be judged on width.
  const visibleH = Math.min(r.height, window.innerHeight);
  return (r.width * visibleH) / viewportArea();
}

/**
 * Pick the smallest sensible blur host: the element itself, else its parent,
 * else null (meaning "no full overlay, use inline text redaction").
 */
export function resolveHost(el) {
  if (!el || !el.isConnected) return null;
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY' || tag === 'MAIN') return null;
  if (coverage(el) <= MAX_COVERAGE) return el;
  const p = el.parentElement;
  if (p && p.tagName !== 'HTML' && p.tagName !== 'BODY' && coverage(p) <= MAX_COVERAGE) return p;
  return null;
}

function attachShield(host, meta = {}) {
  // An absolutely positioned child of a wrapping inline span uses the span's
  // fragmented containing block, which can cover only part of an IG comment.
  // Render one overlay per line fragment without changing the page's text flow.
  const strongCover = meta.siteId === 'youtube' || meta.siteId === 'instagram';
  const inlineMediaImage = strongCover && meta.target === 'media' &&
    getComputedStyle(host).display === 'inline' ? host.querySelector?.('img') : null;
  const fixedMediaTarget = inlineMediaImage ||
    (strongCover && meta.target === 'media' && host.tagName === 'VIDEO' ? host : null);
  const fixedMediaHost = !!fixedMediaTarget;
  const inlineTextHost = meta.target === 'text' && getComputedStyle(host).display === 'inline';
  const fragments = [];
  let fragmentBlur = 'blur(14px)';
  let fragmentVeil = 'rgba(255,255,255,0.06)';
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
  if (inlineTextHost) Object.assign(shield.style, {
    position: 'fixed', inset: 'auto', top: '0', left: '0', width: '0', height: '0',
    background: 'none', backdropFilter: 'none', WebkitBackdropFilter: 'none',
    pointerEvents: 'none', overflow: 'visible'
  });
  if (fixedMediaHost) Object.assign(shield.style, {
    position: 'fixed', inset: 'auto', top: '0', left: '0', width: '0', height: '0'
  });

  const pill = document.createElement('div');
  Object.assign(pill.style, {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    padding: '12px 18px', borderRadius: '12px', background: 'rgba(10,10,14,0.72)',
    color: '#f2f2f7', font: '13px/1.4 system-ui, sans-serif', textAlign: 'center',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)', maxWidth: 'calc(100% - 16px)',
    maxHeight: 'calc(100% - 8px)', boxSizing: 'border-box', overflow: 'hidden',
    transition: 'padding 120ms ease, gap 120ms ease, border-radius 120ms ease'
  });

  const title = document.createElement('div');
  title.textContent = 'SafeScroll';
  title.style.cssText = 'font-weight:700;font-size:13px;letter-spacing:0.3px;opacity:.85;';

  const status = document.createElement('div');
  status.textContent = 'Checking content…';
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const reason = document.createElement('div');
  reason.style.cssText = 'opacity:0.75;font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;';

  const btnStyle =
    'padding:5px 12px;border:1px solid #777;border-radius:999px;background:transparent;color:#f2f2f7;cursor:pointer;font-size:11px;white-space:nowrap;';

  const overrideBtn = document.createElement('button');
  overrideBtn.type = 'button';
  overrideBtn.setAttribute('aria-label', 'Show content anyway');
  overrideBtn.title = 'Show content anyway';
  overrideBtn.textContent = 'Show anyway';
  overrideBtn.style.cssText = btnStyle;
  overrideBtn.addEventListener('click', async event => {
    // YouTube titles and thumbnails are links. The button may be rendered
    // inside one of them, but revealing content must never open the video.
    event.preventDefault();
    event.stopPropagation();
    overrideBtn.disabled = true;
    overrideBtn.textContent = '…';
    let approved = true;
    if (meta.overrideGuard) approved = await meta.overrideGuard();
    overrideBtn.disabled = false;
    paintCopy();
    // The PIN prompt is a gap of indeterminate length; X may have re-rendered
    // the post in the meantime. Acting on a detached shield would leave the
    // live one covering the content the user just authorised.
    if (!shield.isConnected) return;
    if (approved) {
      shield.hide(true);
    } else {
      status.textContent = '❌ Parent PIN required';
      setTimeout(() => { if (shield.isConnected) paintCopy(); }, 2500);
    }
  });

  btnRow.append(overrideBtn);
  pill.append(title, status, reason, btnRow);
  shield.appendChild(pill);

  let currentVerdict = { action: 'loading', reasons: [] };
  let layoutMode = 'full';
  let layoutFrame = 0;

  function paintCopy() {
    const action = currentVerdict?.action ?? 'clean';
    const full = action === 'block'
      ? '🛑 Toxic content blurred'
      : action === 'flag'
        ? '⚠️ Low-severity content blurred'
        : 'Checking content…';
    const short = action === 'block'
      ? '🛑 Content blurred'
      : action === 'flag'
        ? '⚠️ Content blurred'
        : 'Checking…';
    const micro = action === 'block'
      ? '🛑 Blurred'
      : action === 'flag'
        ? '⚠️ Blurred'
        : 'Checking…';
    const tiny = action === 'block' ? '🛑' : action === 'flag' ? '⚠️' : '…';

    status.textContent = layoutMode === 'full' ? full
      : layoutMode === 'compact' ? short
        : layoutMode === 'micro' ? micro : tiny;
    overrideBtn.textContent = layoutMode === 'full' ? 'Show anyway' : 'Show';
  }

  function applyResponsiveLayout() {
    layoutFrame = 0;
    if (!shield.isConnected) return;
    const rect = fixedMediaTarget?.getBoundingClientRect() ?? host.getBoundingClientRect();
    if (fixedMediaHost) Object.assign(shield.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`
    });
    const hostWidth = rect.width || host.clientWidth;
    const hostHeight = rect.height || host.clientHeight;
    layoutMode = shieldLayoutForSize(hostWidth, hostHeight);
    shield.dataset.layout = layoutMode;

    const loading = currentVerdict?.action === 'loading';
    const full = layoutMode === 'full';
    const compact = layoutMode === 'compact';
    const row = layoutMode === 'micro' || layoutMode === 'tiny';
    const tiny = layoutMode === 'tiny';

    Object.assign(pill.style, {
      flexDirection: row ? 'row' : 'column',
      width: full ? 'auto' : row ? 'auto' : 'calc(100% - 8px)',
      maxWidth: full ? 'calc(100% - 16px)' : compact ? 'calc(100% - 8px)' : 'calc(100% - 4px)',
      padding: full ? '12px 18px' : compact ? '6px 8px' : tiny ? '1px 3px' : '3px 5px',
      gap: full ? '6px' : compact ? '3px' : tiny ? '3px' : '5px',
      borderRadius: full ? '12px' : compact ? '9px' : tiny ? '5px' : '7px',
      fontSize: full ? '13px' : compact ? '12px' : tiny ? '9px' : '11px',
      lineHeight: full ? '1.4' : '1.2'
    });
    title.style.display = full ? 'block' : 'none';
    status.style.display = tiny && hostWidth < 58 ? 'none' : 'block';
    status.style.flex = row ? '1 1 auto' : '0 1 auto';
    reason.style.display = full || compact ? 'block' : 'none';
    reason.style.fontSize = full ? '11px' : '10px';
    reason.style.maxWidth = compact ? '100%' : '320px';
    btnRow.style.display = loading ? 'none' : 'flex';
    btnRow.style.gap = full ? '8px' : compact ? '5px' : '3px';
    btnRow.style.marginTop = full ? '4px' : '0';
    overrideBtn.style.padding = full ? '5px 12px' : compact ? '3px 8px' : tiny ? '1px 4px' : '2px 6px';
    overrideBtn.style.fontSize = full ? '11px' : compact ? '10px' : tiny ? '9px' : '10px';
    overrideBtn.style.lineHeight = tiny ? '1.1' : '1.25';
    overrideBtn.style.minHeight = full ? 'auto' : compact ? '24px' : tiny ? '18px' : '22px';
    overrideBtn.style.flex = '0 0 auto';
    if (inlineTextHost) {
      const rects = [...host.getClientRects()].filter(r => r.width && r.height);
      while (fragments.length < rects.length) {
        const fragment = document.createElement('div');
        fragment.dataset.safescrollFragment = '1';
        Object.assign(fragment.style, {
          position: 'absolute', background: fragmentVeil,
          borderRadius: '4px', pointerEvents: 'auto'
        });
        shield.insertBefore(fragment, pill);
        fragments.push(fragment);
      }
      fragments.forEach((fragment, index) => {
        const r = rects[index];
        fragment.style.display = r ? 'block' : 'none';
        if (!r) return;
        Object.assign(fragment.style, {
          left: `${r.left}px`, top: `${r.top}px`,
          width: `${r.width}px`, height: `${r.height}px`,
          background: fragmentVeil,
          backdropFilter: fragmentBlur, WebkitBackdropFilter: fragmentBlur
        });
      });
      Object.assign(pill.style, {
        position: 'absolute', pointerEvents: 'auto', width: 'auto',
        maxWidth: 'min(320px, calc(100vw - 20px))', maxHeight: 'none',
        left: `${Math.max(10, Math.min(window.innerWidth - 10, rect.left + rect.width / 2))}px`,
        // Keep the control with its text. Clamping an off-screen comment to
        // the viewport edge covers unrelated YouTube cards while it is hidden.
        top: `${rect.top + rect.height / 2}px`,
        transform: 'translate(-50%, -50%)'
      });
    }
    paintCopy();
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(applyResponsiveLayout);
  }

  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleLayout)
    : null;
  if (resizeObserver) resizeObserver.observe(inlineTextHost ? host.parentElement : fixedMediaTarget ?? host);
  if (inlineTextHost || fixedMediaHost || !resizeObserver) window.addEventListener('resize', scheduleLayout, { passive: true });
  if (inlineTextHost || fixedMediaHost) window.addEventListener('scroll', scheduleLayout, { passive: true, capture: true });

  function setBlur(value, veil) {
    fragmentBlur = value;
    fragmentVeil = veil;
    if (!inlineTextHost) {
      shield.style.background = veil;
      shield.style.backdropFilter = value;
      shield.style.WebkitBackdropFilter = value;
    }
  }

  shield.update = verdict => {
    currentVerdict = verdict || { action: 'clean', reasons: [] };
    shield.dataset.verdictAction = verdict?.action ?? 'clean';
    if (!verdict || verdict.action === 'clean') {
      shield.style.display = 'none';
      return;
    }
    if (shield.dataset.userOverrode === '1') {
      shield.style.display = 'none';
      return;
    }
    shield.style.display = 'flex';
    const reasons = (verdict.reasons || []).map(r => `${r.source}: ${r.action}`).join(' · ');
    if (verdict.action === 'block') {
      status.textContent = '🛑 Toxic content blurred';
      reason.textContent = reasons;
      pill.style.background = 'rgba(120,10,10,0.8)';
      setBlur(strongCover ? 'blur(22px)' : 'blur(18px)',
        strongCover ? 'rgba(12,14,18,0.68)' : 'rgba(255,255,255,0.06)');
    } else if (verdict.action === 'flag') {
      status.textContent = '⚠️ Low-severity content blurred';
      reason.textContent = reasons;
      pill.style.background = 'rgba(120,90,10,0.75)';
      setBlur(strongCover ? 'blur(18px)' : 'blur(8px)',
        strongCover ? 'rgba(12,14,18,0.60)' : 'rgba(255,255,255,0.06)');
    } else if (verdict.action === 'loading') {
      reason.textContent = '';
      pill.style.background = 'rgba(10,10,14,0.72)';
      setBlur('blur(6px)', strongCover ? 'rgba(12,14,18,0.26)' : 'rgba(255,255,255,0.06)');
    }
    applyResponsiveLayout();
  };

  shield.hide = userOverride => {
    shield.style.display = 'none';
    if (userOverride) shield.dataset.userOverrode = '1';
  };

  shield.destroy = () => {
    resizeObserver?.disconnect();
    if (inlineTextHost || fixedMediaHost || !resizeObserver) window.removeEventListener('resize', scheduleLayout);
    if (inlineTextHost || fixedMediaHost) window.removeEventListener('scroll', scheduleLayout, true);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    shield.remove();
    // Restore the host's original inline position — never leave our mutation
    // behind on a page we don't own.
    if (host.dataset.safescrollPrevPosition !== undefined) {
      const prev = host.dataset.safescrollPrevPosition;
      if (prev === '') host.style.removeProperty('position');
      else host.style.position = prev;
      delete host.dataset.safescrollPrevPosition;
    }
  };

  if (!inlineTextHost && !fixedMediaHost && getComputedStyle(host).position === 'static') {
    host.dataset.safescrollPrevPosition = host.style.position || '';
    host.style.position = 'relative';
  }
  (inlineTextHost || fixedMediaHost ? document.documentElement : host).appendChild(shield);
  applyResponsiveLayout();
  return shield;
}

// Full-post shield (fallback when no granular target is found).
export function createShield(el, meta = {}) {
  const host = resolveHost(el);
  if (!host) return inlineBadge(el, meta);
  return attachShield(host, { ...meta, target: 'post' });
}

// Granular shield over a specific child container (text block or media block).
export function createBlurShield(targetEl, meta = {}) {
  if (!targetEl) return null;
  const host = resolveHost(targetEl);
  if (!host) return inlineBadge(targetEl, meta);
  return attachShield(host, { ...meta, target: meta.target ?? 'media' });
}

/**
 * Last-resort UI when the target is too large to overlay safely (a 3000-word
 * article body, a full-height sidebar). Instead of blanking the page we insert
 * a compact notice at the top of the offending block. Nothing is hidden — this
 * is a visible warning, not a silent block, which is the honest behaviour when
 * we cannot safely occlude the target.
 */
function inlineBadge(el, meta) {
  if (!el || !el.isConnected) return null;
  const badge = document.createElement('div');
  badge.className = 'safescroll-shield safescroll-inline';
  badge.dataset.safescroll = 'shield';
  badge.dataset.safescrollTarget = meta.target ?? 'post';
  Object.assign(badge.style, {
    display: 'block',
    margin: '6px 0',
    padding: '6px 10px',
    borderRadius: '8px',
    border: '1px solid #7a2020',
    background: 'rgba(120,10,10,0.16)',
    color: '#ffb4ab',
    font: '12px/1.4 system-ui, sans-serif'
  });
  badge.textContent = 'SafeScroll: Checking content…';
  badge.update = verdict => {
    badge.dataset.verdictAction = verdict?.action ?? 'clean';
    const action = verdict?.action ?? 'clean';
    badge.style.display = action === 'clean' ? 'none' : 'block';
    if (action === 'loading') {
      badge.textContent = 'SafeScroll: Checking content…';
      badge.style.borderColor = '#6b7280';
      badge.style.background = 'rgba(10,10,14,0.72)';
      badge.style.color = '#f2f2f7';
    } else {
      badge.textContent = `⚠️ SafeScroll flagged this section (${meta.siteId || 'page'}) — too large to blur safely, so it is marked instead.`;
      badge.style.borderColor = '#7a2020';
      badge.style.background = 'rgba(120,10,10,0.16)';
      badge.style.color = '#ffb4ab';
    }
  };
  badge.hide = () => { badge.style.display = 'none'; };
  badge.destroy = () => badge.remove();
  badge.update(meta.verdict || { action: 'block' });
  el.insertAdjacentElement('afterbegin', badge);
  return badge;
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
