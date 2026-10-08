# SolverLab source record

- Upstream: `https://github.com/jsgrrchg/SolverLab`
- Locked commit: `cc21d7e9345cce0506fad5c64ddfe7f833f0c51f`
- Retrieved: `2026-10-05`
- License: Apache-2.0; see `LICENSE`
- Included scope: `solver-core-rs`
- Local modification: `solver-core-rs/src/bin/spider_cli.rs` adds a line-oriented build-time adapter. It accepts a project-generated deck and returns a proposed move list. It does not certify a deal.
- Certification boundary: every proposed solution is replayed by `src/solver/validator.js`, which does not use SolverLab state-transition code.
- Distribution boundary: this source is a development tool and is not bundled into `dist/index.html`.
