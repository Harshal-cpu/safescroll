import test from 'node:test';
import assert from 'node:assert/strict';
import { refineVerdict, reconcileMediaVerdict } from '../src/offscreen/refineVerdict.js';
import { register, rebind, get, setVerdict, clearAll } from '../src/content/registry.js';
import { mediaSourceKey } from '../src/shared/mediaFingerprint.js';

test('equal-severity image findings retain a separate media reason', () => {
  const base = { action: 'flag', reasons: [{ source: 'text', action: 'flag' }] };
  const next = refineVerdict(base, [
    { source: 'image', action: 'flag', detail: { imageUrl: 'https://a.test/2.jpg' } },
    { source: 'image', action: 'block', detail: { imageUrl: 'https://a.test/3.jpg' } }
  ], 'generic', 'a.test');
  assert.equal(next.action, 'block');
  assert.deepEqual(next.reasons.map(r => r.source), ['text', 'image', 'image']);
  assert.deepEqual(next.reasons.slice(1).map(r => r.detail.imageUrl), [
    'https://a.test/2.jpg', 'https://a.test/3.jpg'
  ]);
});

test('OCR finding is kept even when text already blocks', () => {
  const next = refineVerdict(
    { action: 'block', reasons: [{ source: 'text', action: 'block' }] },
    [{ source: 'ocr-text', action: 'flag', detail: { score: 0.8 } }],
    'x.com', 'x.com'
  );
  assert.equal(next.action, 'block');
  assert.equal(next.reasons[1].source, 'ocr-text');
  assert.equal(refineVerdict(next, [{ action: 'clean' }], 'x.com', 'x.com'), null);
});

test('an OCR block survives image retries without duplicate reasons or severity loss', () => {
  const finding = { source: 'ocr-text', action: 'block', detail: { imageUrl: 'https://a.test/meme.jpg', score: 0.99 } };
  const published = refineVerdict({ action: 'clean', reasons: [] }, [finding], 'generic', 'a.test');
  assert.equal(published.action, 'block');
  const retried = refineVerdict(published, [finding], 'generic', 'a.test');
  assert.equal(retried.reasons.length, 1);
  const laterFlag = refineVerdict(retried, [{ ...finding, action: 'flag' }], 'generic', 'a.test');
  assert.equal(laterFlag.action, 'block');
  assert.equal(laterFlag.reasons[0].action, 'block');
});

test('replacing captured bytes at the same URL drops only the old media finding', () => {
  const old = { url: 'https://a.test/mutable.jpg', dataUrl: 'data:image/png;base64,AAAA' };
  const current = { ...old, dataUrl: 'data:image/png;base64,BBBB' };
  const verdict = refineVerdict(
    { action: 'flag', reasons: [{ source: 'text', action: 'flag' }] },
    [{ source: 'image', action: 'block', detail: { imageUrl: old.url, imageSourceKey: mediaSourceKey(old) } }],
    'generic', 'a.test'
  );
  assert.equal(reconcileMediaVerdict(verdict, [old]), verdict);
  const reconciled = reconcileMediaVerdict(verdict, [current]);
  assert.equal(reconciled.action, 'flag');
  assert.deepEqual(reconciled.reasons.map(reason => reason.source), ['text']);
});

test('recycled post drops findings for images no longer present', () => {
  const previous = {
    action: 'block', reasons: [
      { source: 'text', action: 'flag' },
      { source: 'image', action: 'block', detail: { imageUrl: 'https://a.test/old.jpg' } },
      { source: 'ocr-text', action: 'flag', detail: { imageUrl: 'https://a.test/old.jpg' } }
    ]
  };
  const current = reconcileMediaVerdict(previous, [{ url: 'https://a.test/new.jpg' }]);
  assert.equal(current.action, 'flag');
  assert.deepEqual(current.reasons.map(r => r.source), ['text']);
  assert.equal(reconcileMediaVerdict(previous, [{ url: 'https://a.test/old.jpg' }]), previous);
});

test('rebind discards destroyed shields but retains the cached verdict', () => {
  clearAll();
  const oldNode = { isConnected: false };
  const newNode = { isConnected: true };
  let destroyed = 0;
  register('post', oldNode, { text: { destroy() { destroyed++; } } });
  setVerdict('post', { action: 'block', reasons: [{ source: 'text', action: 'block' }] });
  assert.equal(rebind('post', newNode), true);
  assert.equal(destroyed, 1);
  assert.deepEqual(get('post').shields, {});
  assert.equal(get('post').verdict.action, 'block');
  clearAll();
});
