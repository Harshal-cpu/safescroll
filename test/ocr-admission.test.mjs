import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createOcrScheduler, ocrSourceKey } from '../src/offscreen/ocr.js';

const source = readFileSync(new URL('../src/offscreen/ocr.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function runOCRResult(');
const end = source.indexOf('\nexport async function runOCR(', start);
const admission = source.slice(start, end).replace('export async function', 'async function');
function reader(scheduler, fetchBlob) {
  return runInNewContext(`(() => { ${admission}; return runOCRResult; })()`, {
    ocrScheduler: scheduler, ocrSourceKey, ocrBadSources: new Set(), ocrTextCache: new Map(),
    fetchBlob, dataUrlToBlob: fetchBlob, load: async () => {}, ocrDebug() {}, ocrWarn() {},
    scanOCR: async (url, progress, referer, dataUrl, key, prepared) => {
      const outcome = await prepared;
      return outcome.error ? { status: 'error', reason: 'fetch-timeout', text: '' }
        : { status: 'clean', text: outcome.blob };
    }
  });
}

test('queued OCR reserves shared bytes immediately and duplicates do not start another read', async () => {
  const scheduler = createOcrScheduler(3);
  let finishWorker, finishFetch, reads = 0;
  const blocker = scheduler.run('blocker', () => new Promise(resolve => { finishWorker = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const run = reader(scheduler, () => { reads++; return new Promise(resolve => { finishFetch = resolve; }); });
  const first = run('https://example.test/image.jpg');
  const duplicate = run('https://example.test/image.jpg');
  assert.equal(reads, 1); // fetched while queued, not after the blob cache expires
  finishFetch('reserved image bytes');
  await Promise.resolve();
  finishWorker();
  await blocker;
  assert.equal((await first).text, 'reserved image bytes');
  assert.equal((await duplicate).text, 'reserved image bytes');
  assert.equal(reads, 1);
});

test('full OCR queue does not admit an image download', async () => {
  const scheduler = createOcrScheduler(1);
  let complete, reads = 0;
  const blocker = scheduler.run('blocker', () => new Promise(resolve => { complete = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const run = reader(scheduler, async () => { reads++; return 'bytes'; });
  assert.equal((await run('https://example.test/full.jpg')).status, 'deferred');
  assert.equal(reads, 0);
  complete(); await blocker;
});

test('a download that fails while queued is consumed by the same OCR job', async () => {
  const scheduler = createOcrScheduler(2);
  let complete, reads = 0;
  const blocker = scheduler.run('blocker', () => new Promise(resolve => { complete = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const run = reader(scheduler, async () => { reads++; throw new DOMException('deadline', 'TimeoutError'); });
  const pending = run('https://example.test/fail.jpg');
  await new Promise(resolve => setTimeout(resolve, 0));
  complete(); await blocker;
  assert.equal((await pending).status, 'error');
  assert.equal(reads, 1);
});
