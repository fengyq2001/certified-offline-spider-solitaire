import assert from "node:assert/strict";
import test from "node:test";

import {
  exists,
  importProjectModule,
  readFixture,
} from "./test-support.js";

const hasBackupApi = await exists("src", "runtime", "backup.js")
  && await exists("src", "runtime", "repository.js")
  && await exists("src", "runtime", "storage.js");

function sortRecords(data) {
  return Object.fromEntries(Object.entries(data).map(([store, records]) => [
    store,
    [...records].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]));
}

test("export -> clear/new store -> import restores every profile-scoped record", {
  skip: hasBackupApi ? false : "runtime backup API is not implemented yet",
}, async () => {
  const runtime = await importProjectModule("src", "runtime", "index.js");
  const sourceStorage = new runtime.MemoryStorage();
  const source = new runtime.RuntimeRepository(sourceStorage, { now: () => 100 });
  await source.initialize();
  await source.createProfile("A", { profileId: "profile-a" });
  await source.createProfile("B", { profileId: "profile-b" });

  const versionFields = { ruleVersion: "1.0", generatorVersion: "1", seedLibraryVersion: "integration-v1" };
  await source.saveGame({ profileId: "profile-a", dealId: "deal-1", gameState: { turn: 3 }, ...versionFields });
  await source.saveGame({ profileId: "profile-b", dealId: "deal-1", gameState: { turn: 7 }, ...versionFields });
  await source.markCompleted({ profileId: "profile-a", dealId: "deal-1", suitMode: "1s", difficulty: "easy" });
  await source.gameStarted("profile-a", "1s", "easy");
  await source.setPreferences("profile-a", { sound: false });
  await source.setPreferences("profile-b", { sound: true });
  await source.setCurrentProfile("profile-b");

  const exported = await runtime.exportBackup(source, { now: 200, runtimeVersion: "0.1.0" });
  const destinationStorage = new runtime.MemoryStorage();
  const destination = new runtime.RuntimeRepository(destinationStorage, { now: () => 300 });
  await runtime.importBackup(destination, JSON.stringify(exported), {
    mode: "replace",
    ruleVersion: "1.0",
    generatorVersion: "1",
  });
  const restored = await runtime.exportBackup(destination, { now: 400, runtimeVersion: "0.1.0" });

  assert.deepEqual(sortRecords(restored.data), sortRecords(exported.data));
  assert.equal((await destination.getCurrentProfile()).profileId, "profile-b");
  assert.deepEqual((await destination.getSave("profile-a", "deal-1")).gameState, { turn: 3 });
  assert.deepEqual((await destination.getSave("profile-b", "deal-1")).gameState, { turn: 7 });
});

test("legacy backup fixture migrates identities and board state", {
  skip: hasBackupApi ? false : "runtime backup API is not implemented yet",
}, async () => {
  const runtime = await importProjectModule("src", "runtime", "index.js");
  const fixture = await readFixture("backup-v0.json");
  const storage = new runtime.MemoryStorage();
  const repository = new runtime.RuntimeRepository(storage);
  await runtime.importBackup(repository, fixture, { ruleVersion: "1.0", generatorVersion: "1" });

  const save = await repository.getSave("legacy-a", "legacy-deal-1");
  assert.equal(save.schemaVersion, 1);
  assert.deepEqual(save.gameState, { turn: 3 });
  assert.deepEqual(await repository.completedDealIds("legacy-a"), new Set(["legacy-deal-1"]));
  assert.equal((await repository.getPreferences("legacy-a")).sound, false);
});

test("backup import rejects unknown future schemas before mutating storage", {
  skip: hasBackupApi ? false : "runtime backup API is not implemented yet",
}, async () => {
  const runtime = await importProjectModule("src", "runtime", "index.js");
  const storage = new runtime.MemoryStorage();
  await assert.rejects(
    runtime.importBackup(storage, { format: "certified-spider-backup", schemaVersion: 99 }),
    (error) => error?.code === "BACKUP_SCHEMA_TOO_NEW",
  );
  for (const store of runtime.RUNTIME_STORES) assert.deepEqual(await storage.getAll(store), []);
});
