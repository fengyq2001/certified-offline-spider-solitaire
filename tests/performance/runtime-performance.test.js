import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkRuntimePerformance,
  evaluateRuntimePerformanceBudgets,
  validateRuntimePerformanceBudget,
} from "../../scripts/benchmark-runtime.js";
import { seedArtifacts } from "../runtime/fixtures.js";

function budget(overrides = {}) {
  return {
    schemaVersion: 1,
    parseIterations: 5,
    parseWarmupIterations: 1,
    startupProxyIterations: 3,
    startupProxyWarmupIterations: 1,
    selectionIterations: 10,
    selectionWarmupIterations: 2,
    maximumManifestPayloadParseP50Ms: 500,
    maximumManifestPayloadParseP95Ms: 1000,
    maximumStartupProxyP50Ms: 500,
    maximumStartupProxyP95Ms: 1000,
    maximumSeedSelectionP50Ms: 500,
    maximumSeedSelectionP95Ms: 1000,
    maximumNodeHeapGrowthBytes: Number.MAX_SAFE_INTEGER,
    maximumNodePeakResidentSetBytes: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

test("runtime performance proxy reports labeled Node-only metrics", async () => {
  const { manifest, payload } = seedArtifacts();
  const report = await benchmarkRuntimePerformance({
    manifestText: JSON.stringify(manifest),
    payloadText: JSON.stringify(payload),
    budget: budget(),
    verifyHashes: false,
  });
  assert.equal(report.environment.kind, "node-runtime-proxy");
  assert.match(report.environment.boundary, /not browser/i);
  assert.match(report.methodology.memory, /not browser/i);
  assert.equal(report.inputs.enabledNonEmptyBucketCount, 1);
  assert.equal(report.inputs.embeddedDealCount, 2);
  for (const metric of [report.metrics.manifestPayloadParseMs, report.metrics.startupProxyMs, report.metrics.seedSelectionMs]) {
    assert.ok(metric.p50 >= 0);
    assert.ok(metric.p95 >= metric.p50);
    assert.ok(metric.max >= metric.p95);
  }
  assert.equal(report.result, "PASS");
});

test("runtime performance budget evaluation fails each metric independently", () => {
  const configured = validateRuntimePerformanceBudget(budget({
    maximumManifestPayloadParseP50Ms: 0.5,
    maximumManifestPayloadParseP95Ms: 1,
    maximumStartupProxyP50Ms: 1,
    maximumStartupProxyP95Ms: 2,
    maximumSeedSelectionP50Ms: 1.5,
    maximumSeedSelectionP95Ms: 3,
    maximumNodeHeapGrowthBytes: 4,
    maximumNodePeakResidentSetBytes: 5,
  }));
  const checks = evaluateRuntimePerformanceBudgets({
    manifestPayloadParseMs: { p50: 0.6, p95: 1.1 },
    startupProxyMs: { p50: 1.1, p95: 2.1 },
    seedSelectionMs: { p50: 1.6, p95: 3.1 },
    memory: { nodeHeapGrowthBytes: 5, nodePeakResidentSetBytes: 6 },
  }, configured);
  assert.equal(Object.values(checks).every((check) => check.pass === false), true);
});

test("runtime performance budget rejects missing or invalid approved thresholds", () => {
  assert.throws(
    () => validateRuntimePerformanceBudget({ ...budget(), maximumStartupProxyP95Ms: -1 }),
    /maximumStartupProxyP95Ms/,
  );
  assert.throws(
    () => validateRuntimePerformanceBudget({ ...budget(), selectionIterations: 0 }),
    /selectionIterations/,
  );
});
