// Regression: an X video poster is not a photo verdict, and a clean video
// caption must not put the whole post behind a loading shield.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { twitterAdapter } from '../src/content/adapters.js';

const caption = {
  innerText: 'A quiet walk through the park this morning.',
  closest: () => null
};
const video = {
  tagName: 'VIDEO',
  currentSrc: '',
  src: '',
  getAttribute: name => name === 'poster' ? 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/frame.jpg' : null,
  complete: false
};
const photo = {
  tagName: 'IMG',
  currentSrc: 'https://pbs.twimg.com/media/photo.jpg',
  src: 'https://pbs.twimg.com/media/photo.jpg',
  complete: false
};
const post = media => ({
  matches: selector => selector === 'article[data-testid="tweet"]',
  querySelectorAll: selector => selector === '[data-testid="tweetText"]' ? [caption] :
    selector.includes('[data-testid="tweetPhoto"]') && selector.includes(media.tagName.toLowerCase()) ? [media] : [],
  querySelector: () => null
});
const videoOnlyPost = {
  ...post(video),
  querySelectorAll: selector => selector === '[data-testid="tweetText"]' ? [] :
    selector.includes('video') ? [video] : []
};

assert.equal(twitterAdapter.extract(post(video)).images.length, 0,
  'video posters must not be submitted to the still-image model');
assert.ok(twitterAdapter.extract(videoOnlyPost),
  'an X video-only post must not fall through to generic extraction');
assert.deepEqual(twitterAdapter.extract(post(photo)).images.map(image => image.url), [photo.src],
  'actual X photos must still be classified');
assert.match(readFileSync(new URL('../src/content/adapters.js', import.meta.url), 'utf8'),
  /x:photo-only-v2:/,
  'old persisted video-poster verdicts must be invalidated');

const content = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
assert.match(content, /unit\.text\s*&&\s*!unit\.images\.length[\s\S]*?createBlurShield\(adapter\.textEl\?\.\(unit\)/,
  'a text-only video post must load with a text shield, not a whole-post shield');
console.log('X video regression checks passed');
