import { StorageError } from "./errors.js";

export const RUNTIME_DB_VERSION = 1;
let probeSequence = 0;
export const RUNTIME_STORES = Object.freeze([
  "profiles",
  "saves",
  "completed",
  "stats",
  "history",
  "preferences",
  "meta",
]);

const COMPOUND_STORES = new Set(["saves", "completed", "stats", "history", "preferences"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertStore(store) {
  if (!RUNTIME_STORES.includes(store)) throw new StorageError("UNKNOWN_STORE", `Unknown runtime store ${store}`);
}

function memoryKey(store, valueOrKey) {
  if (COMPOUND_STORES.has(store)) {
    const key = Array.isArray(valueOrKey) ? valueOrKey : [valueOrKey.profileId, valueOrKey.dealId];
    if (key.length !== 2 || key.some((item) => typeof item !== "string" || !item)) {
      throw new StorageError("INVALID_STORAGE_KEY", `${store} requires [profileId, dealId]`);
    }
    return JSON.stringify(key);
  }
  const key = Array.isArray(valueOrKey) ? valueOrKey[0] : valueOrKey.profileId ?? valueOrKey.key ?? valueOrKey;
  if (typeof key !== "string" || !key) throw new StorageError("INVALID_STORAGE_KEY", `${store} requires a string key`);
  return key;
}

export class MemoryStorage {
  constructor() {
    this.kind = "memory";
    this.persistent = false;
    this.stores = new Map(RUNTIME_STORES.map((name) => [name, new Map()]));
  }

  async get(store, key) {
    assertStore(store);
    return clone(this.stores.get(store).get(memoryKey(store, key)));
  }

  async getAll(store) {
    assertStore(store);
    return Array.from(this.stores.get(store).values(), clone);
  }

  async put(store, value) {
    assertStore(store);
    this.stores.get(store).set(memoryKey(store, value), clone(value));
    return clone(value);
  }

  async delete(store, key) {
    assertStore(store);
    this.stores.get(store).delete(memoryKey(store, key));
  }

  async clear(store) {
    assertStore(store);
    this.stores.get(store).clear();
  }

  async runTransaction(storeNames, _mode, callback) {
    for (const store of storeNames) assertStore(store);
    const snapshots = new Map(storeNames.map((name) => [name, new Map(Array.from(this.stores.get(name), ([key, value]) => [key, clone(value)]))]));
    try {
      return await callback(this);
    } catch (error) {
      for (const [name, snapshot] of snapshots) this.stores.set(name, snapshot);
      throw error;
    }
  }

  close() {}
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new StorageError("IDB_REQUEST_FAILED", "IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new StorageError("IDB_TRANSACTION_FAILED", "IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new StorageError("IDB_TRANSACTION_ABORTED", "IndexedDB transaction aborted"));
  });
}

export function upgradeRuntimeSchema(database, oldVersion = 0) {
  if (oldVersion > RUNTIME_DB_VERSION) {
    throw new StorageError("INDEXEDDB_VERSION_TOO_NEW", `Database version ${oldVersion} is newer than runtime version ${RUNTIME_DB_VERSION}`);
  }
  if (!database.objectStoreNames.contains("profiles")) database.createObjectStore("profiles", { keyPath: "profileId" });
  for (const name of COMPOUND_STORES) {
    if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: ["profileId", "dealId"] });
  }
  if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
}

