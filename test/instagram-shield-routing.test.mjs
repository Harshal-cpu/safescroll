import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const start = source.indexOf('function paintShields(');
const end = source.indexOf('\n// ----------------------------------------------------------------- unit intake', start);
assert.ok(start >= 0 && end > start);
const paintSource = source.slice(start, end);

function harness({ textTargets = [], images = [], mediaTarget = null } = {}) {
  const node = { isConnected: true };
  const unit = { el: node, text: '', parts: [], images };
  const shields = {};
  const created = [];
  const makeShield = (kind, target) => {
    if (!target) return null;
    const shield = {
      kind, target, isConnected: true, dataset: {},
      update(verdict) { this.verdict = verdict; },
      hide(allowed) { if (allowed) this.dataset.userOverrode = '1'; },
      destroy() { this.isConnected = false; }
    };
    created.push(shield);
    return shield;
  };
  const context = {
    isActive: () => true, resolveLive: () => node, get: () => ({ shields }),
    unitMemo: new Map([[node, unit]]), domLog() {}, siteId: 'instagram', overrideGuard() {},
    adapter: {
      textTargets: () => textTargets,
      textEl: () => textTargets[0],
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
  test(`${source} finding covers every Instagram caption carrier`, () => {
    const targets = [{ id: 'caption-one' }, { id: 'caption-two' }];
    const env = harness({ textTargets: targets });
    assert.equal(env.paint({ action: 'block', reasons: [{ source, action: 'block' }] }), true);
    assert.equal(env.shields.text.target, targets[0]);
    assert.equal(env.shields['text:1'].target, targets[1]);
    assert.equal(env.created.some(shield => shield.kind === 'post'), false);
  });
}

for (const source of ['ocr-text', 'lexicon-ocr', 'image']) {
  test(`${source} finding covers the Instagram photo that produced it`, () => {
    const target = { id: 'photo' };
    const url = 'https://cdninstagram.test/photo.jpg';
    const env = harness({ images: [{ url, el: {} }], mediaTarget: target });
    assert.equal(env.paint({ action: 'flag', reasons: [
      { source, action: 'flag', detail: { imageUrl: url } }
    ] }), true);
    assert.equal(env.shields[`media:${url}`].target, target);
    assert.equal(env.shields[`media:${url}`].verdict.action, 'flag');
  });
}

test('stale Instagram OCR finding does not cover a replacement carousel photo', () => {
  const env = harness({
    images: [{ url: 'https://cdninstagram.test/new.jpg' }], mediaTarget: { id: 'new-photo' }
  });
  assert.equal(env.paint({ action: 'block', reasons: [{
    source: 'ocr-text', action: 'block',
    detail: { imageUrl: 'https://cdninstagram.test/old.jpg' }
  }] }), false);
  assert.equal(env.created.length, 0);
});
