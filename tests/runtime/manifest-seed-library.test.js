import test from "node:test";
import assert from "node:assert/strict";
import { validateSeedArtifacts } from "../../src/runtime/manifest.js";
import { BUCKET_STATUS, SeedLibrary } from "../../src/runtime/seed-library.js";
import { seedArtifacts, seedArtifactsV2 } from "./fixtures.js";
const DEAL_1 = "1".padStart(64, "0");
const DEAL_2 = "2".padStart(64, "0");

test("validates seed artifacts and excludes tombstones", async () => {
  const { manifest, payload } = seedArtifacts();
  const artifacts = await validateSeedArtifacts(manifest, payload, { runtimeVersion: "1.2.0", ruleVersion: "1.0", generatorVersion: "1", verifyHashes: false });
  assert.equal(artifacts.activeDeals.length, 2);
});

test("fails closed on count, compatibility and duplicate identity", async () => {
  const countMismatch = seedArtifacts();
  countMismatch.manifest.totalEmbeddedCount = 3;
  await assert.rejects(() => validateSeedArtifacts(countMismatch.manifest, countMismatch.payload, { verifyHashes: false }), { code: "TOTAL_COUNT_MISMATCH" });

  const incompatible = seedArtifacts();
  await assert.rejects(() => validateSeedArtifacts(incompatible.manifest, incompatible.payload, { runtimeVersion: "2.0.0", verifyHashes: false }), { code: "RUNTIME_TOO_NEW" });

  const duplicate = seedArtifacts();
  duplicate.payload.deals[1].dealId = duplicate.payload.deals[0].dealId;
  await assert.rejects(() => validateSeedArtifacts(duplicate.manifest, duplicate.payload, { verifyHashes: false }), { code: "DUPLICATE_DEAL_ID" });
});

test("reports disabled, empty, available and exhausted buckets", async () => {
  const { manifest, payload } = seedArtifacts();
  const library = await SeedLibrary.fromArtifacts(manifest, payload, { verifyHashes: false });
  assert.equal(library.getBucketStatus("4s.demon").status, BUCKET_STATUS.DISABLED);
  assert.equal(library.getBucketStatus("1s.medium").status, BUCKET_STATUS.EMPTY);
  assert.equal(library.getBucketStatus("1s.easy", [DEAL_1]).status, BUCKET_STATUS.AVAILABLE);
  assert.equal(library.getBucketStatus("1s.easy", [DEAL_1, DEAL_2]).status, BUCKET_STATUS.EXHAUSTED);
});

test("selects only incomplete deals and requires explicit replay after exhaustion", async () => {
  const { manifest, payload } = seedArtifacts();
  const library = await SeedLibrary.fromArtifacts(manifest, payload, { verifyHashes: false });
  const zeroCrypto = { getRandomValues(target) { target[0] = 0; return target; } };
  assert.equal(library.select("1s.easy", { completedDealIds: [DEAL_1], crypto: zeroCrypto }).dealId, DEAL_2);
  assert.throws(() => library.select("1s.easy", { completedDealIds: [DEAL_1, DEAL_2], crypto: zeroCrypto }), { code: "BUCKET_EXHAUSTED" });
  assert.ok(library.select("1s.easy", { completedDealIds: [DEAL_1, DEAL_2], replayCompleted: true, crypto: zeroCrypto }));
  assert.throws(() => library.select("4s.demon", { crypto: zeroCrypto }), { code: "BUCKET_DISABLED" });
  assert.throws(() => library.select("1s.medium", { crypto: zeroCrypto }), { code: "BUCKET_EMPTY" });
});

test("random selection avoids repeating the immediately previous seed", async () => {
  const { manifest, payload } = seedArtifacts();
  const library = await SeedLibrary.fromArtifacts(manifest, payload, { verifyHashes: false });
  const zeroCrypto = { getRandomValues(target) { target[0] = 0; return target; } };
  const first = library.select("1s.easy", { crypto: zeroCrypto });
  const second = library.select("1s.easy", { crypto: zeroCrypto });
  const third = library.select("1s.easy", { crypto: zeroCrypto });
  assert.equal(first.dealId, DEAL_1);
  assert.equal(second.dealId, DEAL_2);
  assert.equal(third.dealId, DEAL_1);
});