export class IndexedDbStorage {
  static async open(indexedDBProvider = globalThis.indexedDB, options = {}) {
    if (!indexedDBProvider?.open) throw new StorageError("INDEXEDDB_UNAVAILABLE", "IndexedDB is unavailable");
    const request = indexedDBProvider.open(options.dbName ?? "certified-spider-runtime", options.version ?? RUNTIME_DB_VERSION);
    request.onupgradeneeded = (event) => upgradeRuntimeSchema(request.result, event.oldVersion ?? 0);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        const source = request.error;
        const code = source?.name === "VersionError" ? "INDEXEDDB_VERSION_TOO_NEW" : "INDEXEDDB_OPEN_FAILED";
        reject(new StorageError(code, source?.message ?? "IndexedDB open failed", { cause: source }));
      };
      request.onblocked = () => reject(new StorageError("INDEXEDDB_OPEN_BLOCKED", "IndexedDB open is blocked by another connection"));
    });
    database.onversionchange = () => database.close();
    return new IndexedDbStorage(database);
  }

  constructor(database) {
    this.database = database;
    this.kind = "indexeddb";
    this.persistent = true;
  }

  async #single(store, mode, action) {
    assertStore(store);
    const transaction = this.database.transaction([store], mode);
    const resultPromise = requestResult(action(transaction.objectStore(store)));
    const [result] = await Promise.all([resultPromise, transactionDone(transaction)]);
    return clone(result);
  }

  get(store, key) { return this.#single(store, "readonly", (objectStore) => objectStore.get(key)); }
  getAll(store) { return this.#single(store, "readonly", (objectStore) => objectStore.getAll()); }
  put(store, value) { return this.#single(store, "readwrite", (objectStore) => objectStore.put(clone(value))); }
  delete(store, key) { return this.#single(store, "readwrite", (objectStore) => objectStore.delete(key)); }
  clear(store) { return this.#single(store, "readwrite", (objectStore) => objectStore.clear()); }

  async runTransaction(storeNames, mode, callback) {
    for (const store of storeNames) assertStore(store);
    const transaction = this.database.transaction(storeNames, mode);
    const facade = {
      get: (store, key) => requestResult(transaction.objectStore(store).get(key)).then(clone),
      getAll: (store) => requestResult(transaction.objectStore(store).getAll()).then(clone),
      put: (store, value) => requestResult(transaction.objectStore(store).put(clone(value))).then(() => clone(value)),
      delete: (store, key) => requestResult(transaction.objectStore(store).delete(key)),
      clear: (store) => requestResult(transaction.objectStore(store).clear()),
    };
    try {
      const result = await callback(facade);
      await transactionDone(transaction);
      return result;
    } catch (error) {
      try { transaction.abort(); } catch {}
      throw error;
    }
  }

  close() { this.database.close(); }
}

export class ResilientStorage {
  constructor(primary, options = {}) {
    if (!primary) throw new StorageError("STORAGE_REQUIRED", "ResilientStorage requires a primary adapter");
    this.primary = primary;
    this.memory = options.memory ?? new MemoryStorage();
    this.capability = options.capability ?? { available: true, persistent: true, kind: primary.kind, reason: null };
    this.onFallback = options.onFallback ?? (() => {});
    this.fallbackActive = false;
  }

  get kind() { return this.fallbackActive ? this.memory.kind : this.primary.kind; }
  get persistent() { return !this.fallbackActive && this.primary.persistent; }

  async hydrate() {
    try {
      for (const store of RUNTIME_STORES) {
        const records = await this.primary.getAll(store);
        await this.memory.clear(store);
        for (const record of records) await this.memory.put(store, record);
      }
    } catch (error) {
      this.#activateFallback(error);
    }
    return this;
  }

  #activateFallback(error) {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    try { this.primary.close(); } catch {}
    this.capability.available = true;
    this.capability.persistent = false;
    this.capability.kind = "memory";
    this.capability.reason = error?.code ?? error?.name ?? error?.message ?? "PERSISTENCE_FAILED";
    try { this.onFallback(this.capability, error); } catch {}
  }

  async #operate(store, valueOrKey, primaryOperation, memoryOperation) {
    assertStore(store);
    if (valueOrKey !== undefined) memoryKey(store, valueOrKey);
    if (this.fallbackActive) return memoryOperation();
    try {
      const result = await primaryOperation();
      await memoryOperation();
      return result;
    } catch (error) {
      this.#activateFallback(error);
      return memoryOperation();
    }
  }

  get(store, key) {
    return this.#operate(store, key, () => this.primary.get(store, key), () => this.memory.get(store, key));
  }

  getAll(store) {
    return this.#operate(store, undefined, () => this.primary.getAll(store), () => this.memory.getAll(store));
  }

  put(store, value) {
    return this.#operate(store, value, () => this.primary.put(store, value), () => this.memory.put(store, value));
  }

  delete(store, key) {
    return this.#operate(store, key, () => this.primary.delete(store, key), () => this.memory.delete(store, key));
  }

  clear(store) {
    return this.#operate(store, undefined, () => this.primary.clear(store), () => this.memory.clear(store));
  }

  async runTransaction(storeNames, mode, callback) {
    for (const store of storeNames) assertStore(store);
    if (this.fallbackActive) return this.memory.runTransaction(storeNames, mode, callback);
    let callbackError = null;
    const journal = [];
    const storageFailures = new WeakSet();
    const persistentCall = async (operation) => {
      try {
        return await operation();
      } catch (error) {
        if (error && typeof error === "object") storageFailures.add(error);
        throw error;
      }
    };
    try {
      const result = await this.primary.runTransaction(storeNames, mode, async (transaction) => {
        const facade = {
          get: (store, key) => persistentCall(() => transaction.get(store, key)),
          getAll: (store) => persistentCall(() => transaction.getAll(store)),
          put: async (store, value) => {
            const output = await persistentCall(() => transaction.put(store, value));
            journal.push(["put", store, clone(value)]);
            return output;
          },
          delete: async (store, key) => {
            const output = await persistentCall(() => transaction.delete(store, key));
            journal.push(["delete", store, clone(key)]);
            return output;
          },
          clear: async (store) => {
            const output = await persistentCall(() => transaction.clear(store));
            journal.push(["clear", store]);
            return output;
          },
        };
        try {
          return await callback(facade);
        } catch (error) {
          if (!storageFailures.has(error)) callbackError = error;
          throw error;
        }
      });
      await this.memory.runTransaction(storeNames, mode, async (transaction) => {
        for (const [operation, store, value] of journal) await transaction[operation](store, value);
      });
      return result;
    } catch (error) {
      if (callbackError === error) throw error;
      this.#activateFallback(error);
      return this.memory.runTransaction(storeNames, mode, callback);
    }
  }

  close() {
    try { this.primary.close(); } catch {}
    this.memory.close();
  }
}

export async function probeStorage(storage) {
  probeSequence += 1;
  const key = `probe:${Date.now()}:${probeSequence}`;
  const record = { key, value: "ok" };
  try {
    await storage.put("meta", record);
    const restored = await storage.get("meta", key);
    await storage.delete("meta", key);
    if (restored?.value !== "ok") throw new Error("probe value did not round-trip");
    return { available: true, persistent: storage.persistent, kind: storage.kind, reason: null };
  } catch (error) {
    return { available: false, persistent: false, kind: storage.kind, reason: error?.message ?? String(error) };
  }
}

export async function openRuntimeStorage(options = {}) {
  try {
    const storage = await IndexedDbStorage.open(options.indexedDB ?? globalThis.indexedDB, options);
    const capability = await probeStorage(storage);
    if (!capability.available) {
      storage.close();
      throw new StorageError("INDEXEDDB_PROBE_FAILED", capability.reason);
    }
    const resilient = new ResilientStorage(storage, { capability, onFallback: options.onFallback });
    await resilient.hydrate();
    return { storage: resilient, capability };
  } catch (error) {
    const storage = new MemoryStorage();
    const capability = {
      available: true,
      persistent: false,
      kind: "memory",
      reason: error?.code ?? error?.message ?? "INDEXEDDB_UNAVAILABLE",
    };
    try { options.onFallback?.(capability, error); } catch {}
    return { storage, capability };
  }
}
