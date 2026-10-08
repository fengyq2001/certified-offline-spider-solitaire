import test from "node:test";
import assert from "node:assert/strict";
import {
  AutosaveController,
  GUEST_PROFILE_ID,
  MemoryStorage,
  RuntimeRepository,
  exportBackup,
  importBackup,
  openRuntimeStorage,
  validateBackup,
} from "../../src/runtime/index.js";

function saveContext(profileId, dealId = "deal-1") {
  return {
    profileId,
    dealId,
    canonicalSeed: "u64:0000000000000001",
    suitMode: "1s",
    difficulty: "easy",
    ruleVersion: "1.0",
    generatorVersion: "1",
    seedLibraryVersion: "1.0.0",
  };
}

test("profiles isolate saves, completions and preferences", async () => {
  let now = 100;
  const repository = new RuntimeRepository(new MemoryStorage(), { now: () => now++ });
  assert.equal((await repository.initialize()).profileId, GUEST_PROFILE_ID);
  const alice = await repository.createProfile("Alice", { profileId: "alice" });
  const bob = await repository.createProfile("Bob", { profileId: "bob" });
  await repository.saveGame({ ...saveContext(alice.profileId), gameState: { moves: 1 } });
  await repository.markCompleted({ ...saveContext(alice.profileId), completedAt: now++ });
  await repository.setPreferences(alice.profileId, { sound: false });
  assert.equal((await repository.getLatestSave(bob.profileId)), null);
  assert.equal((await repository.completedDealIds(bob.profileId)).size, 0);
  assert.deepEqual(await repository.getPreferences(bob.profileId), {});
  assert.deepEqual(await repository.getPreferences(alice.profileId), { sound: false });
});

test("profiles can be renamed and deleted without leaving user data behind", async () => {
  let now = 500;
  const repository = new RuntimeRepository(new MemoryStorage(), { now: () => now++ });
  await repository.initialize();
  const profile = await repository.createProfile("  Ada  ", { profileId: "ada" });
  assert.equal(profile.name, "Ada");
  await repository.setCurrentProfile(profile.profileId);
  await repository.saveGame({ ...saveContext(profile.profileId, "deal-ada"), gameState: { tableau: [1, 2] } });
  await repository.markCompleted({ ...saveContext(profile.profileId, "deal-ada"), completedAt: now++ });
  await repository.setPreferences(profile.profileId, { sound: true });
  await repository.gameStarted(profile.profileId, "1s", "easy");
  const renamed = await repository.renameProfile(profile.profileId, "Ada Lovelace");
  assert.equal(renamed.name, "Ada Lovelace");
  assert.equal((await repository.getCurrentProfile()).name, "Ada Lovelace");
  assert.equal(await repository.deleteProfile(profile.profileId), true);
  assert.equal(await repository.getProfile(profile.profileId), undefined);
  assert.equal((await repository.getCurrentProfile()).profileId, GUEST_PROFILE_ID);
  assert.equal(await repository.getSave(profile.profileId, "deal-ada"), undefined);
  assert.equal((await repository.completedDealIds(profile.profileId)).size, 0);
  assert.deepEqual(await repository.getPreferences(profile.profileId), {});
});

test("autosave queues legal action snapshots and resumes latest", async () => {
  let now = 1;
  const repository = new RuntimeRepository(new MemoryStorage(), { now: () => now++ });
  await repository.initialize();
  const autosave = new AutosaveController(repository);
  await autosave.saveAfterLegalAction(saveContext(GUEST_PROFILE_ID), { tableau: [1] });
  await autosave.saveAfterLegalAction(saveContext(GUEST_PROFILE_ID), { tableau: [1, 2] });
  const restored = await autosave.resume(GUEST_PROFILE_ID);
  assert.deepEqual(restored.gameState, { tableau: [1, 2] });
});

test("statistics and recent history are updated atomically", async () => {
  let now = 10;
  const repository = new RuntimeRepository(new MemoryStorage(), { now: () => now++ });
  await repository.initialize();
  await repository.gameStarted(GUEST_PROFILE_ID, "1s", "easy");
  await repository.gameFinished({ ...saveContext(GUEST_PROFILE_ID), won: true, score: 500, elapsedMs: 3000, moves: 40, undoCount: 2, hintCount: 1 });
  const stats = await repository.getStats(GUEST_PROFILE_ID, "1s", "easy", { totalSeeds: 5 });
  assert.equal(stats.gamesStarted, 1);
  assert.equal(stats.gamesWon, 1);
  assert.equal(stats.winRate, 1);
  assert.equal(stats.completedSeedCount, 1);
  assert.equal(stats.remainingSeedCount, 4);
  assert.equal((await repository.listRecentGames(GUEST_PROFILE_ID))[0].dealId, "deal-1");
});

test("export, clear and import restores all runtime records", async () => {
  const source = new RuntimeRepository(new MemoryStorage(), { now: () => 123 });
  await source.initialize();
  await source.saveGame({ ...saveContext(GUEST_PROFILE_ID), gameState: { stock: [1, 2] } });
  await source.markCompleted(saveContext(GUEST_PROFILE_ID));
  const backup = await exportBackup(source, { now: 999, runtimeVersion: "1.0.0" });

  const target = new RuntimeRepository(new MemoryStorage());
  await importBackup(target, backup, { ruleVersion: "1.0", generatorVersion: "1" });
  assert.deepEqual((await target.getSave(GUEST_PROFILE_ID, "deal-1")).gameState, { stock: [1, 2] });
  assert.equal((await target.completedDealIds(GUEST_PROFILE_ID)).has("deal-1"), true);
});

test("invalid import is rejected before existing data is changed", async () => {
  const repository = new RuntimeRepository(new MemoryStorage(), { now: () => 1 });
  await repository.initialize();
  await repository.saveGame({ ...saveContext(GUEST_PROFILE_ID), gameState: { safe: true } });
  const invalid = await exportBackup(repository);
  invalid.data.saves[0].generatorVersion = "999";
  await assert.rejects(() => importBackup(repository, invalid, { generatorVersion: "1" }), { code: "GENERATOR_VERSION_MISMATCH" });
  assert.deepEqual((await repository.getSave(GUEST_PROFILE_ID, "deal-1")).gameState, { safe: true });
});

test("legacy backup aliases migrate to schema 1", () => {
  const migrated = validateBackup({
    users: [{ profileId: "legacy", name: "Legacy" }],
    saveGames: [{ userId: "legacy", seedId: "deal-x", board: { old: true }, ruleVersion: "1.0", generatorVersion: "1" }],
  });
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.data.saves[0].profileId, "legacy");
  assert.deepEqual(migrated.data.saves[0].gameState, { old: true });
});

test("storage capability falls back to memory", async () => {
  const result = await openRuntimeStorage({ indexedDB: null });
  assert.equal(result.storage.kind, "memory");
  assert.equal(result.capability.persistent, false);
});
