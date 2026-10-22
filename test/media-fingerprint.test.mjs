import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaFingerprint } from '../src/shared/mediaFingerprint.js';

test('media identity is stable across ordering and changes for same-length image bytes', () => {
  assert.equal(mediaFingerprint([{ url: 'a' }, { url: 'b' }]), mediaFingerprint([{ url: 'b' }, { url: 'a' }]));
  assert.notEqual(mediaFingerprint([{ dataUrl: 'data:image/png;base64,AAAA' }]),
    mediaFingerprint([{ dataUrl: 'data:image/png;base64,BBBB' }]));
  assert.notEqual(mediaFingerprint([{ url: 'same.jpg', dataUrl: 'data:image/png;base64,AAAA' }]),
    mediaFingerprint([{ url: 'same.jpg', dataUrl: 'data:image/png;base64,BBBB' }]));
  assert.equal(mediaFingerprint([{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }]),
    mediaFingerprint([{ url: 'a' }, { url: 'b' }, { url: 'c' }]));
});
