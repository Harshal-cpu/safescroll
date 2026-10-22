# SafeScroll OCR scheduling investigation

## Evidence and root causes

- A visible post reaches `content.js` `classifyMedia`, which deduplicates by media fingerprint and sends `CLASSIFY_MEDIA`. The background relays it once to `offscreen.js`. `handleClassifyMedia` classifies images, starts OCR, persists unsafe image findings immediately, then waits up to six seconds for OCR and sends refined verdicts back through the background to the content script.
- The former two-token bucket refilled only once every five seconds. `runMediaTiers` reported `budget-empty` for eligible media after those tokens were spent. `deferMediaRetry` retried a full media pass every five seconds. A media pass that timed out did this even while its original OCR promise was still in flight. The OCR scheduler shared promises by source, so the log does **not** prove simultaneous duplicate Tesseract reads. It does show repeated media work and waiting on the same unfinished job.
- The OCR verdict began as `{action:'clean'}` before OCR was attempted. Thus `ocr=clean` with `budget-empty` or `timed-out` was a default value, not a confirmed clean OCR result. `scanOCR` also returned an empty string on fetch, decode, worker, and preprocessing failures, making failure indistinguishable from a valid empty read at the caller.
- The prior scheduler serialized a single mutable Tesseract worker but had no admission bound or priority. The retry queue had a size cap of 30 but could loop on time rather than worker capacity. Changed image sets arriving while the post key was in flight were skipped, and the caller could clear its loading shield on a deferred response.
- For the `boxClipToRectangle` and `pixScanForForeground` lines, the log shows a validated 676×680 JPEG, followed by Tesseract processing and `completed`. SafeScroll calls `recognize(variant)` with a whole `OffscreenCanvas` and no rectangle option; there are no app crop coordinates to repair. Tesseract's own issue [#427](https://github.com/tesseract-ocr/tesseract/issues/427) records the same messages while OCR succeeds. The exact JPEG has not been reproduced locally, so the upstream diagnostic itself remains unverified after this change.

## Changes

- Replaced the token gate with a 12-item, one-active-worker OCR queue. It shares a pending job by source, admits visible work before deferred work, rejects excess work without growing memory, and wakes deferred media when capacity returns. Queued jobs can be cancelled on OCR disable. Image fetch retries remain bounded; transient OCR errors get one retry.
- OCR now returns a status and text separately. A caller's six-second timeout leaves the shared job running. When it settles, one later media pass consumes the result and publishes the final verdict. Invalid sources and failed passes are errors; only completed reads enter the text cache.
- Content retains its media scanning shield on deferred responses and clears it when a completion message arrives. Both contexts use one media fingerprint implementation, including a hash of data URL bytes. Stale fingerprints are checked before verdict writes and UI messages.
- Added validated decoded dimensions and aspect-preserving canvas dimensions. No crop or rectangle is supplied to Tesseract. Diagnostic logs report media ID, queue position/length, active count, status, retry count and OCR duration without raw OCR text or source URL.

## Verification

- `node --test test/*.test.mjs`: 13 passed.
- `node scripts/check-logic.mjs`: all checks passed.
- `npm run build`: passed, including `verify:dist`.
- Browser end-to-end testing was not run in this environment; the local CDP socket on port 9222 was denied by the sandbox.

## Manual browser verification

1. Build with `npm run build`, reload the unpacked extension from `dist`, and reopen a feed containing several images.
2. In the offscreen console, confirm each source starts at most one OCR job, queue `active` stays at 0 or 1, and `queued` stays at or below 11. Rapidly scroll and mutate/reinsert the same post; check the queue does not grow without bound.
3. Pause on a media item whose OCR exceeds six seconds. Confirm the console says `ocrStatus=timed-out`, its media shield remains in the scanning state, and the later job completion produces a final `clean`, `flag`, or `block` status and releases or updates the shield.
4. Show a known harmful image and a meme with harmful text. Confirm the image block remains blocked throughout and the OCR finding can upgrade a clean image. Replace the post's image before OCR finishes; confirm the old result does not paint the new image.
5. Disable OCR while jobs are queued, then re-enable it. Confirm queued jobs are cancelled and fresh visible work can run. Simulate a failed image fetch/OCR read and confirm diagnostics say `error`, never `clean`.
6. Revisit the logged 676×680 JPEG. Note whether Tesseract prints the two box messages, and whether it still returns a usable result. Those messages alone are not a JavaScript exception or proof of an invalid app crop.
