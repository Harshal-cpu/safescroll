import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the content script's real routing function without booting Chrome's
// observers, model bridge, or offscreen document.
const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const start = source.indexOf('function paintShields(');
const end = source.indexOf('\n// ----------------------------------------------------------------- unit intake', start);
assert.ok(start >= 0 && end > start);
const paintSource = source.slice(start, end);

function harness({ images = [], textTarget = null, mediaTarget = null } = {}) {
  const node = { isConnected: true };
  const unit = { el: node, parts: [], text: '', images };
  const shields = {};
  const entry = { shields };
  const created = [];
  const makeShield = (kind, target) => {
    if (!target) return null;
    const shield = {
      kind, target, isConnected: true, dataset: {},
      update(verdict) { this.verdict = verdict; },
      hide(userOverride) { if (userOverride) this.dataset.userOverrode = '1'; },
      destroy() { this.isConnected = false; }
    };
    created.push(shield);
    return shield;
  };
  const context = {
    isActive: () => true, resolveLive: () => node, get: () => entry,
    unitMemo: new Map([[node, unit]]), domLog() {}, siteId: 'youtube', overrideGuard() {},
    adapter: {
      textEl: () => textTarget,
      mediaTarget: () => mediaTarget,
      mediaEl: () => mediaTarget
    },
    mediaElementFor: () => mediaTarget,
    createBlurShield: (target, meta) => makeShield(meta.target, target),
    createShield: target => makeShield('post', target)
  };
  const paint = runInNewContext(`(() => { ${paintSource}; return paintShields; })()`, context);
  return { paint: verdict => paint('key', node, verdict), shields, created };
}

for (const source of ['text', 'lexicon']) {
  test(`${source} finding blurs the YouTube text carrier`, () => {
    const target = { id: 'content-text' };
    const env = harness({ textTarget: target });
    assert.equal(env.paint({ action: 'block', reasons: [{ source, action: 'block' }] }), true);
    assert.equal(env.shields.text.target, target);
    assert.equal(env.shields.text.verdict.action, 'block');
    assert.equal(env.created.some(shield => shield.kind === 'post'), false);
  });
}

for (const source of ['ocr-text', 'lexicon-ocr', 'image']) {
  test(`${source} finding blurs the matching YouTube thumbnail`, () => {
    const target = { id: 'thumbnail' };
    const url = 'https://i.ytimg.com/vi/example/hqdefault.jpg';
    const env = harness({ images: [{ url, el: { parentElement: { id: 'inner-image' } } }], mediaTarget: target });
    assert.equal(env.paint({ action: 'block', reasons: [{ source, action: 'block', detail: { imageUrl: url } }] }), true);
    assert.equal(env.shields[`media:${url}`].target, target);
    assert.equal(env.shields[`media:${url}`].verdict.action, 'block');
  });
}

test('OCR finding falls back to a post shield if its media container is gone', () => {
  const url = 'https://i.ytimg.com/vi/example/hqdefault.jpg';
  const env = harness({ images: [{ url, el: null }] });
  assert.equal(env.paint({ action: 'block', reasons: [{ source: 'ocr-text', action: 'block', detail: { imageUrl: url } }] }), true);
  assert.equal(env.shields.post.kind, 'post');
});

test('stale OCR finding does not blur a replacement thumbnail', () => {
  const env = harness({
    images: [{ url: 'https://i.ytimg.com/vi/new/hqdefault.jpg' }],
    mediaTarget: { id: 'new-thumbnail' }
  });
  assert.equal(env.paint({ action: 'block', reasons: [{
    source: 'ocr-text', action: 'block',
    detail: { imageUrl: 'https://i.ytimg.com/vi/old/hqdefault.jpg' }
  }] }), false);
  assert.equal(env.created.length, 0);
});

test('YouTube rerendered text gets a new shield when the old one is detached', () => {
  const target = { id: 'content-text' };
  const env = harness({ textTarget: target });
  const verdict = { action: 'flag', reasons: [{ source: 'lexicon', action: 'flag' }] };
  env.paint(verdict);
  const previous = env.shields.text;
  previous.isConnected = false;
  env.paint(verdict);
  assert.notEqual(env.shields.text, previous);
  assert.equal(env.shields.text.verdict.action, 'flag');
});

test('YouTube rerendered post gets a new fallback shield when the old one is detached', () => {
  const env = harness();
  const verdict = { action: 'block', reasons: [{ source: 'ocr-text', action: 'block' }] };
  env.paint(verdict);
  const previous = env.shields.post;
  previous.isConnected = false;
  env.paint(verdict);
  assert.notEqual(env.shields.post, previous);
});
