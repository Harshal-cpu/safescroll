import { mediaSourceKey } from '../shared/mediaFingerprint.js';

// A media finding still matters when text already has the same severity: the
// content script needs its source to place a separate media shield.
export function refineVerdict(base, parts, siteId, host, settingsPolicy = base?.settingsPolicy) {
  const additions = parts.filter(part => part?.action === 'block' || part?.action === 'flag');
  if (!additions.length) return null;
  const action = base?.action === 'block' || additions.some(part => part.action === 'block')
    ? 'block' : 'flag';
  const reasons = [...(base?.reasons ?? [])];
  for (const part of additions) {
    const reason = { source: part.source || 'image', action: part.action, detail: part.detail || part.reason };
    const index = reasons.findIndex(previous => previous.source === reason.source &&
      (previous.detail?.imageSourceKey ?? previous.detail?.imageUrl) ===
      (reason.detail?.imageSourceKey ?? reason.detail?.imageUrl));
    if (index < 0) reasons.push(reason);
    else if (reasons[index].action !== 'block' || reason.action === 'block') reasons[index] = reason;
  }
  return {
    action,
    siteId,
    host: host ?? null,
    settingsPolicy,
    reasons,
    ts: Date.now()
  };
}

// A recycled post may retain its text key while its photos change. Remove
// findings for photos no longer in that post before fusing new media results.
export function reconcileMediaVerdict(verdict, images) {
  if (!verdict) return null;
  const urls = new Set(images.map(image => image.url).filter(Boolean));
  const sourceKeys = new Set(images.map(mediaSourceKey));
  const mediaSources = new Set(['image', 'ocr-text', 'lexicon-ocr']);
  const reasons = (verdict.reasons ?? []).filter(reason =>
    !mediaSources.has(reason.source) || (reason.detail?.imageSourceKey
      ? sourceKeys.has(reason.detail.imageSourceKey) : urls.has(reason.detail?.imageUrl))
  );
  if (reasons.length === (verdict.reasons ?? []).length) return verdict;
  const action = reasons.some(reason => reason.action === 'block') ? 'block'
    : reasons.some(reason => reason.action === 'flag') ? 'flag' : 'clean';
  return { ...verdict, action, reasons, ts: Date.now() };
}
