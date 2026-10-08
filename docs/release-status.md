# Release status — 2026-10-07

The repository now produces a reviewable **technical beta** as one self-contained HTML file. All locally automatable implementation and release gates pass. It is not labeled Formal Alpha or V1 because the checked-in seed library still has `classificationStatus = provisional`, browser performance evidence is only a labeled Node proxy, and the required cross-platform physical-offline browser matrix is incomplete.

## Completed technical scope

- Deterministic 104-card Spider generator and immutable rule engine for 1, 2 and 4 suits.
- Runtime play, legal move checks, stock deals, auto-flip, run completion, hint, undo, restart, autosave/resume, local profiles, statistics, settings and JSON backup interfaces.
- Configurable 12-bucket manifest. This beta embeds 125 certified deals per difficulty bucket for 1-suit play, 5,000 easy, 5,000 medium, 1,000 hard and 1,000 demon deals for 2-suit play, plus two certified deals per difficulty bucket for 4-suit play, for 12,508 embedded deals total. Each validated candidate is classified immediately by the manual anchor-guided rule; every difficulty bucket is capped at 5,000, with hard and demon targets fixed at 1,000.
- Difficulty calibration rule: for 2-suit play, solution length is classified into easy `<=160`, medium `161–180`, hard `181–195` and demon `>=196`. The manually reviewed 153-step game falls in easy and the 171-step game falls in medium. These values are guard bands around reference points, not claimed exact human-perception boundaries; labels remain provisional pending independent ratings. The 1-suit four-band ranking is retained provisionally because no contrary human review was supplied for that mode.
- SolverLab build-time adapter pinned to commit `cc21d7e9345cce0506fad5c64ddfe7f833f0c51f`, with Apache-2.0 attribution, plus an isolated MIT-licensed Toranpu 2.14.1 candidate-search step for the expanded 1/2/4-suit pools. No solver or solution certificates are shipped in the browser artifact.
- Every embedded deal passed the independent validator. The release regression regenerates each initial deal and replays all 12,508 certificates: `12,508 / 12,508 PASS`, zero failed, duplicate, orphan or tombstoned selections. The expansion evidence contains 100,000+ independently solved 2-suit candidates, and the final importer selected only candidates that passed the project validator and filled the 5,000/5,000/1,000/1,000 caps; the eight 4-suit candidates remain independently revalidated locally.
- One-file build, fail-closed publication predicates, no remote runtime dependency, integrity hashes, compression/size report, strict third-party source lock and offline-call scanner.
- Release bundling removes the duplicate global seed-artifact copy and omits the build-only `manifest.deals` mirror from the embedded manifest. The browser reads the two embedded JSON script blocks directly, while source-time manifests remain complete for audit and validation.
- Runtime Seed Library V2 supports disabled, superseded and classification-override tombstones while preserving V1 completion identity. Persistent-store failures switch the live repository to a hydrated in-memory adapter.
- Timer/score state machine, local Web Audio cues, victory feedback and reduced-motion handling have automated coverage.
- Interaction polish is covered: new games use cryptographically random seed selection with immediate-repeat avoidance, invalid moves clear selection without a toast and use a short shake, stock deals and completed runs animate, double-click moves the selected card group with same-suit destinations preferred over empty columns and mixed-suit destinations, hints blink the exact movable card group (or the stock when dealing is the next action), exhausted positions report failure, the stock row reserves space above the bottom toolbar, card faces use local poker-style pips and J/Q/K portraits with clipped boundaries, and long tableau columns compress while hover expands the movable tail back to a click-friendly spacing.
- Local profile create, rename, switch and delete flows are backed by repository cleanup tests that verify saves, completions, preferences and statistics do not leak after deletion.
- `prototype.html` is generated as an exact copy of the verified single-file artifact; the Seed Library compatibility boundary is recorded in `docs/seed-library-compatibility-matrix.md`.
- Core quality gates pass at 96.6% line, 80.97% branch and 96.51% function coverage; the deterministic mutation suite kills 8/8 mutants.
- The 100,000-action stress gate passes with zero failures, fixed regression trajectories, corrupt-save rejection and heap-growth-slope evidence.
- Frozen local SolverLab benchmark: 1 suit 96/100 solved (95% Wilson lower bound 90.16%); 2 suits 67/100 (lower bound 57.31%). Both pass the approved >90% and >50% gates. Native `UNSOLVED` and internal timeout share one adapter outcome and remain non-solved attempts in the denominator.
- Known-seed calibration now uses pinned GitHub seed references from SolitaireGDL, Credible-Spider and SolitaireLLMBenchmark. Each upstream integer is domain-separated with repository, commit and suit mode before local generation; only locally solved and independently certificate-validated derived deals enter the quantile thresholds. The current report has 5 solved 1-suit anchors and 2 solved 2-suit anchors, so it improves the score scale but remains provisional and does not satisfy the formal minimum of 8 solved anchors per suit mode.
- The pinned SolverLab probe still returned `UNSOLVED_OR_INTERNAL_TIMEOUT` for five consecutive 4-suit candidates. The isolated Toranpu 2.14.1 search produced more than 110,000 unique solved 2-suit candidates across the expansion ranges; every imported trace passed this repository validator, and the final selection stopped at the 5,000/5,000/1,000/1,000 2-suit caps.
- The factory namespaces use `u64:10000000XXXXXXXX`, `u64:20000000XXXXXXXX` and `u64:40000000XXXXXXXX` for 1, 2 and 4 suits. The low 32 bits preserve the Toranpu source seed and the marker selects the compatible deterministic deal stream. Existing V1 seeds continue using the frozen xoshiro stream.

