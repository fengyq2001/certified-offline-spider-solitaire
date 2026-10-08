import { RuntimeDataError } from "./errors.js";
import { createGuestProfile, createLocalProfile, GUEST_PROFILE_ID, renameProfile } from "./profiles.js";
import { createEmptyStats, recordGameFinished, recordGameStarted, statsView } from "./statistics.js";

const PROFILE_DATA_STORES = ["saves", "completed", "stats", "history", "preferences"];
const CURRENT_PROFILE_KEY = "currentProfileId";
const PREFERENCES_DEAL_ID = "__preferences__";

function requireId(value, label) {
  if (typeof value !== "string" || !value) throw new RuntimeDataError("INVALID_IDENTITY", `${label} is required`);
  return value;
}

function identity(profileId, dealId) {
  return [requireId(profileId, "profileId"), requireId(dealId, "dealId")];
}

function bucketId(suitMode, difficulty) {
  if (typeof suitMode !== "string" || typeof difficulty !== "string") throw new RuntimeDataError("INVALID_BUCKET", "suitMode and difficulty are required");
  return `${suitMode}.${difficulty}`;
}

function matchesProfile(record, profileId) {
  return record.profileId === profileId;
}

export class RuntimeRepository {
  constructor(storage, options = {}) {
    if (!storage) throw new RuntimeDataError("STORAGE_REQUIRED", "RuntimeRepository requires a storage adapter");
    this.storage = storage;
    this.now = options.now ?? (() => Date.now());
    this.crypto = options.crypto;
  }

  async initialize() {
    let guest = await this.storage.get("profiles", GUEST_PROFILE_ID);
    if (!guest) {
      guest = createGuestProfile(this.now());
      await this.storage.put("profiles", guest);
    }
    const current = await this.storage.get("meta", CURRENT_PROFILE_KEY);
    if (!current || !(await this.storage.get("profiles", current.value))) {
      await this.storage.put("meta", { key: CURRENT_PROFILE_KEY, value: GUEST_PROFILE_ID });
    }
    return this.getCurrentProfile();
  }

  listProfiles() { return this.storage.getAll("profiles"); }
  getProfile(profileId) { return this.storage.get("profiles", requireId(profileId, "profileId")); }

  async getCurrentProfile() {
    const current = await this.storage.get("meta", CURRENT_PROFILE_KEY);
    return current ? this.getProfile(current.value) : null;
  }

  async setCurrentProfile(profileId) {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new RuntimeDataError("PROFILE_NOT_FOUND", `Profile ${profileId} does not exist`);
    await this.storage.put("meta", { key: CURRENT_PROFILE_KEY, value: profileId });
    return profile;
  }

  async createProfile(name, options = {}) {
    const profile = createLocalProfile(name, { ...options, now: this.now(), crypto: options.crypto ?? this.crypto });
    if (await this.getProfile(profile.profileId)) throw new RuntimeDataError("PROFILE_EXISTS", `Profile ${profile.profileId} already exists`);
    await this.storage.put("profiles", profile);
    return profile;
  }

  async renameProfile(profileId, name) {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new RuntimeDataError("PROFILE_NOT_FOUND", `Profile ${profileId} does not exist`);
    const updated = renameProfile(profile, name, this.now());
    await this.storage.put("profiles", updated);
    return updated;
  }

  async deleteProfile(profileId) {
    requireId(profileId, "profileId");
    if (profileId === GUEST_PROFILE_ID) throw new RuntimeDataError("GUEST_DELETE_FORBIDDEN", "The Guest profile cannot be deleted");
    const profile = await this.getProfile(profileId);
    if (!profile) return false;
    await this.storage.runTransaction(["profiles", "meta", ...PROFILE_DATA_STORES], "readwrite", async (transaction) => {
      for (const store of PROFILE_DATA_STORES) {
        const records = await transaction.getAll(store);
        for (const record of records) if (matchesProfile(record, profileId)) await transaction.delete(store, identity(record.profileId, record.dealId));
      }
      await transaction.delete("profiles", profileId);
      const current = await transaction.get("meta", CURRENT_PROFILE_KEY);
      if (current?.value === profileId) await transaction.put("meta", { key: CURRENT_PROFILE_KEY, value: GUEST_PROFILE_ID });
    });
    return true;
  }

  async saveGame(record) {
    const [profileId, dealId] = identity(record?.profileId, record?.dealId);
    const normalized = {
      schemaVersion: 1,
      ...structuredClone(record),
      profileId,
      dealId,
      updatedAt: this.now(),
    };
    if (!normalized.ruleVersion || !normalized.generatorVersion || !normalized.seedLibraryVersion) {
      throw new RuntimeDataError("SAVE_VERSION_REQUIRED", "Save requires ruleVersion, generatorVersion and seedLibraryVersion");
    }
    await this.storage.put("saves", normalized);
    return normalized;
  }

  getSave(profileId, dealId) { return this.storage.get("saves", identity(profileId, dealId)); }
  deleteSave(profileId, dealId) { return this.storage.delete("saves", identity(profileId, dealId)); }

