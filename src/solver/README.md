# Solver and certification pipeline

This directory contains development-time tooling only. The browser runtime must
not import these modules.

The certification boundary is deliberately split:

- `search.js` explores states through the core engine and emits candidate moves.
- `validator.js` owns a separate Spider transition implementation and replays a
  certificate without calling the engine or solver.
- `difficulty.js` derives versioned metrics from the initial deal and solver run.
- `seed-factory.js` accepts an entry only after search, independent replay and
  classification all succeed.

`scripts/generate-seeds.js` writes resumable development artifacts under
`artifacts/seed-factory/`. It never writes the runtime seed library directly.
Promotion into `src/data` is a separate release step.
