# Debug report: Instagram text blur geometry

- **Symptom:** Harmful Instagram text receives a verdict, but the blur does not cover it properly.
- **Root cause:** Instagram comment text is often an inline span. A single absolutely positioned shield inside a span that wraps across lines covered only part of the span's fragmented layout box. The browser fixture measured 299 px of wrapped text but only 165 px of shield width.
- **Fix:** For inline text targets, the shield now draws a fixed blur fragment over each rendered line without changing the text's layout. It refreshes fragment positions on scroll and resize and removes its listeners on destroy.
- **Evidence:** `test/fixture-instagram-shield.html` failed before the fix and passed in headless Chrome after it. Its checks confirm every line is covered, the comment keeps its position, and the original display style remains intact. `scripts/check-logic.mjs` and the production build pass.
- **Regression test:** `test/fixture-instagram-shield.html`.
- **Limit:** No authenticated live Instagram page was available for final site verification.
- **Status:** DONE_WITH_CONCERNS.
