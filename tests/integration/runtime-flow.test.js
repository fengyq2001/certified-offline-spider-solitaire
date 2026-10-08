import assert from "node:assert/strict";
import test from "node:test";

import {
  exists,
  importProjectModule,
  normalizedState,
} from "./test-support.js";

const hasRuntimeStorage = await exists("src", "runtime", "storage.js");
const hasCore = await exists("src", "core", "generator.js")
  && await exists("src", "core", "engine.js");

test("Seed -> Deal -> save -> resume -> restart preserves stable deal identity", {
  skip: hasCore && hasRuntimeStorage ? false : "core or runtime storage is not implemented yet",
}, async () => {
  const generator = await importProjectModule("src", "core", "generator.js");
  const engine = await importProjectModule("src", "core", "engine.js");
  const { MemoryStorage } = await importProjectModule("src", "runtime", "storage.js");
  const { AutosaveController, RuntimeRepository } = await importProjectModule("src", "runtime", "repository.js");

  const profileId = "guest";
  const seed = "u64:0123456789abcdef";
  const suitMode = 2;
  const dealId = await generator.computeDealId(seed, suitMode);
  const initial = generator.generateDeal(seed, suitMode);
  const legalMoves = engine.getLegalMoves(initial);
  const progressed = legalMoves.length > 0 ? engine.applyMove(initial, legalMoves[0]) : engine.dealStock(initial);
  const storage = new MemoryStorage();
  const repository = new RuntimeRepository(storage, { now: () => 123 });
  await repository.initialize();
  const autosave = new AutosaveController(repository, { serializeState: engine.serializeState });

  await autosave.saveAfterLegalAction({
    profileId,
    dealId,
    canonicalSeed: seed,
    suitMode,
    ruleVersion: initial.ruleVersion,
    generatorVersion: initial.generatorVersion,
    seedLibraryVersion: "integration-v1",
  }, progressed);
  await autosave.flush();

  const saved = await autosave.resume(profileId, dealId);
  const resumed = engine.deserializeState(saved.gameState);
  assert.deepEqual(normalizedState(resumed), normalizedState(progressed));

  const restarted = engine.restart(resumed);
  assert.equal(await generator.computeDealId(restarted.canonicalSeed, restarted.suitMode), dealId);
  assert.equal(
    await generator.computeInitialDealHash(restarted),
    await generator.computeInitialDealHash(initial),
  );
});

test("same dealId remains isolated across profiles for save, completion and preferences", {
  skip: hasRuntimeStorage ? false : "runtime storage is not implemented yet",
}, async () => {
  const { MemoryStorage } = await importProjectModule("src", "runtime", "storage.js");
  const { RuntimeRepository } = await importProjectModule("src", "runtime", "repository.js");
  const storage = new MemoryStorage();
  const repository = new RuntimeRepository(storage, { now: () => 123 });
  await repository.initialize();
  await repository.createProfile("A", { profileId: "user-a" });
  await repository.createProfile("B", { profileId: "user-b" });
  const dealId = "shared-deal-id";

  const versionFields = { ruleVersion: "1.0", generatorVersion: "1", seedLibraryVersion: "integration-v1" };
  await repository.saveGame({ profileId: "user-a", dealId, gameState: { turn: 3 }, ...versionFields });
  await repository.saveGame({ profileId: "user-b", dealId, gameState: { turn: 7 }, ...versionFields });
  await repository.markCompleted({ profileId: "user-a", dealId, suitMode: "1s", difficulty: "easy" });
  await repository.setPreferences("user-a", { sound: false });
  await repository.setPreferences("user-b", { sound: true });

  assert.deepEqual((await repository.getSave("user-a", dealId)).gameState, { turn: 3 });
  assert.deepEqual((await repository.getSave("user-b", dealId)).gameState, { turn: 7 });
  assert.deepEqual(await repository.completedDealIds("user-a"), new Set([dealId]));
  assert.deepEqual(await repository.completedDealIds("user-b"), new Set());
  assert.equal((await repository.getPreferences("user-a")).sound, false);
  assert.equal((await repository.getPreferences("user-b")).sound, true);
});

test("memory transaction rollback does not leak partial cross-profile writes", {
  skip: hasRuntimeStorage ? false : "runtime storage is not implemented yet",
}, async () => {
  const { MemoryStorage } = await importProjectModule("src", "runtime", "storage.js");
  const storage = new MemoryStorage();

  await assert.rejects(
    storage.runTransaction(["saves", "completed"], "readwrite", async (tx) => {
      await tx.put("saves", { profileId: "user-a", dealId: "deal-1", state: { turn: 1 } });
      await tx.put("completed", { profileId: "user-b", dealId: "deal-1", completedAt: 1 });
      throw new Error("forced rollback");
    }),
    /forced rollback/,
  );

  assert.equal(await storage.get("saves", ["user-a", "deal-1"]), undefined);
  assert.equal(await storage.get("completed", ["user-b", "deal-1"]), undefined);
});
