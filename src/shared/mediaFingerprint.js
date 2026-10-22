// Keep content, image cache, and OCR identities aligned. Hash captured bytes
// so a same-URL or same-length canvas replacement is scanned again.
export function mediaSourceKey(image) {
  const data = image.dataUrl;
  if (!data) return image.url ?? '';
  let hash = 5381;
  for (let i = 0; i < data.length; i++) hash = ((hash * 33) ^ data.charCodeAt(i)) >>> 0;
  return `${image.url ?? ''}\u0000d:${data.length}:${hash}`;
}

export function mediaFingerprint(images = []) {
  return JSON.stringify(images.slice(0, 3).map(mediaSourceKey).sort());
}
