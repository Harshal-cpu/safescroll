import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageSourceReader, imageSourceFailure } from '../src/offscreen/imageSource.js';

const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0])], { type: 'image/jpeg' });
const response = (blob = image) => ({ ok: true, type: 'basic', headers: new Headers({ 'content-type': 'image/jpeg' }), blob: async () => blob });

test('OCR and image consumers share pending and recently completed image bytes', async () => {
  let requests = 0, complete;
  const reader = createImageSourceReader(() => {
    requests++;
    return new Promise(resolve => { complete = resolve; });
  });
  const first = reader.read('https://example.test/image.jpg', 'https://example.test/feed');
  const second = reader.read('https://example.test/image.jpg', 'https://example.test/feed');
  assert.strictEqual(second, first);
  assert.equal(requests, 1);
  complete(response());
  assert.strictEqual(await first, image);
  assert.strictEqual(await reader.read('https://example.test/image.jpg', 'https://example.test/feed'), image);
  assert.equal(requests, 1);
  assert.deepEqual(reader.stats(), { pending: 0, cached: 1, bytes: image.size });
});

test('failed image downloads are cleaned up and never cached as successful reads', async () => {
  let fail = true, requests = 0;
  const reader = createImageSourceReader(async () => {
    requests++;
    if (fail) throw new TypeError('network unavailable');
    return response();
  });
  await assert.rejects(reader.read('https://example.test/fail.jpg'));
  assert.deepEqual(reader.stats(), { pending: 0, cached: 0, bytes: 0 });
  fail = false;
  assert.strictEqual(await reader.read('https://example.test/fail.jpg'), image);
  assert.equal(requests, 3); // two bounded credential attempts, then one successful retry
});

test('image fetch deadlines provide an explicit timeout reason and only readable CORS requests', async () => {
  const attempts = [];
  const reader = createImageSourceReader((url, options) => {
    attempts.push(options);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  await assert.rejects(reader.read('https://example.test/slow.jpg', null, { budgetMs: 100, attemptMs: 5 }), error => {
    assert.equal(error.name, 'TimeoutError');
    assert.equal(imageSourceFailure(error), 'fetch-timeout');
    return true;
  });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(a => a.credentials), ['omit', 'include']);
  assert.ok(attempts.every(a => a.mode === 'cors' && a.signal.reason.name === 'TimeoutError'));
  assert.equal(reader.stats().pending, 0);
});

test('unreadable or non-image responses are rejected before either decoder', async () => {
  for (const invalid of [
    { ...response(), type: 'opaque' },
    { ...response(), ok: false },
    { ...response(), headers: new Headers({ 'content-type': 'text/html' }) },
    response(new Blob([]))
  ]) {
    const reader = createImageSourceReader(async () => invalid);
    await assert.rejects(reader.read('https://example.test/invalid'), error => imageSourceFailure(error).startsWith('fetch-'));
    assert.equal(reader.stats().cached, 0);
  }
});

test('image byte cache and pending requests stay bounded', async () => {
  const reader = createImageSourceReader(async () => response());
  for (let i = 0; i < 10; i++) await reader.read(`https://example.test/${i}.jpg`);
  assert.equal(reader.stats().cached, 8);
  const large = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/jpeg' });
  const byteReader = createImageSourceReader(async () => response(large));
  await byteReader.read('https://example.test/a.jpg');
  await byteReader.read('https://example.test/b.jpg');
  assert.equal(byteReader.stats().cached, 1);
  assert.equal(byteReader.stats().bytes, large.size);

  const bounded = createImageSourceReader(() => new Promise(resolve => setTimeout(() => resolve(response()), 5)));
  const reads = Array.from({ length: 16 }, (_, i) => bounded.read(`https://example.test/pending-${i}.jpg`));
  await assert.rejects(bounded.read('https://example.test/overflow.jpg'), error => error.reason === 'fetch-capacity');
  await Promise.all(reads);
  assert.equal(bounded.stats().pending, 0);
});

test('a burst of distinct images keeps remote downloads below the host overload limit', async () => {
  let active = 0, peak = 0;
  const reader = createImageSourceReader(async () => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (active > 4) throw new TypeError('host overloaded');
      await new Promise(resolve => setTimeout(resolve, 5));
      return response();
    } finally {
      active--;
    }
  });
  const reads = Array.from({ length: 12 }, (_, i) => reader.read(`https://example.test/burst-${i}.jpg`));
  await Promise.all(reads);
  assert.ok(peak <= 4, `started ${peak} concurrent downloads`);
  assert.equal(reader.stats().pending, 0);
});
