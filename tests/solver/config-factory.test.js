import test from "node:test";
import assert from "node:assert/strict";
import { validateSeedPoolConfig } from "../../src/solver/config.js";
import { candidateSeed, createFactoryCheckpoint, runSeedFactory } from "../../src/solver/seed-factory.js";
import { sha256, stableStringify } from "../../src/solver/canonical.js";

function config(overrides = {}) {
  return {
    configVersion: 1,
    ruleVersion: "1.0",
    generatorVersion: "1",
    buckets: {
      "1s.easy": {
        enabled: true,
        candidateScanBudget: 3,
        certifiedTarget: 1,
        embeddedTarget: 1,
        minimumPublishableCount: 1,
        allowEmptyBucket: false,
        ...overrides,
      },
    },
    maximumEmbeddedCount: 1,
    maximumEmbeddedBytes: 100_000,
  };
}

test("config validator enforces ordered targets and explicit empty policy", () => {
  assert.equal(validateSeedPoolConfig(config()).configVersion, 1);
  assert.throws(() => validateSeedPoolConfig(config({ embeddedTarget: 2 })), /target ordering/);
  assert.throws(() => validateSeedPoolConfig(config({ minimumPublishableCount: 0 })), /publish at least one/);
});

test("candidate namespace is deterministic and bucket-specific", () => {
  assert.equal(candidateSeed("1s.easy", 0), candidateSeed("1s.easy", 0));
  assert.notEqual(candidateSeed("1s.easy", 0), candidateSeed("1s.medium", 0));
  assert.match(candidateSeed("1s.easy", 0), /^u64:[0-9a-f]{16}$/);
});

test("factory records bounded scans and a resumable next offset", async () => {
  const value = config();
  const hash = sha256(stableStringify(value));
  const checkpoint = createFactoryCheckpoint(value, hash);
  const result = await runSeedFactory({
    config: value,
    configHash: hash,
    checkpoint,
    solverOptions: { nodeBudget: 1, timeoutMs: 500, transpositionLimit: 10 },
    maxCandidates: 1,
  });
  assert.equal(result.buckets["1s.easy"].candidatesScanned, 1);
  assert.equal(result.buckets["1s.easy"].nextOffset, 1);
  assert.equal(result.buckets["1s.easy"].entries.length, 0);
  assert.equal(result.buckets["1s.easy"].outcomes.resourceLimit, 1);
  assert.match(result.solverConfigHash, /^[0-9a-f]{64}$/);
});

test("checkpoint refuses resume under a different solver configuration", async () => {
  const value = config();
  const configHash = sha256(stableStringify(value));
  const checkpoint = await runSeedFactory({
    config: value,
    configHash,
    checkpoint: createFactoryCheckpoint(value, configHash),
    solverOptions: { nodeBudget: 1, timeoutMs: 500, transpositionLimit: 10 },
    maxCandidates: 1,
  });
  await assert.rejects(
    runSeedFactory({
      config: value,
      configHash,
      checkpoint,
      solverOptions: { nodeBudget: 2, timeoutMs: 500, transpositionLimit: 10 },
      maxCandidates: 1,
    }),
    /solverConfigHash does not match/,
  );
  assert.equal(checkpoint.buckets["1s.easy"].candidatesScanned, 1);
});

test("legacy progressed checkpoint without solverConfigHash fails closed", async () => {
  const value = config();
  const configHash = sha256(stableStringify(value));
  const checkpoint = createFactoryCheckpoint(value, configHash);
  checkpoint.buckets["1s.easy"].candidatesScanned = 1;
  checkpoint.buckets["1s.easy"].nextOffset = 1;
  await assert.rejects(
    runSeedFactory({ config: value, configHash, checkpoint, maxCandidates: 1 }),
    /scan progress but is not bound/,
  );
});