## Current artifact

- File: `dist/index.html`
- SHA-256: `1571e44290824857e7e3045dba705c64b5d6534e41d13b1e61ec1ba0a6634824`
- Raw size: `3,410,637` bytes
- gzip-9 size: `1,123,237` bytes
- Brotli-11 size: `917,796` bytes
- Runtime modules: `17`
- Embedded certified deals: `12,508`

The expanded 12,508-deal package remains below the 8 MiB bundle budget. The embedded certified-deal JSON and manifest sizes are recorded in `artifacts/build/build-report.json`; a compact binary or integer-array encoding could reduce this further, but would trade away direct auditability and requires a schema migration.

Evidence:

- `artifacts/build/build-report.json`
- `artifacts/release/certified-library-regression.json` (`12,508 / 12,508 PASS`)
- `artifacts/seed-factory/native/generation-report.json`
- `artifacts/seed-factory/toranpu-4s/solution-evidence.json`
- `artifacts/seed-factory/toranpu-4s/import-report.json`
- `artifacts/seed-factory/toranpu-12/solution-evidence.json`
- `artifacts/seed-factory/toranpu-12/import-report.json`
- `artifacts/seed-factory/native/certificate-catalog.json`
- `artifacts/calibration/manual-difficulty-calibration.json`
- `artifacts/seed-factory/benchmark/benchmark-manifest.json`
- `artifacts/seed-factory/benchmark/benchmark-report.json`
- `artifacts/test-quality/core-coverage.json`
- `artifacts/test-quality/core-mutation.json`
- `artifacts/stress/engine-stress.json`
- `artifacts/performance/runtime-performance.json`
- `prototype.html`
- `docs/seed-library-compatibility-matrix.md`

## Verified browser behavior

The exact artifact was exercised in the Codex in-app Chromium browser through the declared `http://127.0.0.1` fallback on macOS on 2026-10-07. Verified flows: first deal, legal and illegal move feedback, timer/step/score transition, hint button and `H` shortcut, stock deal, undo, restart confirmation, suit/difficulty switch confirmation, autosave/resume after reload, statistics and settings, persisted sound preference, desktop layout, 390 × 844 responsive layout, and an empty browser warning/error console. The newly enabled 4-suit path is present in the certified manifest but still needs a separate manual browser pass.

This does not establish the plan's Safari/Chrome/Firefox/Edge `file://` matrix or OS-level physical-offline result.

## Mandatory human gates

Formal difficulty labels require a validation set separate from tuning data and at least two independent blind raters per tested bucket. The current pool keeps balanced bucket slots for publishability, while the 1- and 2-suit classification records now carry the known-seed-calibrated score and band; 4-suit records remain uncalibrated because no solved external anchors are available. The 1- and 2-suit import currently assigns runtime buckets by deterministic solution-length quartiles; this is a reproducible ranking rule, not a validated proxy for perceived difficulty. In particular, a 2-suit deal in the `hard` quartile can still feel easy when its move choices are obvious. Run `npm run calibration:known-seeds` to refresh the provenance-bound calibration report and `npm run calibration:apply-known-seeds` to link its hash into the development classification evidence. The current report has 5 solved 1-suit anchors and 2 solved 2-suit anchors, so labels remain provisional. Run `npm run calibration:prepare` to create a blinded packet, separate response template and answer key under `artifacts/calibration/`. Each packet entry contains a direct `launchQuery`; the resulting calibration view hides the provisional difficulty and local profile/settings controls and does not persist the calibration game or statistics.

The blinded packet now freezes the acceptance thresholds and dispute rule before ratings. The refreshed packet contains 12,508 deals, 125 per 1-suit bucket, 5,000 easy, 5,000 medium, 1,000 hard and 1,000 demon 2-suit deals, and two per 4-suit bucket. The packet can reveal ordering failures, but it is still awaiting independent ratings before establishing a formal production classifier. Two independent human raters must complete the packet; disputed deals require a third independent blind rating. Run `npm run calibration:evaluate -- <rater-1.json> <rater-2.json>` after collecting responses.

The final platform release also requires named human operators to complete `docs/qa_matrix.md` on the target macOS and Windows browsers while the network adapter is physically offline. Tooling in this workspace exposes only the Codex in-app browser and blocks direct `file://` navigation, so those rows remain unverified.

## Reproduction

```sh
npm test
npm run quality:coverage
npm run quality:mutation
npm run stress
npm run benchmark:runtime
npm run calibration:known-seeds
npm run seeds:import-toranpu-4s
npm run seeds:import-toranpu-12
npm run calibration:apply-known-seeds
npm run verify:certificates
npm run build
npm run verify:dist
npm run calibration:prepare
```

`npm run verify` is the combined local gate. Current result: the certificate replay covers 12,508/12,508 deals; coverage, mutation, 100,000-action stress, license/source lock, build, Node runtime proxy and final distribution verification all pass locally. The classification skip remains intentional while blind ratings are pending.
