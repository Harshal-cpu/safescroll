import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { isCacheableImageVerdict } = await import('../src/offscreen/store.js');

test('failed image reads cannot become persistent clean verdicts', () => {
  assert.equal(isCacheableImageVerdict({
    action: 'clean', detail: { reason: 'fetch-failed', error: 'AbortError' }
  }), false);
  assert.equal(isCacheableImageVerdict({
    action: 'clean', reason: 'fetch-failed'
  }), false);
  assert.equal(isCacheableImageVerdict({
    action: 'clean', detail: { nsfw: { reason: 'classify-failed' } }
  }), false);
});

test('completed image decisions remain cacheable', () => {
  assert.equal(isCacheableImageVerdict({ action: 'clean', detail: { nsfw: { scores: {} } } }), true);
  assert.equal(isCacheableImageVerdict({ action: 'block', detail: { detector: 'nsfw' } }), true);
});
