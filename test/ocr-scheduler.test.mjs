import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcrScheduler, ocrCanvasDimensions, validateImageBlob } from '../src/offscreen/ocr.js';

test('OCR scheduler shares a source and serializes worker jobs', async () => {
  const queue = createOcrScheduler();
  const started = [];
  let finishFirst;
  const first = queue.run('first', () => {
    started.push('first');
    return new Promise(resolve => { finishFirst = resolve; });
  });
  const duplicate = queue.run('first', () => {
    throw new Error('duplicate OCR job started');
  });
  const second = queue.run('second', () => {
    started.push('second');
    return 'second text';
  });

  assert.strictEqual(duplicate, first);
  assert.strictEqual(queue.pending('first'), first);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ['first']);
  finishFirst('first text');
  assert.equal(await first, 'first text');
  assert.equal(await second, 'second text');
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(queue.pending('first'), undefined);
});

test('OCR scheduler continues after a failed worker job', async () => {
  const queue = createOcrScheduler();
  await assert.rejects(queue.run('bad', () => { throw new Error('worker failed'); }), /worker failed/);
  assert.equal(await queue.run('good', () => 'readable text'), 'readable text');
  assert.equal(queue.pending('bad'), undefined);
});

test('OCR queue is bounded and a capacity event admits deferred work', async () => {
  const queue = createOcrScheduler(2);
  let finish;
  let capacityEvents = 0;
  queue.onCapacity(() => { capacityEvents++; });
  const first = queue.run('first', () => new Promise(resolve => { finish = resolve; }));
  const second = queue.run('second', () => 'second');
  await assert.rejects(queue.run('third', () => 'third'), /ocr-capacity-full/);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(queue.stats(), { active: 1, queued: 1, capacity: 2, available: false });
  finish('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(capacityEvents, 2);
  assert.equal(await queue.run('third', () => 'third'), 'third');
});

test('visible work overtakes deferred work and upgrades a shared queued job', async () => {
  const queue = createOcrScheduler(4);
  const started = [];
  let finish;
  const blocker = queue.run('blocker', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const deferred = queue.run('deferred', () => { started.push('deferred'); return 'done'; }, { priority: 0 });
  const visible = queue.run('visible', () => { started.push('visible'); return 'done'; }, { priority: 1 });
  assert.strictEqual(queue.run('visible', () => { throw new Error('duplicate'); }, { priority: 1 }), visible);
  finish('done');
  await Promise.all([blocker, deferred, visible]);
  assert.deepEqual(started, ['visible', 'deferred']);
});

test('caller timeout leaves OCR running and queued cancellation cleans up', async () => {
  const queue = createOcrScheduler(2);
  let finish;
  const running = queue.run('running', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const controller = new AbortController();
  const queued = queue.run('queued', () => 'should not run', { signal: controller.signal });
  const caller = await Promise.race([running, Promise.resolve('timed-out')]);
  assert.equal(caller, 'timed-out');
  assert.strictEqual(queue.pending('running'), running);
  controller.abort();
  await assert.rejects(queued, /ocr-cancelled/);
  assert.equal(queue.pending('queued'), undefined);
  finish('late OCR result');
  assert.equal(await running, 'late OCR result');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(queue.stats().active, 0);
});

test('OCR preprocessing rejects invalid geometry and preserves aspect ratio', async () => {
  for (const [width, height] of [[0, 100], [-1, 100], [NaN, 100], [100, Infinity]]) {
    assert.throws(() => ocrCanvasDimensions(width, height), /invalid-ocr-source-dimensions/);
  }
  assert.deepEqual(ocrCanvasDimensions(2000, 1000), { width: 1100, height: 550 });
  assert.deepEqual(ocrCanvasDimensions(400, 200, true), { width: 900, height: 450 });

  const original = globalThis.createImageBitmap;
  let closed = false;
  globalThis.createImageBitmap = async () => ({ width: 0, height: 100, close: () => { closed = true; } });
  try {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], { type: 'image/jpeg' });
    assert.equal((await validateImageBlob(jpeg)).ok, false);
    assert.equal(closed, true);
  } finally {
    globalThis.createImageBitmap = original;
  }
});
