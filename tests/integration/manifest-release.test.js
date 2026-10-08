import assert from "node:assert/strict";
import test from "node:test";

import {
  assertManifestReleaseContract,
  exists,
  importProjectModule,
  readFixture,
  readProjectJson,
} from "./test-support.js";

test("source SeedPoolConfig has all 12 buckets and obeys static constraints", async () => {
  const config = await readProjectJson("src", "config", "seed-pool-config.json");
  const expectedKeys = [];
  for (const suitMode of [1, 2, 4]) {
    for (const difficulty of ["easy", "medium", "hard", "demon"]) {
      expectedKeys.push(`${suitMode}s.${difficulty}`);
    }
  }
  assert.deepEqual(Object.keys(config.buckets).sort(), expectedKeys.sort());

  let requestedEmbeddedTotal = 0;
  for (const [key, bucket] of Object.entries(config.buckets)) {
    for (const field of [
      "candidateScanBudget",
      "certifiedTarget",
      "embeddedTarget",
      "minimumPublishableCount",
    ]) {
      assert.ok(Number.isSafeInteger(bucket[field]) && bucket[field] >= 0, `${key}: ${field} must be a non-negative safe integer`);
    }

    if (bucket.enabled) {
      assert.ok(bucket.certifiedTarget <= bucket.candidateScanBudget, `${key}: certification target exceeds scan budget`);
      assert.ok(bucket.embeddedTarget <= bucket.certifiedTarget, `${key}: embedded target exceeds certification target`);
      if (bucket.embeddedTarget === 0) {
        assert.equal(bucket.allowEmptyBucket, true, `${key}: enabled zero target requires allowEmptyBucket`);
      } else {
        assert.ok(bucket.minimumPublishableCount > 0, `${key}: non-empty enabled bucket requires a positive publication minimum`);
        assert.ok(bucket.minimumPublishableCount <= bucket.embeddedTarget, `${key}: publication minimum exceeds embedded target`);
      }
    } else {
      assert.equal(bucket.certifiedTarget, 0, `${key}: disabled bucket certifiedTarget must be zero`);
      assert.equal(bucket.embeddedTarget, 0, `${key}: disabled bucket embeddedTarget must be zero`);
      assert.equal(bucket.minimumPublishableCount, 0, `${key}: disabled bucket minimum must be zero`);
    }
    requestedEmbeddedTotal += bucket.embeddedTarget;
  }

  assert.ok(requestedEmbeddedTotal <= config.maximumEmbeddedCount, "configured embedded targets exceed the global count limit");
  assert.ok(Number.isSafeInteger(config.maximumEmbeddedBytes) && config.maximumEmbeddedBytes > 0);
});

test("reference manifest fixture satisfies the unified publication predicate", async () => {
  const manifest = await readFixture("manifest-valid.json");
  assert.deepEqual(
    assertManifestReleaseContract(assert, manifest),
    {
      embeddedTotal: 2,
      encodedTotal: 96,
      dealIds: new Set(["fixture-deal-1", "fixture-deal-2"]),
    },
  );
});

test("publication predicate rejects an enabled non-empty bucket below its minimum", async () => {
  const manifest = await readFixture("manifest-valid.json");
  manifest.buckets["1s.easy"].minimumPublishableCount = 3;
  assert.throws(
    () => assertManifestReleaseContract(assert, manifest),
    /publication minimum/,
  );
});

const hasResolvedManifest = await exists("src", "data", "resolved-seed-manifest.json");
const resolvedManifest = hasResolvedManifest
  ? await readProjectJson("src", "data", "resolved-seed-manifest.json")
  : null;
const isReleaseCandidateManifest = Boolean(
  resolvedManifest
    && resolvedManifest.classificationStatus !== "provisional"
    && resolvedManifest.solverVersion !== "unavailable"
    && resolvedManifest.validatorVersion !== "unavailable",
);

test("generated resolved manifest satisfies count, uniqueness and release gates", {
  skip: isReleaseCandidateManifest
    ? false
    : "resolved manifest is absent or explicitly provisional; release validation remains pending",
}, async () => {
  assertManifestReleaseContract(assert, resolvedManifest);
  const payload = await readProjectJson("src", "data", "certified-seeds.json");
  const { validateSeedArtifacts } = await importProjectModule("src", "runtime", "manifest.js");
  const artifacts = await validateSeedArtifacts(resolvedManifest, payload, {
    runtimeVersion: "0.1.0",
    ruleVersion: resolvedManifest.ruleVersion,
    generatorVersion: resolvedManifest.generatorVersion,
  });
  assert.equal(artifacts.activeDeals.length, resolvedManifest.totalEmbeddedCount);
});
