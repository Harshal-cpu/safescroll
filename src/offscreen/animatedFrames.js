import { fetchImageBlob } from './imageSource.js';

const MAX_GIF_BYTES = 12 * 1024 * 1024;

// Decode a few actual animation frames. Browsers normally expose only the
// current (often first) GIF frame through an <img> canvas draw.
export function gifFrameIndexes(count) {
  if (!Number.isInteger(count) || count < 2) return [];
  return [...new Set([0, Math.floor(count / 3), Math.floor(2 * count / 3)])];
}

export async function* decodeGifFrames(url, referer = null) {
  if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported('image/gif'))) return;
  const blob = url.startsWith('data:image/gif') ? await (await fetch(url)).blob()
    : await fetchImageBlob(url, referer);
  if (!blob.size || blob.size > MAX_GIF_BYTES) return;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif' });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
    for (const frameIndex of gifFrameIndexes(count)) {
      const { image } = await decoder.decode({ frameIndex });
      try {
        const scale = Math.min(1, 900 / Math.max(image.displayWidth, image.displayHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.displayWidth * scale));
        canvas.height = Math.max(1, Math.round(image.displayHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        yield { frameIndex, dataUrl: canvas.toDataURL('image/jpeg', 0.86) };
      } finally {
        image.close();
      }
    }
  } finally {
    decoder.close();
  }
}
