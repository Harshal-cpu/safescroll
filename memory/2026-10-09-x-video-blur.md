# Debug report: safe X videos blurred

- **Symptom:** Some safe videos on x.com appear blurred by SafeScroll.
- **Root cause:** The X adapter included `<video poster>` as a photo input. When a video-only post yielded no text or photo, the adapter returned `null`, allowing generic extraction to treat a thumbnail or UI text as content. During classification of a text-only video post, the loading shield covered the whole post. Older poster verdicts were persisted under the prior X post key.
- **Fix:** Limit X image extraction to photos, keep empty video-only units out of generic extraction, scope text-only loading shields to text, and version the X post key to invalidate old poster verdicts.
- **Evidence:** `scripts/check-x-video.mjs` failed before the extraction change and passes after it. `scripts/check-logic.mjs` passes. The production build and dist verification pass.
- **Regression test:** `scripts/check-x-video.mjs`.
- **Limit:** No live x.com tab was available through the local debug endpoint, and no example false-positive video was supplied. A specific remaining blur requires its URL and the shield reason to separate text verdicts from image model false positives.
- **Status:** DONE_WITH_CONCERNS (code paths verified; live X behavior remains untested).
