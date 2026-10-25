import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGifFrames, gifFrameIndexes } from '../src/offscreen/animatedFrames.js';
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

test('GIF scan accepts a readable download that takes longer than the still-image deadline', async () => {
  const previous = { fetch: globalThis.fetch, ImageDecoder: globalThis.ImageDecoder, document: globalThis.document };
  const attempts = [];
  globalThis.fetch = (_url, { signal, credentials }) => {
    attempts.push(credentials);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        ok: true, type: 'basic', headers: new Headers({ 'content-type': 'image/gif' }),
        blob: async () => new Blob([new Uint8Array([71, 73, 70, 56])], { type: 'image/gif' })
      }), 1500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  globalThis.ImageDecoder = class {
    static async isTypeSupported() { return true; }
    tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } };
    completed = Promise.resolve();
    async decode() { return { image: { displayWidth: 2, displayHeight: 2, close() {} } }; }
    close() {}
  };
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA'
  }) };
  try {
    const frames = [];
    for await (const frame of decodeGifFrames('https://site.test/slow-animation.gif')) frames.push(frame);
    assert.deepEqual(frames.map(frame => frame.frameIndex), [0, 1]);
    assert.deepEqual(attempts, ['omit']);
  } finally {
    Object.assign(globalThis, previous);
  }
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
    const listeners = new Map();
    let nextCallback = 0;
    const video = { tagName: 'VIDEO', currentSrc: 'blob:https://site.test/clip', src: '',
      isConnected: true, parentElement: parent, duration: 12, readyState: 2,
      currentTime: 0, videoWidth: 320, videoHeight: 180, paused: true,
      addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
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
    assert.equal(sent.length, 0, 'a paused thumbnail must not be sampled as a playing video');
    video.paused = false;
    listeners.get('play')();
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
    scanner.onVerdict({ scanId: sent[0].scanId, frameIndex: 0,
      verdict: { action: 'block', source: 'image', settingsPolicy: '1:1:1' } });
    assert.equal(shields.length, 0, 'one isolated image-model hit must not blur a video');
    scanner.onVerdict({ scanId: sent[0].scanId, frameIndex: 0,
      verdict: { action: 'block', source: 'image', settingsPolicy: '1:1:1' } });
    assert.equal(shields.length, 0, 'duplicate responses for one frame cannot confirm a video');
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

test('two distinct unsafe video frames confirm an image block', () => {
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
    const video = { tagName: 'VIDEO', currentSrc: 'blob:https://site.test/another-clip', src: '',
      isConnected: true, parentElement: parent, duration: 12, readyState: 2, paused: false,
      currentTime: 0, videoWidth: 320, videoHeight: 180,
      addEventListener() {}, removeEventListener() {},
      requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) };
    const scanner = createAnimatedMediaScanner({ send: async message => { sent.push(message); }, isEnabled: () => true,
      policy: () => '1:1:1', siteId: 'instagram', overrideGuard: async () => true,
      createShield: () => {
        const shield = { style: {}, dataset: {}, isConnected: true, parentElement: parent,
          classList: { contains: () => false }, update(v) { this.verdict = v; },
          destroy() { this.isConnected = false; } };
        shields.push(shield);
        return shield;
      } });
    scanner.observeRoot({ querySelectorAll: () => [video], matches: () => false });
    intersection([{ target: video, isIntersecting: true }]);
    const verdict = { source: 'image', settingsPolicy: '1:1:1' };
    const scanId = sent[0].scanId;
    scanner.onVerdict({ scanId, frameIndex: 0, verdict: { ...verdict, action: 'flag' } });
    assert.equal(shields.length, 0);
    scanner.onVerdict({ scanId, frameIndex: 1, verdict: { ...verdict, action: 'block' } });
    assert.equal(shields.length, 1);
    assert.equal(shields[0].verdict.action, 'block');
    scanner.stop();
  } finally {
    Object.assign(globalThis, previous);
  }
});
