# Version specification

| Field | Initial value | Compatibility rule |
|---|---:|---|
| `ruleVersion` | `1.0` | Increment when legal states or moves change. |
| `generatorVersion` | `1` | Frozen after cross-runtime golden fixtures pass; increment for any Seed-to-Deal change. |
| `saveVersion` | `1` | Migrate atomically or reject while preserving the original. |
| `seedLibraryVersion` | `1` | Append-only normal records; corrections use tombstones. |
| `manifestSchemaVersion` | `1` | Runtime loads only an explicitly supported range. |
| `payloadSchemaVersion` | `1` | Hash and offsets are verified before selection. |

Canonical seeds are `u64:` followed by exactly sixteen lowercase hexadecimal digits. JavaScript `Number` must never carry a complete seed.

```text
dealId = SHA-256(canonicalSerialize(ruleVersion, generatorVersion, suitMode, canonicalSeed))
```

`initialDealHash` separately hashes the initial 104-card order, face-up mask and stock boundaries. Completion history uses `dealId`; content verification and duplicate detection use `initialDealHash`.

The V1 release replaces the complete self-contained HTML. A standalone seed pack format is unsupported until its schema, integrity, compatibility, merge and rollback rules are frozen.