test("Seed Library V2 applies disabled, superseded and classification override tombstones", async () => {
  const { manifest, payload } = seedArtifactsV2();
  const library = await SeedLibrary.fromArtifacts(manifest, payload, { verifyHashes: false });
  const deal3 = "3".padStart(64, "0");
  const deal4 = "4".padStart(64, "0");

  assert.equal(library.getDeal(DEAL_2).originalDifficulty, "easy");
  assert.equal(library.getDeal(DEAL_2).difficulty, "medium");
  assert.equal(library.getActiveDeal(DEAL_2).bucketId, "1s.medium");
  assert.equal(library.getActiveDeal(deal3), null);
  assert.equal(library.getDeal(deal3).status, "superseded");
  assert.equal(library.getDeal(deal3).supersededBy, deal4);

  const completed = library.classifyCompletedDealIds([DEAL_1, deal3, "f".repeat(64)]);
  assert.deepEqual(completed.active, new Set([DEAL_1]));
  assert.deepEqual(completed.unavailable, new Set([deal3]));
  assert.deepEqual(completed.unknown, new Set(["f".repeat(64)]));

  const available = library.listAvailable("1s.easy", [deal3]);
  assert.equal(available.some((deal) => deal.dealId === deal4), true, "old completion must not transfer to the replacement deal");
});

test("V2 disabled history remains recognizable but is never selectable", async () => {
  const fixture = seedArtifactsV2();
  fixture.payload.tombstones.push({
    dealId: DEAL_1,
    status: "disabled",
    reasonCode: "CERTIFICATE_REVOKED",
    disabledAt: "2026-10-05T00:00:00.000Z",
    effectiveLibraryVersion: "2.0.0",
  });
  fixture.manifest.buckets["1s.easy"].actualCount = 1;
  fixture.manifest.buckets["1s.easy"].embeddedCount = 1;
  fixture.manifest.buckets["1s.easy"].embeddedTarget = 1;
  fixture.manifest.totalEmbeddedCount = 2;
  const library = await SeedLibrary.fromArtifacts(fixture.manifest, fixture.payload, { verifyHashes: false });
  assert.equal(library.getCompletedDealStatus(DEAL_1).known, true);
  assert.equal(library.getCompletedDealStatus(DEAL_1).active, false);
  assert.equal(library.listAvailable("1s.easy").some((deal) => deal.dealId === DEAL_1), false);
});

test("V2 rejects supersession cycles and unavailable final targets", async () => {
  const cyclic = seedArtifactsV2();
  cyclic.payload.tombstones.push({
    dealId: "4".padStart(64, "0"),
    status: "superseded",
    reasonCode: "BAD_CHAIN",
    supersededBy: "3".padStart(64, "0"),
    effectiveLibraryVersion: "2.0.0",
  });
  await assert.rejects(
    () => validateSeedArtifacts(cyclic.manifest, cyclic.payload, { verifyHashes: false }),
    { code: "SUPERSESSION_CYCLE" },
  );

  const disabledTarget = seedArtifactsV2();
  disabledTarget.payload.tombstones.push({
    dealId: "4".padStart(64, "0"),
    status: "disabled",
    reasonCode: "REVOKED_TARGET",
    effectiveLibraryVersion: "2.0.0",
  });
  await assert.rejects(
    () => validateSeedArtifacts(disabledTarget.manifest, disabledTarget.payload, { verifyHashes: false }),
    { code: "INVALID_SUPERSEDED_TARGET" },
  );
});

test("legacy payload cannot encode supersession without an auditable V2 tombstone", async () => {
  const fixture = seedArtifacts();
  fixture.payload.deals[2].status = "superseded";
  await assert.rejects(
    () => validateSeedArtifacts(fixture.manifest, fixture.payload, { verifyHashes: false }),
    { code: "INVALID_SUPERSEDED_TARGET" },
  );
});
