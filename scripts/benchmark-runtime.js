#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { SeedLibrary } from "../src/runtime/seed-library.js";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonNegativeFinite(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be a non-negative finite number`);
  return value;
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
  return value;
}

export function validateRuntimePerformanceBudget(budget) {
  invariant(budget && typeof budget === "object" && !Array.isArray(budget), "Runtime performance budget must be an object");
  invariant(budget.schemaVersion === 1, "Unsupported runtime performance budget schemaVersion");
  for (const field of ["parseIterations", "startupProxyIterations", "selectionIterations"]) positiveInteger(budget[field], field);
  for (const field of ["parseWarmupIterations", "startupProxyWarmupIterations", "selectionWarmupIterations"]) nonNegativeInteger(budget[field], field);
  for (const field of [
    "maximumManifestPayloadParseP50Ms",
    "maximumManifestPayloadParseP95Ms",
    "maximumStartupProxyP50Ms",
    "maximumStartupProxyP95Ms",
    "maximumSeedSelectionP50Ms",
    "maximumSeedSelectionP95Ms",
    "maximumNodeHeapGrowthBytes",
    "maximumNodePeakResidentSetBytes",
  ]) nonNegativeFinite(budget[field], field);
  return budget;
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const rounded = (value) => Number(value.toFixed(6));
  return {
    p50: rounded(percentile(sorted, 0.50)),
    p95: rounded(percentile(sorted, 0.95)),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

function runMeasured(iterations, warmupIterations, operation) {
  for (let index = 0; index < warmupIterations; index += 1) operation(index);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation(index);
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
}

async function runMeasuredAsync(iterations, warmupIterations, operation) {
  for (let index = 0; index < warmupIterations; index += 1) await operation(index);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation(index);
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
}

export function evaluateRuntimePerformanceBudgets(metrics, budget) {
  const checks = {
    manifestPayloadParseP50Ms: {
      actual: metrics.manifestPayloadParseMs.p50,
      maximum: budget.maximumManifestPayloadParseP50Ms,
    },
    manifestPayloadParseP95Ms: {
      actual: metrics.manifestPayloadParseMs.p95,
      maximum: budget.maximumManifestPayloadParseP95Ms,
    },
    startupProxyP50Ms: {
      actual: metrics.startupProxyMs.p50,
      maximum: budget.maximumStartupProxyP50Ms,
    },
    startupProxyP95Ms: {
      actual: metrics.startupProxyMs.p95,
      maximum: budget.maximumStartupProxyP95Ms,
    },
    seedSelectionP50Ms: {
      actual: metrics.seedSelectionMs.p50,
      maximum: budget.maximumSeedSelectionP50Ms,
    },
    seedSelectionP95Ms: {
      actual: metrics.seedSelectionMs.p95,
      maximum: budget.maximumSeedSelectionP95Ms,
    },
    nodeHeapGrowthBytes: {
      actual: metrics.memory.nodeHeapGrowthBytes,
      maximum: budget.maximumNodeHeapGrowthBytes,
    },
    nodePeakResidentSetBytes: {
      actual: metrics.memory.nodePeakResidentSetBytes,
      maximum: budget.maximumNodePeakResidentSetBytes,
    },
  };
  for (const check of Object.values(checks)) check.pass = check.actual <= check.maximum;
  return checks;
}

function deterministicCrypto() {
  let value = 0;
  return {
    getRandomValues(target) {
      target[0] = value;
      value = (value + 1) >>> 0;
      return target;
    },
  };
}

function enabledNonEmptyBuckets(manifest) {
  return Object.entries(manifest.buckets)
    .filter(([, bucket]) => bucket.enabled && bucket.embeddedCount > 0)
    .map(([bucketId]) => bucketId);
}

export async function benchmarkRuntimePerformance({ manifestText, payloadText, budget, verifyHashes = true }) {
  validateRuntimePerformanceBudget(budget);
  invariant(typeof manifestText === "string" && manifestText.length > 0, "Manifest text is required");
  invariant(typeof payloadText === "string" && payloadText.length > 0, "Payload text is required");

  global.gc?.();
  const memoryBefore = process.memoryUsage();
  let peakResidentSetBytes = Math.max(memoryBefore.rss, process.resourceUsage().maxRSS * 1024);
  const sampleMemory = () => {
    peakResidentSetBytes = Math.max(peakResidentSetBytes, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
  };

  const manifestPayloadParseMs = runMeasured(budget.parseIterations, budget.parseWarmupIterations, () => {
    JSON.parse(manifestText);
    JSON.parse(payloadText);
  });
  sampleMemory();

  const startupOptions = { verifyHashes };
  let library;
  const startupProxyMs = await runMeasuredAsync(
    budget.startupProxyIterations,
    budget.startupProxyWarmupIterations,
    async () => {
      const manifest = JSON.parse(manifestText);
      const payload = JSON.parse(payloadText);
      library = await SeedLibrary.fromArtifacts(manifest, payload, startupOptions);
    },
  );
  sampleMemory();

  invariant(library, "Runtime startup proxy did not create a SeedLibrary");
  const bucketIds = enabledNonEmptyBuckets(library.manifest);
  invariant(bucketIds.length > 0, "Runtime performance benchmark requires at least one enabled non-empty bucket");
  const crypto = deterministicCrypto();
  const select = (index) => library.select(bucketIds[index % bucketIds.length], { crypto });
  const seedSelectionMs = runMeasured(budget.selectionIterations, budget.selectionWarmupIterations, select);
  sampleMemory();

  global.gc?.();
  const memoryAfter = process.memoryUsage();
  sampleMemory();
  const metrics = {
    manifestPayloadParseMs,
    startupProxyMs,
    seedSelectionMs,
    memory: {
      nodeHeapBeforeBytes: memoryBefore.heapUsed,
      nodeHeapAfterBytes: memoryAfter.heapUsed,
      nodeHeapGrowthBytes: Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed),
      nodePeakResidentSetBytes: peakResidentSetBytes,
    },
  };
  const budgetChecks = evaluateRuntimePerformanceBudgets(metrics, budget);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      kind: "node-runtime-proxy",
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      boundary: "These measurements are Node.js proxies for runtime work. They are not browser startup, browser selection-latency, or browser peak-memory evidence and do not satisfy the cross-browser release matrix.",
    },
    methodology: {
      manifestPayloadParse: "JSON.parse of the checked-in resolved manifest and runtime payload.",
      startupProxy: "JSON.parse plus runtime artifact validation, integrity hash checks, and SeedLibrary index construction in Node.js.",
      seedSelection: "SeedLibrary.select across enabled non-empty buckets with a deterministic crypto provider and no completed deals.",
      memory: "Node process heap snapshots plus process.resourceUsage max RSS; this is process-level proxy data, not browser-tab memory.",
      iterations: {
        parse: budget.parseIterations,
        parseWarmup: budget.parseWarmupIterations,
        startupProxy: budget.startupProxyIterations,
        startupProxyWarmup: budget.startupProxyWarmupIterations,
        seedSelection: budget.selectionIterations,
        seedSelectionWarmup: budget.selectionWarmupIterations,
      },
    },
    inputs: {
      manifestBytes: Buffer.byteLength(manifestText, "utf8"),
      payloadBytes: Buffer.byteLength(payloadText, "utf8"),
      enabledNonEmptyBucketCount: bucketIds.length,
      embeddedDealCount: library.deals.length,
      libraryHash: library.manifest.libraryHash,
    },
    metrics,
    budgets: budget,
    budgetChecks,
    result: Object.values(budgetChecks).every((check) => check.pass) ? "PASS" : "FAIL",
  };
}

export async function runRuntimePerformanceBenchmark({ root = DEFAULT_ROOT } = {}) {
  const manifestFile = path.join(root, "src/data/resolved-seed-manifest.json");
  const payloadFile = path.join(root, "src/data/certified-seeds.json");
  const budgetFile = path.join(root, "src/config/runtime-performance-budget.json");
  const reportFile = path.join(root, "artifacts/performance/runtime-performance.json");
  const [manifestText, payloadText, budgetText] = await Promise.all([
    readFile(manifestFile, "utf8"),
    readFile(payloadFile, "utf8"),
    readFile(budgetFile, "utf8"),
  ]);
  const report = await benchmarkRuntimePerformance({ manifestText, payloadText, budget: JSON.parse(budgetText) });
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  invariant(report.result === "PASS", `Runtime performance budget failed; see ${path.relative(root, reportFile)}`);
  process.stdout.write(`Runtime performance proxy PASS (parse p95 ${report.metrics.manifestPayloadParseMs.p95} ms, startup p95 ${report.metrics.startupProxyMs.p95} ms, selection p95 ${report.metrics.seedSelectionMs.p95} ms)\n`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runRuntimePerformanceBenchmark();
