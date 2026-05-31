# Frontend safety net

The MadMusic frontend has **no build step**: `app.html`'s inline `<script>` blocks
coordinate with `app.min.js` and the `js/*.js` modules purely through shared
`window.*` globals, script load-order, and element IDs. Nothing catches a broken
contract at build time, and the three big views (`app.html`, `mobile.html`,
`audio-lab.html`) duplicate large amounts of CSS/JS by copy-paste.

These tests exist to make an **aggressive code-quality overhaul of those files safe**.
They are the guardrail you refactor behind.

## Layers

| File | What it guards | Backend needed |
|------|----------------|----------------|
| `structural-contract.test.js` | Script load-order, shared `window.*` globals, depended-on element IDs are not silently severed | No |
| `duplication-baseline.test.js` | Duplicated CSS/JS across views can only go **down**, never up (progress ratchet) | No |
| `visual/` (Playwright) | Pages render and key behavior works; screenshot diffs catch layout regressions | Yes (local boot) |

Baselines are committed JSON:
- `contract.baseline.json` — the structural fingerprint
- `duplication.baseline.json` — the duplication numbers

## Workflow

1. Run `npx vitest run tests/frontend` before touching the views — confirm green.
2. Refactor.
3. Re-run. A **red** test means an *unintended* regression — fix it.
4. If a change to the contract was *intentional* (e.g. you deliberately removed a
   global, or extracted shared CSS so duplication dropped), review the diff and
   regenerate the affected baseline:
   ```
   UPDATE_BASELINE=1 npx vitest run tests/frontend/structural-contract.test.js
   UPDATE_BASELINE=1 npx vitest run tests/frontend/duplication-baseline.test.js
   ```
   Commit the regenerated baseline alongside the change so the diff is reviewable.

## What these do NOT catch (be honest about the gaps)

- **Duplication** is measured by *exact significant-line matches in inline `<style>`/
  `<script>` blocks only*. It does not see external `css/app.css` or `js/*.js`, and it
  does not detect semantically-similar-but-textually-different components. The number
  is a conservative floor, not a complete duplication audit. It still correctly
  rewards the overhaul: extracting inline CSS/JS into shared files drops the count.
- **Structural contract** is a static fingerprint. It proves the wiring is intact, not
  that the app behaves correctly. That is the Playwright layer's job.
