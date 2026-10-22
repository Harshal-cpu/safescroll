// OCR and image models read the same source. Share transport, not mutable
// ImageBitmaps: each consumer decodes and closes its own bitmap.
const MAX_BYTES = 12 * 1024 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRIES = 8;
const CACHE_TTL_MS = 10_000;
const MAX_PENDING = 16;
const MAX_ACTIVE = 4;

function sourceError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

export function imageSourceFailure(error) {
  return error?.name === 'TimeoutError' ? 'fetch-timeout'
    : error?.name === 'AbortError' ? 'fetch-aborted'
    : error?.reason ?? 'fetch-network';
}

export function createImageSourceReader(fetchImage = (...args) => fetch(...args)) {
  const pending = new Map();
  const cache = new Map();
  let cacheBytes = 0;
  let active = 0;
  const queue = [];
  function remove(key) {
    cacheBytes -= cache.get(key).blob.size;
    cache.delete(key);
  }
  function prune() {
    for (const [key, entry] of cache) if (entry.expires <= Date.now()) remove(key);
  }
  async function download(url, referer, { budgetMs = 2500, attemptMs = 1200 } = {}) {
    const deadline = Date.now() + budgetMs;
    let lastError;
    // no-cors returns an unreadable opaque body and cannot supply OCR pixels.
    for (const credentials of ['omit', 'include']) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(
        new DOMException('image download attempt timed out', 'TimeoutError')
      ), Math.min(attemptMs, remaining));
      try {
        const response = await fetchImage(url, {
          credentials, referrer: referer || undefined, mode: 'cors', signal: controller.signal
        });
        if (response.type === 'opaque') throw sourceError('fetch-opaque');
        if (!response.ok) throw sourceError('fetch-http');
        const type = response.headers.get('content-type') || '';
        if (type && !type.startsWith('image/') && !type.includes('octet-stream')) throw sourceError('fetch-type');
        const blob = await response.blob();
        if (!blob.size || blob.size > MAX_BYTES) throw sourceError('fetch-size');
        return blob;
      } catch (error) {
        lastError = controller.signal.aborted ? controller.signal.reason : error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? sourceError('fetch-unavailable');
  }
  function drain() {
    while (active < MAX_ACTIVE && queue.length) {
      const { url, referer, options, resolve, reject } = queue.shift();
      active++;
      // The fetch deadline starts when a slot opens, not while waiting in line.
      download(url, referer, options)
        .then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return {
    stats: () => ({ pending: pending.size, cached: cache.size, bytes: cacheBytes }),
    read(url, referer = null, options) {
      prune();
      const key = `${url}\u0000${referer ?? ''}`;
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit.blob);
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= MAX_PENDING) return Promise.reject(sourceError('fetch-capacity'));
      const downloadResult = new Promise((resolve, reject) => {
        queue.push({ url, referer, options, resolve, reject });
        drain();
      });
      const result = downloadResult.then(blob => {
        while (cache.size >= CACHE_ENTRIES || cacheBytes + blob.size > CACHE_BYTES) {
          remove(cache.keys().next().value);
        }
        cache.set(key, { blob, expires: Date.now() + CACHE_TTL_MS });
        cacheBytes += blob.size;
        return blob;
      }).finally(() => pending.delete(key));
      pending.set(key, result);
      return result;
    }
  };
}

const reader = createImageSourceReader();
export const fetchImageBlob = (url, referer, options) => reader.read(url, referer, options);
