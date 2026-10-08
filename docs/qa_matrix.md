# QA Matrix

This document is the release evidence template for the V2.1 plans. An empty result means **unverified**, not pass. Automated checks run with `npm test`; the final artifact must be built before its conditional checks execute.

## Automated integration coverage

| Area | Automated evidence | Release expectation |
|---|---|---|
| Card conservation | `tests/integration/core-flow.test.js` counts 104 unique live card IDs for 1/2/4 suits and boundary 64-bit seeds | PASS for every case |
| Seed → deal → restart | `tests/integration/core-flow.test.js` verifies serialization and restart against the same stable deal identity | PASS |
| Manifest publication predicate | `tests/integration/manifest-release.test.js` verifies enabled, empty, disabled, count, byte and unique `dealId` constraints | PASS on fixture and generated manifest |
| Profile isolation | Runtime integration test: separate `(profileId, dealId)` completed, save, stats and preferences | PASS after runtime API lands |
| Import/export | Runtime integration test: export, clear repository, import and compare all profile-scoped records | PASS after runtime API lands |
| Final artifact | `tests/integration/final-artifact.test.js` requires one `dist/index.html` and rejects remote asset/runtime URLs | PASS after final build |

Conditional tests report **SKIP with the missing capability named** while an implementation milestone is absent. A release candidate may not contain skips for an enabled feature or required artifact.

## Browser and offline manual matrix

Run this matrix against the exact final `dist/index.html` bytes. Record browser name, full version, OS version, artifact SHA-256, date, operator, and evidence path. “Browser family tested earlier” is not evidence for the final artifact.

| Browser / path | Version + OS | Storage capability probe | New / move / deal | Undo / restart | Save / close / resume | User isolation | Import / export | Stats | Audio / animation | Physical offline | Result / evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Safari `file://` macOS |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Chrome `file://` macOS |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Firefox `file://` macOS |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Chrome `file://` Windows |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Firefox `file://` Windows |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Edge `file://` Windows |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Declared local-server fallback | Codex in-app Chromium (version unavailable), macOS, 2026-10-05; SHA-256 `4693a737…f8f8c` | No storage warning; save survived reload and resume dialog restored it | PASS: new, legal/illegal move, stock | PASS: undo and restart confirmation | PASS: reload/resume | Profile panel rendered; repository isolation tests PASS; create/rename/delete UI not exercised | Repository round-trip PASS; browser file picker not exercised | PASS | Sound preference toggled and persisted; actual audio output and victory animation remain unverified | No remote reference and empty error/warning console; OS adapter was not disabled | PARTIAL — final local fallback playtest plus verified blind-calibration deep link; see `docs/release-status.md` |

### Storage variants

For every claimed browser path, run these separately:

1. First open, refresh, close, and reopen at the same path.
2. Rename the HTML file, then reopen it.
3. Move the HTML file to another directory, then reopen it.
4. Replace it with the next schema version and verify atomic migration.
5. Force capability failure where practical: private mode, quota rejection, interrupted upgrade, or cleared site data.
6. Verify the UI never says “safely saved” after persistence failure and offers memory mode plus JSON export.
7. Export JSON, clear local data, import into a fresh profile store, and compare users, completed deals, saves, stats, preferences, and version fields.

Do not claim rename or move continuity unless the recorded result proves it for that exact browser and release path.

## Player-visible playtest

Capture screenshots or video for the first actionable screen, a legal move, an illegal move, stock dealing, auto-flip, completed run, undo, restart, pause/resume, win, disabled bucket, allowed-empty bucket, and exhausted bucket. Check desktop and narrow/mobile viewports, reduced motion, keyboard and pointer input, playfield obstruction, readable card overlap, and clear save-failure feedback.

## Final release evidence

- `npm test` output with no required skips.
- `npm run verify:certificates` report with `validatedCount == totalEmbeddedCount` and zero failures.
- `npm run build` and `npm run verify:dist` output.
- Final artifact SHA-256 and byte size.
- Resolved manifest hash and build report; regression denominator equals the sum of enabled `embeddedCount` values.
- Browser matrix populated with evidence paths for every declared platform.
- Network disabled at the OS or adapter level during the offline pass; DevTools “Offline” alone is insufficient.
- No external request in the browser network log.
- License/source lock and third-party notice review completed for the exact artifact.
