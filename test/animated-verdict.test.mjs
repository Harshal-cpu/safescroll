import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
const start = source.indexOf('async function handleClassifyAnimated(');
const end = source.indexOf('\nasync function handleClassifyMedia(', start);
assert.ok(start >= 0 && end > start);
const handlerSource = source.slice(start, end);

test('GIF frames use the existing image/OCR tiers and stop after a confirmed block', async () => {
  const broadcasts = [];
  const examined = [];
  const context = {
    runtimeSettingsReady: Promise.resolve(), runtime: { imageEnabled: true, ocrEnabled: true },
    protectionEnabled: true, protectionGeneration: 0,
    settingsPolicy: () => '1:1:1', MSG: { ANIMATED_VERDICT: 'animated-verdict' },
    chrome: { runtime: { sendMessage: message => { broadcasts.push(message); return Promise.resolve(); } } },
    decodeGifFrames: async function* () {
      for (const frameIndex of [0, 5, 10]) yield { frameIndex, dataUrl: `frame-${frameIndex}` };
    },
    runMediaTiers: async (images, _referer, _text, _progress, onImage) => {
      examined.push(images[0].dataUrl);
      if (images[0].dataUrl === 'frame-5') await onImage({ action: 'block', source: 'image' });
      return { ocrVerdict: { action: 'clean' }, pendingOcr: null };
    }
  };
  const run = runInNewContext(`(() => { ${handlerSource}; return handleClassifyAnimated; })()`, context);
  const result = await run({ kind: 'gif', scanId: 'ssanim:one', url: 'https://site.test/meme.gif' });
  assert.deepEqual(examined, ['frame-0', 'frame-5']);
  assert.equal(result.action, 'block');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].frameIndex, 5);
  assert.equal(broadcasts[0].verdict.source, 'image');
});

test('video frame OCR finding sends a verdict without classifying the poster', async () => {
  const broadcasts = [];
  const context = {
    runtimeSettingsReady: Promise.resolve(), runtime: { imageEnabled: false, ocrEnabled: true },
    protectionEnabled: true, protectionGeneration: 0,
    settingsPolicy: () => '0:1:1', MSG: { ANIMATED_VERDICT: 'animated-verdict' },
    chrome: { runtime: { sendMessage: message => { broadcasts.push(message); return Promise.resolve(); } } },
    runMediaTiers: async images => {
      assert.equal(images[0].url, null);
      assert.ok(images[0].dataUrl.startsWith('data:image/jpeg'));
      return { ocrVerdict: { action: 'block', source: 'ocr-text' }, pendingOcr: null };
    }
  };
  const run = runInNewContext(`(() => { ${handlerSource}; return handleClassifyAnimated; })()`, context);
  await run({ kind: 'video', scanId: 'ssanim:two', frameIndex: 1,
    dataUrl: 'data:image/jpeg;base64,AAAA' });
  assert.equal(broadcasts[0].verdict.source, 'ocr-text');
  assert.equal(broadcasts[0].frameIndex, 1);
});
