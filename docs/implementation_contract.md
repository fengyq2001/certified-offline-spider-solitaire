# Implementation contract

This file freezes the first implementation boundary. The two V2.1 plans remain authoritative.

## Runtime

- Modern browser, no network dependency.
- Native ES modules during development; final build is one self-contained `dist/index.html`.
- No `Math.random()` for deal generation or runtime seed selection.
- All persistent records use `(profileId, dealId)`.

## Core API

`src/core/generator.js`

```text
canonicalizeSeed(seed) -> "u64:0123456789abcdef"
createDeck(suitMode) -> Card[104]
shuffleDeck(seed, suitMode) -> Card[104]
generateDeal(seed, suitMode) -> GameState
computeDealId(seed, suitMode, ruleVersion?, generatorVersion?) -> Promise<string>
computeInitialDealHash(state) -> Promise<string>
```

`src/core/engine.js`

```text
getLegalMoves(state) -> Move[]
applyMove(state, move) -> GameState
dealStock(state) -> GameState
restart(state) -> GameState
isWin(state) -> boolean
serializeState(state) -> plain JSON value
deserializeState(value) -> GameState
assertState(state) -> true or throws
```

State changes are immutable. A move is `{type:"move", from, to, count}` or `{type:"deal"}`. Cards have stable `id`, `rank`, `suit`, and `faceUp`.

## Seed artifacts

- Source config: `src/config/seed-pool-config.json`.
- Build manifest: `src/data/resolved-seed-manifest.json`.
- Runtime payload: `src/data/certified-seeds.json`.
- `actualCount` means unique active certified deals after dedupe, tombstone, classifier, certificate and version checks.
- Disabled buckets have zero targets and zero embedded entries.
- Seed-pool quantities are configuration values. The 10,000-seed figure in planning examples is never a runtime or build constant; each bucket may set an independent candidate scan budget, certification target, embedding target and publication minimum.

## Module ownership

- `src/core` contains rules and deterministic generation only.
- `src/solver` contains search, independent replay validation and difficulty classification.
- `src/runtime` contains seed selection, profiles, persistence, saves, statistics and import/export.
- `src/ui` and `src/main.js` contain presentation and browser interaction.
- `scripts` contains build-time generation, bundling and release verification.

No module may silently weaken certification or substitute example pool sizes for resolved configuration.
