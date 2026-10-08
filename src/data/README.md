# Seed build artifacts

`certified-seeds.json` is the only runtime seed payload. It contains active,
independently validated deals only. `resolved-seed-manifest.json` binds that
payload to the source pool configuration, version fields, bucket offsets,
counts and SHA-256 hashes.

Hashes use lowercase hexadecimal SHA-256 over UTF-8 canonical JSON. Canonical
JSON sorts every object key lexicographically, preserves array order, uses no
insignificant whitespace and rejects non-finite numbers. `payloadHash` hashes
the complete payload. `libraryHash` hashes the payload's normalized `deals`
array containing exactly `dealId`, `canonicalSeed`, `initialDealHash`,
`suitMode`, `difficulty` and `status`.

`startOffset` is an entry offset into `payload.deals`, not a byte offset. Deals
must be contiguous in the same bucket order as `SeedPoolConfig.buckets`.
`encodedBytes` is the sum of canonical UTF-8 bytes of the normalized deal
entries in that bucket; container punctuation is reported separately as
`seedPayloadBytes` in the build report.

The checked-in empty artifacts define the schema but are intentionally not
publishable under the current config. The build stays fail-closed until the
Seed Factory replaces both files with a hash-consistent payload and manifest
that satisfy every enabled bucket's publication predicate.
