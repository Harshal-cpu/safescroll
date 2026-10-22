# SafeScroll: OCR lifecycle and runtime settings

## Capture

The latest supplied capture has 328 lines from `offscreen-DBYDWRjX.js`, the previous production build. It contains nine OCR fetch timeouts and 17 visible-wait expirations. One scan takes 10,332 ms, while the single worker accumulates about six queued jobs. The same post is processed repeatedly after late failures, and an OCR retry is logged with the image retry count.

`Estimating resolution`, the associated diagnostic stack, and `Detected 83 diacritics` are Tesseract diagnostics. This capture does not contain the earlier Tesseract box errors. A visible-wait expiration is the caller's six-second deadline; it does not mean the underlying job has stopped.

## Root causes and fixes

1. **Settings never reached offscreen.** The document tried to use `chrome.storage`, caught the unsupported API error, and kept defaults. Chrome permits only the runtime extension API in offscreen documents: [official documentation](https://developer.chrome.com/docs/extensions/reference/api/offscreen). The background now reads settings and relays initialization and changes through runtime messages. Classification waits for initialization, and revision guards prevent stale settings from overwriting newer changes. Shared defaults also align the options form with the active profile.
2. **Queued OCR lost its source bytes.** Source fetching happened when the worker reached a job. A queued job could outlive the shared source cache's ten-second TTL, causing another download. New admitted jobs now reserve the shared Blob immediately and retain it while waiting. Duplicate jobs share their pending read; rejected queue admissions start no download. A failed read is consumed by its own job without an unhandled rejection.
3. **Late OCR completion restarted the whole media pass.** The continuation ignored the actual outcome. Late errors escaped retry accounting, while the next pass repeated image classification and could schedule OCR again. The continuation now consumes the original moderated outcome with the original image results. Dedupe remains active while OCR is pending. Image retries reuse settled OCR outcomes, including exhausted failures. OCR receives at most two attempts for the same retained post/media/settings identity; image work receives its original pass plus two retries. Logs use the counter belonging to the retry reason and distinguish pending, error, and complete media states.

These changes preserve the single OCR worker, existing fetch deadlines, and already confirmed blocks. A genuinely unavailable source can still time out; that failure is retained as incomplete rather than reported as a completed clean scan. Bounded in-memory records can be evicted, and replacing the media or changing settings starts a new identity.

## Verification

- Node tests: **34/34 passed**. Regressions cover admission-time byte reservation, queue rejection without fetching, settings relay and update ordering, late success/failure, stale media, dedupe while pending, preserving unsafe findings, and OCR retry limits during image retries.
- Project logic checks and source syntax checks passed. Diff whitespace checks passed.
- `npm run build` and production-distribution verification passed. The rebuilt bundles are `offscreen-4b3HveST.js` and `background.js-Y7vhPV-W.js`.
- Disposable real Chrome loaded the old production extension and reproduced the settings failure: stored settings did not reach offscreen. The rebuilt extension passed the same regression. The test confirmed `chrome.storage` is absent in offscreen, disabling both media tiers starts no OCR jobs, and re-enabling them reaches runtime settings. Both local moderation models loaded.
- The full browser OCR workload remains unverified in this environment: the earlier fresh-profile worker check stalled while loading English traineddata, and a separate request to the configured traineddata CDN timed out. The passing browser check exercises settings; controlled tests execute the actual media handler and OCR admission code with external inference boundaries mocked.

## Reload and inspect

1. Reload the unpacked extension from `D:\safescroll - Copy\dist`, then refresh the feed. Confirm the offscreen bundle is `offscreen-4b3HveST.js` and the `runtime settings` message appears. A later rebuild can change the hash.
2. Disable OCR and images in options. Confirm runtime settings change and no new media/OCR work starts. Re-enable them and confirm the runtime reflects both changes.
3. Scroll through queued media. If a visible wait expires, its completion should use `late-completion`, retain the original image outcome, and consume the OCR outcome once. Duplicate requests for the pending snapshot should report `already-processing`.
4. For a failing source, confirm retry counts belong to their logged reason. Pending/error passes must not appear as completed clean scans, and an existing text/image/OCR block must remain applied.
5. With the traineddata CDN reachable, run `node scripts/check-console-browser.mjs` for the complete browser OCR check. The verified settings-only command is `node scripts/check-console-browser.mjs --settings-only`; both use a disposable profile and close their own browser.

Implementation and build are complete. Real-browser settings verification passes; full browser OCR verification remains limited by traineddata availability.
