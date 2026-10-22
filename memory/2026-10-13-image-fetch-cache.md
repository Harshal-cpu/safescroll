# Image fetch warning investigation — 2026-10-13

## Symptom

The second supplied console log shows two `nsfw source unusable ... signal is aborted without reason` warnings. OCR budget deferrals, visible wait expirations, ImageBitmap transport checks, and Tesseract resolution messages are diagnostic. Several deferred OCR passes later reached cache hits and verdict upgrades.

## Root cause

The image fetch has a deliberate per-attempt deadline. When it aborts, `classifyImage` returned a clean result with `fetch-failed` only at `detail.reason`. The caller checked only the top-level `reason` before writing the result to IndexedDB. It could therefore persist a failed fetch as a clean image verdict. The media fingerprint was also marked complete after the failed image attempt, so a visible post would not request the image again. The third `no-cors` fallback could only produce an opaque response, which cannot supply image pixels.

REA parsed the current seven offscreen JavaScript files without parse failures. The warning itself and the source code establish the cache path; REA's static graph does not prove the timing of a particular browser fetch.

## Fix

- Return a top-level failure reason from image transport and classification failures.
- Reject both old and new failed results at the image-cache read and write boundaries.
- Leave failed media fingerprints incomplete and retry the image pass up to two times after the initial attempt.
- Remove the unusable `no-cors` fallback, give aborted attempts a clear timeout reason, and log expected timeouts at debug level.

## Verification

- `node --test test/*.test.mjs`: 8 passed.
- `node scripts/check-logic.mjs`: all checks passed.
- `npm run build`: passed, including production-dist verification.
- Live Chrome replay was unavailable because no CDP endpoint was listening on `127.0.0.1:9222`.

Status: DONE_WITH_CONCERNS (the cache regression is tested and the build passes; browser retry timing has not been re-observed).
