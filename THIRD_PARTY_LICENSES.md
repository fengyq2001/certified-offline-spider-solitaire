# Third-party license register

The current implementation does not copy source code, assets, seed pools or deal data from the reference repositories below. They are research and benchmark references only unless a future change records an exact commit, copied files, license text, attribution, notices and modifications here.

| Project | Observed license / status | Current use |
|---|---|---|
| `tomwillow/Credible-Spider` | No explicit license observed at repository root on 2026-10-05 | Ideas only; no code or data copied. |
| `jsgrrchg/SolverLab` | Apache-2.0 | Rust solver core vendored under `tools/solverlab` at commit `cc21d7e9345cce0506fad5c64ddfe7f833f0c51f`; build-time Seed Factory only. Added `src/bin/spider_cli.rs` adapter. Upstream code and local adapter are excluded from the browser runtime. License is preserved at `tools/solverlab/LICENSE`. |
| `thecharlieblake/Solvitaire` | GPL-2.0 | Benchmark reference only; not linked, copied or distributed. |
| `johnmorrisdotca/toranpu` | MIT | Isolated development-only 1/2/4-suit candidate search (`@johnmorrisdotca/toranpu@2.14.1`); the compatible seeded-deal stream is reimplemented in the product generator, while only generated seed evidence and locally revalidated certificates are retained. No package code or runtime is shipped. |
| `skeeto/solitaire` | Unlicense | Architecture reference only; its rules, seeds and deals are not certification evidence. |
| `lklynet/spider-solitaire` | MIT | UI/state reference only; not currently vendored. |
| `iambb5445/SolitaireGDL` | No explicit license observed in the pinned repository metadata | Documented seed examples (`0` and `42`) only; no code, board or dataset copied. |
| `iambb5445/SolitaireLLMBenchmark` | License status unverified in the pinned repository metadata | Filename-embedded Spider seed anchors only; no dataset content copied. |

The checked-in `src/data/github-known-seeds.json` contains provenance-only references to
the pinned commits above. `scripts/generate-known-seed-calibration.js` derives a new
domain-separated runtime seed before generating any local board, so an upstream integer
is never treated as the same board in this product. The generated calibration report is
development evidence and is not shipped in the browser payload.

The release build must fail if vendored third-party files exist without a corresponding locked commit and notice entry.
