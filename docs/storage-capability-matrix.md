# Storage capability matrix

This matrix separates automated adapter evidence from browser evidence. Blank browser rows remain **UNVERIFIED** until the exact release artifact is tested on the named browser and OS.

## Automated evidence

Run:

```sh
node --test tests/runtime/*.test.js
```

The runtime suite verifies:

- IndexedDB unavailable at startup selects `MemoryStorage` and reports `persistent: false`.
- A persistent write failure after startup closes the failed adapter, mutates the live capability state, and continues through a hydrated `MemoryStorage` instance.
- A storage transaction failure retries the storage-only transaction atomically in memory.
- An application callback error rolls back and does not trigger storage fallback.
- Schema creation is idempotent and creates all required stores.
- A database newer than the runtime is rejected and safely downgraded to memory mode.
- Backup import is validated before mutation and restore transactions roll back on failure.

These tests do not establish browser persistence behavior under `file://`.

## Required browser matrix

| Browser path | Exact browser + OS | Create/read/write | Same-path reopen | Schema upgrade | Interrupted transaction | Quota/private failure | Rename | Move directory | Memory fallback warning | JSON recovery | Evidence | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Safari macOS `file://` |  |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Chrome macOS `file://` |  |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Firefox macOS `file://` |  |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Chrome Windows `file://` |  |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Firefox Windows `file://` |  |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Edge Windows `file://` |  |  |  |  |  |  |  |  |  |  |  | UNVERIFIED |
| Declared local HTTP fallback |  |  |  |  |  |  | N/A | N/A |  |  |  | UNVERIFIED |

For every completed row record the artifact SHA-256, browser version, OS version, test date, operator, and screenshot or log path. Moving or renaming the HTML must be reported independently because a browser may assign a different storage origin. A failed persistent operation must visibly change the UI to temporary-memory mode, avoid any “safely saved” claim, and keep JSON export available.

## Seed Library upgrade checks

Library V2 acceptance also requires automated and browser-level confirmation that:

- V1 completed `dealId` values remain recognized after upgrade.
- Disabled and superseded deals remain visible in history but cannot be selected.
- Completion of a superseded deal does not complete its replacement.
- `classificationOverride` changes only the effective bucket; `dealId` and original classification remain available for audit.
- Supersession cycles, missing targets, and chains ending in disabled deals fail closed.
