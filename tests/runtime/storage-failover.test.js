import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryStorage,
  ResilientStorage,
  RUNTIME_DB_VERSION,
  RUNTIME_STORES,
  openRuntimeStorage,
  upgradeRuntimeSchema,
} from "../../src/runtime/storage.js";
import { StorageError } from "../../src/runtime/errors.js";

class ControllablePersistentStorage extends MemoryStorage {
  constructor() {
    super();
    this.kind = "indexeddb";
    this.persistent = true;
    this.failOperation = null;
    this.closed = false;
  }

  async put(store, value) {
    if (this.failOperation === "put") throw new StorageError("IDB_WRITE_FAILED", "forced persistent write failure");
    return super.put(store, value);
  }

  async runTransaction(storeNames, mode, callback) {
    if (this.failOperation !== "transaction-put") return super.runTransaction(storeNames, mode, callback);
    return callback({
      get: (store, key) => super.get(store, key),
      getAll: (store) => super.getAll(store),
      put: async () => { throw new StorageError("IDB_TRANSACTION_FAILED", "forced transaction write failure"); },
      delete: (store, key) => super.delete(store, key),
      clear: (store) => super.clear(store),
    });
  }

  close() { this.closed = true; }
}

test("runtime persistence failure switches the live adapter to hydrated MemoryStorage", async () => {
  const primary = new ControllablePersistentStorage();
  await primary.put("profiles", { profileId: "existing", name: "Existing" });
  const capability = { available: true, persistent: true, kind: "indexeddb", reason: null };
  const fallbacks = [];
  const storage = new ResilientStorage(primary, {
    capability,
    onFallback: (state, error) => fallbacks.push({ state: { ...state }, code: error.code }),
  });
  await storage.hydrate();

  primary.failOperation = "put";
  await storage.put("profiles", { profileId: "new", name: "New" });

  assert.equal(storage.kind, "memory");
  assert.equal(storage.persistent, false);
  assert.equal(primary.closed, true);
  assert.equal(capability.kind, "memory");
  assert.equal(capability.persistent, false);
  assert.equal(capability.reason, "IDB_WRITE_FAILED");
  assert.equal((await storage.get("profiles", "existing")).name, "Existing");
  assert.equal((await storage.get("profiles", "new")).name, "New");
  assert.equal(fallbacks.length, 1);
});

test("persistent transaction failure retries atomically in memory", async () => {
  const primary = new ControllablePersistentStorage();
  const capability = { available: true, persistent: true, kind: "indexeddb", reason: null };
  const storage = new ResilientStorage(primary, { capability });
  await storage.hydrate();
  primary.failOperation = "transaction-put";

  await storage.runTransaction(["profiles", "meta"], "readwrite", async (transaction) => {
    await transaction.put("profiles", { profileId: "alice", name: "Alice" });
    await transaction.put("meta", { key: "currentProfileId", value: "alice" });
  });

  assert.equal(storage.kind, "memory");
  assert.equal((await storage.get("profiles", "alice")).name, "Alice");
  assert.equal((await storage.get("meta", "currentProfileId")).value, "alice");
});

test("application callback errors roll back without disabling healthy persistence", async () => {
  const primary = new ControllablePersistentStorage();
  const capability = { available: true, persistent: true, kind: "indexeddb", reason: null };
  const storage = new ResilientStorage(primary, { capability });
  await storage.hydrate();

  await assert.rejects(
    storage.runTransaction(["profiles"], "readwrite", async (transaction) => {
      await transaction.put("profiles", { profileId: "partial", name: "Partial" });
      throw new Error("application rejected transaction");
    }),
    /application rejected transaction/,
  );

  assert.equal(storage.kind, "indexeddb");
  assert.equal(storage.persistent, true);
  assert.equal(await storage.get("profiles", "partial"), undefined);
});

test("schema upgrade creates every store idempotently and rejects a newer database", () => {
  const names = new Set();
  const database = {
    objectStoreNames: { contains: (name) => names.has(name) },
    createObjectStore(name) { names.add(name); return {}; },
  };
  upgradeRuntimeSchema(database, 0);
  assert.deepEqual([...names].sort(), [...RUNTIME_STORES].sort());
  upgradeRuntimeSchema(database, RUNTIME_DB_VERSION);
  assert.deepEqual([...names].sort(), [...RUNTIME_STORES].sort());
  assert.throws(
    () => upgradeRuntimeSchema(database, RUNTIME_DB_VERSION + 1),
    { code: "INDEXEDDB_VERSION_TOO_NEW" },
  );
});

test("opening a newer IndexedDB version downgrades safely to memory", async () => {
  const indexedDB = {
    open() {
      const request = { error: { name: "VersionError", message: "newer database" } };
      queueMicrotask(() => request.onerror());
      return request;
    },
  };
  const result = await openRuntimeStorage({ indexedDB });
  assert.equal(result.storage.kind, "memory");
  assert.equal(result.capability.persistent, false);
  assert.equal(result.capability.reason, "INDEXEDDB_VERSION_TOO_NEW");
});
