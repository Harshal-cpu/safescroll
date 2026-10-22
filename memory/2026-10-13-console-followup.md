# SafeScroll console follow-up

## What the new capture shows

The capture is from `offscreen-C-x-UCBT.js`, the build produced in the previous investigation. It contains three OCR transport failures, each followed by a successful bounded retry. It has one six-second caller timeout followed by OCR completion and a cache hit. OCR concurrency remains one; this capture does not show a duplicate-worker loop or an exhausted queue. `Estimating resolution`, `in-flight`, `cache-hit`, completed-media skips, and the expected ImageBitmap transport check are informational. The earlier Tesseract box errors do not appear in this capture.

## Root causes and fixes

1. `ocr.js` still had a separate image fetcher with `AbortController.abort()` called without a reason. That generated `signal is aborted without reason` for the app's own deadline. OCR and image classification independently downloaded the same source; either request could fail while the other succeeded. `imageSource.js` now shares pending downloads and recent successful Blob results between both consumers. The cache is capped at eight entries and 16 MiB; pending transport requests are capped at 16. Each decoder owns its own bitmap. Failed requests are not cached, and timeout errors carry `TimeoutError` and the `fetch-timeout` category. Existing standalone fetch budgets are retained; a shared request uses the budget of the first consumer. Opaque `no-cors` requests are removed because they cannot provide pixels.
2. `handleClassifyMedia` returned to the image retry queue before persisting an already completed unsafe OCR result. The capture's `cb72434b7161258b` block followed this path. Confirmed OCR findings are now persisted and notified before any retry branch. Image and OCR statuses remain separate from the final verdict; an incomplete image tier logs `error` instead of its default `clean` value.
3. Repeated refinement could append the same OCR reason during an image retry. `refineVerdict` now replaces a reason for the same source/image identity and preserves an existing block. Reasons also retain the captured-byte identity, so a changed image at the same URL can discard its old media finding safely.

## Verification

- Source-level lifecycle regression executes the actual media handler with mocked inference and storage boundaries. It checks persistence and notification before image deferral, retaining an image block during an OCR failure, and rejecting stale OCR completion.
- Shared transport regressions check concurrent request reuse, completed-byte reuse, cleanup after failure, explicit deadline reasons, invalid response rejection, bounded cache bytes/entries, and bounded pending requests.
- Node tests: 23 passed. Project logic checks: passed. Production build and `verify:dist`: passed.
- Disposable Chrome loaded the production extension through `Extensions.loadUnpacked`; both local moderation models reached ready. The real OCR check could not complete its fresh-profile worker initialization. A separate request to the configured English traineddata CDN also timed out after 20 seconds. This is an unresolved external availability constraint; the full real-OCR browser regression did not pass.
- REA completed static analysis of the offscreen source and retained evidence. Its full response exceeded the MCP transport budget; source traces and the executed regressions provide the reported behavioral evidence.

## Manual verification

1. Reload the unpacked extension from `dist` and refresh the feed. The new offscreen bundle is `offscreen-DBYDWRjX.js` (a later rebuild can change this hash).
2. Revisit the images that timed out. A genuine unavailable source may still report `fetch-timeout`; it must remain an error and retry only within the existing limits. Confirm the old `signal is aborted without reason` message is absent.
3. On a harmful-text meme, temporarily fail image decoding/classification while OCR succeeds. The media must block immediately, before the image retry. Reload/revisit it and confirm the OCR reason is preserved once.
4. Replace the media while OCR is running; confirm the old finding does not affect the replacement. A text or image block must retain its severity during incomplete OCR.
5. Run `node scripts/check-console-browser.mjs` where the traineddata CDN is reachable for the real OCR, shared-download, timeout recovery, and notification checks. This script uses a disposable profile and closes its own browser.

Status: DONE_WITH_CONCERNS — code regressions and production build pass; full browser OCR verification remains dependent on traineddata availability.
