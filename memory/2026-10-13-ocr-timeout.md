# OCR timeout investigation — 2026-10-13

## Symptom

The supplied offscreen console log shows repeated six-second OCR wait timeouts on an image-heavy X feed. Tesseract sometimes reports `completed` after a media pass has timed out. Other lines such as `Estimating resolution`, `Detected ... diacritics`, ImageBitmap transport checks, and `budget-empty` are diagnostics rather than thrown errors.

## Root cause

`runMediaTiers` raced OCR against a six-second timer, then treated an empty result from that timer as a completed media pass. `handleClassifyMedia` recorded the image fingerprint in `mediaDone`, so a later OCR result could not refine the post. At the same time, separate media requests could call `setParameters` and `recognize` on one shared mutable Tesseract worker without serialization.

REA parsed the seven JavaScript files in `src/offscreen` without executing them and found no parse failures. The pasted stack and source code establish the timer-to-`mediaDone` path; static analysis alone does not prove browser timing.

## Fix

- Serialize Tesseract jobs and share a pending job for repeated requests for the same image.
- Reuse pending OCR without spending another budget token.
- Mark a six-second timeout as deferred and retry the media pass, allowing a late OCR result to upgrade the verdict. The timeout is logged as a progress message.

## Verification

- `node --test test/*.test.mjs`: 6 passed.
- `node scripts/check-logic.mjs`: all checks passed.
- `npm run build`: passed, including production-dist verification.
- Live Chrome verification was unavailable: no CDP target was listening on `127.0.0.1:9222` in this session.

Status: DONE_WITH_CONCERNS (the concurrency and retry paths are tested; browser timing has not been re-observed).
