import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
const start = source.indexOf('async function runMediaTiers(');
const end = source.indexOf('\nasync function moderateOcrResult(', start);
assert.ok(start >= 0 && end > start, 'media tier source boundary exists');
const runSource = source.slice(start, end);

test('an unsafe image publishes before another image finishes classifying', async () => {
  let finishSlow;
  const slow = new Promise(resolve => { finishSlow = resolve; });
  let finishCache;
  const cacheWrite = new Promise(resolve => { finishCache = resolve; });
  const published = [];
  const context = {
    runtime: { imageEnabled: true, ocrEnabled: false },
    ocrSourceKey: url => url,
    getOcrQueueState: () => ({ active: 0, queued: 0, capacity: 12 }),
    getOcrQueuePosition: () => 0,
    mediaSourceKey: image => image.url,
    getImageVerdict: async () => null,
    putImageVerdict: () => cacheWrite,
    isCacheableImageVerdict: () => true,
    classifyImage: url => url.endsWith('slow.jpg') ? slow : Promise.resolve({ action: 'block', source: 'image' }),
    moderateOcrResult: async () => ({ ocrVerdict: null, ocrStatus: 'skipped' }),
    OCR_WAIT_MS: 6000, setTimeout, clearTimeout, log() {}, console
  };
  const run = runInNewContext(`(() => { ${runSource}; return runMediaTiers; })()`, context);
  const images = [{ url: 'https://example.test/unsafe.jpg' }, { url: 'https://example.test/slow.jpg' }];
  const work = run(images, null, { action: 'clean' }, null, verdict => {
    published.push(verdict.detail.imageUrl);
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(published, [images[0].url]);
  } finally {
    finishCache();
    finishSlow({ action: 'clean', source: 'image' });
    await work;
  }
});