  async getLatestSave(profileId) {
    requireId(profileId, "profileId");
    const records = (await this.storage.getAll("saves")).filter((record) => matchesProfile(record, profileId));
    return records.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }

  async markCompleted(record) {
    const [profileId, dealId] = identity(record?.profileId, record?.dealId);
    const existing = await this.storage.get("completed", [profileId, dealId]);
    const completed = {
      schemaVersion: 1,
      ...structuredClone(record),
      profileId,
      dealId,
      completedAt: existing?.completedAt ?? record.completedAt ?? this.now(),
      updatedAt: this.now(),
    };
    await this.storage.put("completed", completed);
    return completed;
  }

  unmarkCompleted(profileId, dealId) { return this.storage.delete("completed", identity(profileId, dealId)); }

  async listCompleted(profileId, filter = {}) {
    requireId(profileId, "profileId");
    return (await this.storage.getAll("completed")).filter((record) => (
      matchesProfile(record, profileId)
      && (filter.suitMode == null || record.suitMode === filter.suitMode)
      && (filter.difficulty == null || record.difficulty === filter.difficulty)
    ));
  }

  async completedDealIds(profileId, filter = {}) {
    return new Set((await this.listCompleted(profileId, filter)).map((record) => record.dealId));
  }

  async resetCompleted(profileId, filter = {}) {
    const records = await this.listCompleted(profileId, filter);
    await this.storage.runTransaction(["completed"], "readwrite", async (transaction) => {
      for (const record of records) await transaction.delete("completed", identity(record.profileId, record.dealId));
    });
    return records.length;
  }

  async gameStarted(profileId, suitMode, difficulty) {
    const id = bucketId(suitMode, difficulty);
    const key = [profileId, `stats:${id}`];
    const current = await this.storage.get("stats", key) ?? createEmptyStats(profileId, id);
    const updated = recordGameStarted(current, this.now());
    await this.storage.put("stats", updated);
    return updated;
  }

  async gameFinished(record) {
    const [profileId, dealId] = identity(record?.profileId, record?.dealId);
    const id = bucketId(record.suitMode, record.difficulty);
    const statsKey = [profileId, `stats:${id}`];
    const current = await this.storage.get("stats", statsKey) ?? createEmptyStats(profileId, id);
    const updated = recordGameFinished(current, record, this.now());
    const oldHistory = await this.storage.get("history", [profileId, dealId]);
    const attempt = { ...structuredClone(record), profileId, dealId, finishedAt: record.finishedAt ?? this.now() };
    const history = {
      schemaVersion: 1,
      profileId,
      dealId,
      suitMode: record.suitMode,
      difficulty: record.difficulty,
      attempts: [...(oldHistory?.attempts ?? []), attempt].slice(-20),
      updatedAt: this.now(),
    };
    await this.storage.runTransaction(["stats", "history", ...(record.won ? ["completed"] : [])], "readwrite", async (transaction) => {
      await transaction.put("stats", updated);
      await transaction.put("history", history);
      if (record.won) await transaction.put("completed", {
        schemaVersion: 1,
        profileId,
        dealId,
        suitMode: record.suitMode,
        difficulty: record.difficulty,
        completedAt: oldHistory?.completedAt ?? this.now(),
        updatedAt: this.now(),
      });
    });
    return updated;
  }

  async getStats(profileId, suitMode, difficulty, options = {}) {
    const id = bucketId(suitMode, difficulty);
    const stats = await this.storage.get("stats", [profileId, `stats:${id}`]) ?? createEmptyStats(profileId, id);
    const completed = await this.listCompleted(profileId, { suitMode, difficulty });
    return statsView(stats, completed.length, options.totalSeeds == null ? null : Math.max(0, options.totalSeeds - completed.length));
  }

  async listRecentGames(profileId, limit = 20) {
    const records = (await this.storage.getAll("history")).filter((record) => matchesProfile(record, profileId));
    return records.flatMap((record) => record.attempts ?? []).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, limit);
  }

  async getPreferences(profileId) {
    return (await this.storage.get("preferences", identity(profileId, PREFERENCES_DEAL_ID)))?.value ?? {};
  }

  async setPreferences(profileId, value) {
    const record = { profileId, dealId: PREFERENCES_DEAL_ID, value: structuredClone(value), updatedAt: this.now() };
    await this.storage.put("preferences", record);
    return record.value;
  }
}

export class AutosaveController {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.serializeState = options.serializeState ?? ((state) => structuredClone(state));
    this.onError = options.onError ?? (() => {});
    this.pending = Promise.resolve();
  }

  saveAfterLegalAction(context, state) {
    const record = { ...context, gameState: this.serializeState(state) };
    this.pending = this.pending.catch(() => {}).then(() => this.repository.saveGame(record));
    this.pending.catch((error) => this.onError(error));
    return this.pending;
  }

  async resume(profileId, dealId = null) {
    return dealId ? this.repository.getSave(profileId, dealId) : this.repository.getLatestSave(profileId);
  }

  flush() { return this.pending; }
}

