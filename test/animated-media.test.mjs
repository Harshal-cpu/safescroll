import test from 'node:test';
import assert from 'node:assert/strict';
import { gifFrameIndexes } from '../src/offscreen/animatedFrames.js';
import { createAnimatedMediaScanner, isGifSource, isShortVideo } from '../src/content/animatedMedia.js';

test('only actual GIF sources and finite short videos enter the new path', () => {
  assert.equal(isGifSource('https://site.test/meme.gif?size=small'), true);
  assert.equal(isGifSource('data:image/gif;base64,R0lG'), true);
  assert.equal(isGifSource('https://site.test/meme.mp4'), false);
  assert.equal(isShortVideo(60), true);
  assert.equal(isShortVideo(61), false);
  assert.equal(isShortVideo(Infinity), false);
  assert.deepEqual(gifFrameIndexes(1), []);
  assert.deepEqual(gifFrameIndexes(3), [0, 1, 2]);
  assert.deepEqual(gifFrameIndexes(20), [0, 6, 13]);
});

test('video scanner samples early decoded frames and paints only its matching verdict', async () => {
  const previous = { IntersectionObserver: globalThis.IntersectionObserver,
    ResizeObserver: globalThis.ResizeObserver, document: globalThis.document,
    location: globalThis.location };
  let intersection;
  globalThis.IntersectionObserver = class {
    constructor(callback) { intersection = callback; }
    observe() {} unobserve() {} disconnect() {}
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.document = { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' }) };
  globalThis.location = { href: 'https://site.test/feed' };
  try {
    const sent = [];
    const shields = [];
    const parent = { tagName: 'DIV', getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const callbacks = new Map();
    let nextCallback = 0;
    const video = { tagName: 'VIDEO', currentSrc: 'blob:https://site.test/clip', src: '',
      isConnected: true, parentElement: parent, duration: 12, readyState: 2,
      currentTime: 0, videoWidth: 320, videoHeight: 180,
      addEventListener() {}, removeEventListener() {},
      requestVideoFrameCallback(fn) { callbacks.set(++nextCallback, fn); return nextCallback; },
      cancelVideoFrameCallback(id) { callbacks.delete(id); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) };
    const root = { querySelectorAll: () => [video], matches: () => false };
    const scanner = createAnimatedMediaScanner({
      send: async msg => { sent.push(msg); }, isEnabled: () => true,
      policy: () => '1:1:1', siteId: 'generic', overrideGuard: async () => true,
      createShield: () => {
        const shield = { style: {}, dataset: {}, isConnected: true, parentElement: parent,
          classList: { contains: () => false }, update(v) { this.verdict = v; },
          destroy() { this.isConnected = false; } };
        shields.push(shield);
        return shield;
      }
    });
    scanner.observeRoot(root);
    intersection([{ target: video, isIntersecting: true }]);
    for (const time of [0, 0.1, 0.55, 1.1]) {
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id);
      callback(0, { mediaTime: time });
    }
    assert.deepEqual(sent.map(v => v.frameIndex), [0, 1, 2]);
    assert.ok(sent.every(v => v.kind === 'video' && v.dataUrl.startsWith('data:image/jpeg')));
    scanner.onVerdict({ scanId: 'another-video', frameIndex: 0,
      verdict: { action: 'block', source: 'image', settingsPolicy: '1:1:1' } });
    assert.equal(shields.length, 0);
    scanner.onVerdict({ scanId: sent[1].scanId, frameIndex: 1,
      verdict: { action: 'block', source: 'ocr-text', settingsPolicy: '1:1:1' } });
    assert.equal(shields[0].verdict.action, 'block');
    shields[0].dataset.userOverrode = '1';
    scanner.onVerdict({ scanId: sent[1].scanId, frameIndex: 2,
      verdict: { action: 'block', source: 'image', settingsPolicy: '1:1:1' } });
    assert.equal(shields.length, 1);
    scanner.stop();
  } finally {
    Object.assign(globalThis, previous);
  }
});
