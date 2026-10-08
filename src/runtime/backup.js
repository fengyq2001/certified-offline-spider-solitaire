import { CompatibilityError, RuntimeDataError } from "./errors.js";
import { RUNTIME_STORES } from "./storage.js";

export const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_STORES = ["profiles", "saves", "completed", "stats", "history", "preferences", "meta"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new RuntimeDataError("INVALID_BACKUP", `${label} is required`);
  return value;
}

export function migrateSaveRecord(input) {
  if (!isObject(input)) throw new RuntimeDataError("INVALID_SAVE", "Save record must be an object");
  const version = input.schemaVersion ?? input.saveVersion ?? 0;
  if (version > 1) throw new CompatibilityError("SAVE_SCHEMA_TOO_NEW", `Save schema ${version} is newer than this runtime`);
  if (version === 1) return structuredClone(input);
  return {
    ...structuredClone(input),
    schemaVersion: 1,
    profileId: input.profileId ?? input.userId,
    dealId: input.dealId ?? input.seedId,
    gameState: input.gameState ?? input.board,
  };
}

function migrateV0(input) {
  const data = input.data ?? input;
  return {
    format: "certified-spider-backup",
    schemaVersion: 1,
    exportedAt: input.exportedAt ?? 0,
    runtimeVersion: input.runtimeVersion ?? "0.0.0",
    data: {
      profiles: structuredClone(data.profiles ?? data.users ?? []),
      saves: (data.saves ?? data.saveGames ?? []).map(migrateSaveRecord),
      completed: structuredClone(data.completed ?? data.completedSeeds ?? []),
      stats: structuredClone(data.stats ?? data.statistics ?? []),
      history: structuredClone(data.history ?? data.gameHistory ?? []),
      preferences: structuredClone(data.preferences ?? []),
      meta: structuredClone(data.meta ?? []),
    },
  };
}

export function migrateBackup(input) {
  if (!isObject(input)) throw new RuntimeDataError("INVALID_BACKUP", "Backup must be an object");
  const version = input.schemaVersion ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new RuntimeDataError("INVALID_BACKUP", "Backup schemaVersion is invalid");
  if (version > BACKUP_SCHEMA_VERSION) {
    throw new CompatibilityError("BACKUP_SCHEMA_TOO_NEW", `Backup schema ${version} is newer than supported ${BACKUP_SCHEMA_VERSION}`);
  }
  if (version === 0) return migrateV0(input);
  return structuredClone(input);
}

function validateRecordIdentity(record, store) {
  if (!isObject(record)) throw new RuntimeDataError("INVALID_BACKUP", `${store} contains a non-object record`);
  if (store === "profiles") return requireString(record.profileId, `${store}.profileId`);
  if (store === "meta") return requireString(record.key, `${store}.key`);
  requireString(record.profileId, `${store}.profileId`);
  requireString(record.dealId, `${store}.dealId`);
  return `${record.profileId}\u0000${record.dealId}`;
}

export function validateBackup(input, options = {}) {
  const backup = migrateBackup(typeof input === "string" ? JSON.parse(input) : input);
  if (backup.format !== "certified-spider-backup") throw new RuntimeDataError("INVALID_BACKUP_FORMAT", "Unrecognized backup format");
  if (!isObject(backup.data)) throw new RuntimeDataError("INVALID_BACKUP", "Backup data is missing");
  const profileIds = new Set();
  for (const store of BACKUP_STORES) {
    if (!Array.isArray(backup.data[store])) throw new RuntimeDataError("INVALID_BACKUP", `Backup ${store} must be an array`);
    const identities = new Set();
    for (let index = 0; index < backup.data[store].length; index += 1) {
      let record = backup.data[store][index];
      if (store === "saves") {
        record = migrateSaveRecord(record);
        backup.data[store][index] = record;
        if (options.ruleVersion && record.ruleVersion !== options.ruleVersion) throw new CompatibilityError("RULE_VERSION_MISMATCH", `Save ${record.dealId} uses an incompatible rule version`);
        if (options.generatorVersion && record.generatorVersion !== options.generatorVersion) throw new CompatibilityError("GENERATOR_VERSION_MISMATCH", `Save ${record.dealId} uses an incompatible generator version`);
      }
      const id = validateRecordIdentity(record, store);
      if (identities.has(id)) throw new RuntimeDataError("DUPLICATE_BACKUP_RECORD", `${store} contains duplicate key ${id}`);
      identities.add(id);
      if (store === "profiles") profileIds.add(record.profileId);
    }
  }
  for (const store of BACKUP_STORES.filter((name) => !["profiles", "meta"].includes(name))) {
    for (const record of backup.data[store]) {
      if (!profileIds.has(record.profileId)) throw new RuntimeDataError("ORPHAN_BACKUP_RECORD", `${store} references missing profile ${record.profileId}`);
    }
  }
  return backup;
}

export async function exportBackup(repositoryOrStorage, options = {}) {
  const storage = repositoryOrStorage.storage ?? repositoryOrStorage;
  const data = {};
  for (const store of BACKUP_STORES) data[store] = await storage.getAll(store);
  return {
    format: "certified-spider-backup",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: options.now ?? Date.now(),
    runtimeVersion: options.runtimeVersion ?? "1.0.0",
    data,
  };
}

export async function exportBackupJson(repositoryOrStorage, options = {}) {
  return JSON.stringify(await exportBackup(repositoryOrStorage, options), null, 2);
}

export async function importBackup(repositoryOrStorage, input, options = {}) {
  const storage = repositoryOrStorage.storage ?? repositoryOrStorage;
  const backup = validateBackup(input, options);
  const mode = options.mode ?? "replace";
  if (!new Set(["replace", "merge"]).has(mode)) throw new RuntimeDataError("INVALID_IMPORT_MODE", `Unsupported import mode ${mode}`);
  await storage.runTransaction(RUNTIME_STORES, "readwrite", async (transaction) => {
    if (mode === "replace") for (const store of BACKUP_STORES) await transaction.clear(store);
    for (const store of BACKUP_STORES) {
      for (const record of backup.data[store]) await transaction.put(store, record);
    }
  });
  return { imported: Object.fromEntries(BACKUP_STORES.map((store) => [store, backup.data[store].length])), schemaVersion: backup.schemaVersion };
}

