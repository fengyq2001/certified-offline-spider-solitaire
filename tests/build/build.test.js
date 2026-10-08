import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSingle,
  canonicalJson,
  sha256Canonical,
} from "../../scripts/build-single.js";
import { verifyDistribution } from "../../scripts/verify-dist.js";

const EMPTY_CATALOG_HASH = sha256Canonical([]);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeFixture({ emptyAllowed = false, externalImport = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "spider-build-test-"));
  await mkdir(path.join(root, "src", "ui"), { recursive: true });
  await writeFile(path.join(root, "THIRD_PARTY_LICENSES.md"), "# Third-party license register\n\nNo vendored third-party source or package dependencies.\n");
  await writeJson(path.join(root, "package.json"), { name: "build-fixture", private: true, type: "module" });
  const config = {
    configVersion: 1,
    ruleVersion: "1.0",
    generatorVersion: "1",
    buckets: {
      "1s.easy": {
        enabled: true,
        candidateScanBudget: 5,
        certifiedTarget: emptyAllowed ? 0 : 1,
        embeddedTarget: emptyAllowed ? 0 : 1,
        minimumPublishableCount: emptyAllowed ? 0 : 1,
        allowEmptyBucket: emptyAllowed,
      },
    },
    maximumEmbeddedCount: 2,
    maximumEmbeddedBytes: 4096,
  };
  const deals = emptyAllowed ? [] : [{
    dealId: "a".repeat(64),
    canonicalSeed: "u64:0000000000000001",
    initialDealHash: "b".repeat(64),
    suitMode: 1,
    difficulty: "easy",
    status: "active",
  }];
  const payload = { payloadSchemaVersion: 1, seedLibraryVersion: "test-1", deals };
  const encodedBytes = deals.reduce((sum, deal) => sum + Buffer.byteLength(canonicalJson(deal)), 0);
  const manifest = {
    schemaVersion: 1,
    configVersion: config.configVersion,
    createdAt: "2026-01-01T00:00:00.000Z",
    payloadSchemaVersion: 1,
    seedLibraryVersion: "test-1",
    parentLibraryVersion: null,
    minRuntimeVersion: "0.1.0",
    maxRuntimeVersion: "0.1.x",
    ruleVersion: "1.0",
    generatorVersion: "1",
    solverVersion: "test",
    solverConfigHash: "c".repeat(64),
    validatorVersion: "test",
    classifierVersion: "test",
    calibrationDatasetHash: "d".repeat(64),
    classificationCatalogHash: "e".repeat(64),
    classificationStatus: "provisional",
    configHash: sha256Canonical(config),
    payloadHash: sha256Canonical(payload),
    libraryHash: sha256Canonical(deals),
    certificateCatalogHash: EMPTY_CATALOG_HASH,
    maximumEmbeddedCount: config.maximumEmbeddedCount,
    maximumEmbeddedBytes: config.maximumEmbeddedBytes,
    buckets: {
      "1s.easy": {
        ...config.buckets["1s.easy"],
        candidatesScanned: deals.length,
        candidateScanScope: "bucket",
        rawCertifiedCount: deals.length,
        actualCount: deals.length,
        embeddedCount: deals.length,
        encodedBytes,
      },
    },
    payloadIndex: { "1s.easy": { startOffset: 0, entryCount: deals.length } },
    deals,
    totalEmbeddedCount: deals.length,
    totalEncodedBytes: encodedBytes,
  };
  await writeJson(path.join(root, "src", "config", "seed-pool-config.json"), config);
  await writeJson(path.join(root, "src", "data", "certified-seeds.json"), payload);
  await writeJson(path.join(root, "src", "data", "resolved-seed-manifest.json"), manifest);
  await writeJson(path.join(root, "src", "data", "build-budget.json"), {
    schemaVersion: 1,
    maximumBundleBytes: 200000,
    maximumRuntimeSourceBytes: 10000,
    maximumAssetBytes: 10000,
    maximumManifestBytes: 10000,
  });
  await writeFile(path.join(root, "src", "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="./ui/styles.css"></head><body><main id="app"></main><script type="module" src="./main.js"></script></body></html>`);
  await writeFile(path.join(root, "src", "ui", "styles.css"), "body { color: #123; }\n");
  await writeFile(path.join(root, "src", "local.json"), '{"answer":42}\n');
  const dependency = externalImport ? "https://example.invalid/module.js" : "./dep.js";
  await writeFile(path.join(root, "src", "main.js"), `import { message } from ${JSON.stringify(dependency)};\nimport data from "./local.json" with { type: "json" };\ndocument.querySelector("#app").textContent = message + data.answer;\n`);
  await writeFile(path.join(root, "src", "dep.js"), 'export const message = "ready:";\n');
  return { root, manifest, payload };
}

test("builds and independently verifies a self-contained HTML artifact", async () => {
  const { root } = await makeFixture();
  const report = await buildSingle({ root });
  assert.equal(report.totalEmbeddedCount, 1);
  assert.equal(report.moduleCount, 3);
  assert.ok(report.totalBundleGzipBytes > 0);
  assert.ok(report.totalBundleBrotliBytes > 0);
  assert.ok(report.manifestGzipBytes > 0);
  assert.ok(report.manifestBrotliBytes > 0);
  assert.ok(report.seedPayloadGzipBytes > 0);
  assert.ok(report.seedPayloadBrotliBytes > 0);
  assert.deepEqual(report.buckets["1s.easy"], {
    enabled: true,
    embeddedCount: 1,
    encodedBytes: report.totalEncodedSeedBytes,
    averageEncodedBytesPerSeed: report.totalEncodedSeedBytes,
  });
  assert.equal(report.jsonParseBenchmark.environment, "node-build-process");
  assert.equal(report.jsonParseBenchmark.inputCount, 2);
  assert.ok(report.jsonParseBenchmark.iterations > 0);
  assert.ok(report.buildProcessMemory.peakResidentSetBytes > 0);
  assert.ok(report.buildProcessMemory.heapUsedBytes > 0);
  const html = await readFile(path.join(root, "dist", "index.html"), "utf8");
  assert.match(html, /<style data-bundled-from=/);
  assert.match(html, /type="importmap"/);
  assert.match(html, /id="spider-resolved-manifest"/);
  assert.match(html, /id="spider-certified-seeds"/);
  assert.doesNotMatch(html, /globalThis\.__SPIDER_SEED_ARTIFACTS__/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  const verified = await verifyDistribution({ root });
  assert.equal(verified.totalEmbeddedCount, 1);
  assert.equal(verified.artifactSha256, report.artifactSha256);
});

test("allows an explicitly configured empty bucket", async () => {
  const { root } = await makeFixture({ emptyAllowed: true });
  const report = await buildSingle({ root });
  assert.equal(report.totalEmbeddedCount, 0);
  await verifyDistribution({ root });
});

test("fails closed when an enabled non-empty bucket has no certified payload", async () => {
  const { root, manifest, payload } = await makeFixture({ emptyAllowed: true });
  const config = JSON.parse(await readFile(path.join(root, "src", "config", "seed-pool-config.json"), "utf8"));
  config.buckets["1s.easy"] = {
    ...config.buckets["1s.easy"],
    certifiedTarget: 1,
    embeddedTarget: 1,
    minimumPublishableCount: 1,
    allowEmptyBucket: false,
  };
  manifest.configHash = sha256Canonical(config);
  manifest.buckets["1s.easy"] = {
    ...config.buckets["1s.easy"],
    candidatesScanned: 0,
    candidateScanScope: "bucket",
    rawCertifiedCount: 0,
    actualCount: 0,
    embeddedCount: 0,
    encodedBytes: 0,
  };
  manifest.payloadHash = sha256Canonical(payload);
  await writeJson(path.join(root, "src", "config", "seed-pool-config.json"), config);
  await writeJson(path.join(root, "src", "data", "resolved-seed-manifest.json"), manifest);
  await assert.rejects(buildSingle({ root }), /fails the publishable bucket predicate/);
});

test("rejects a payload whose hash is stale", async () => {
  const { root } = await makeFixture();
  const payloadFile = path.join(root, "src", "data", "certified-seeds.json");
  const payload = JSON.parse(await readFile(payloadFile, "utf8"));
  payload.deals[0].canonicalSeed = "u64:0000000000000002";
  await writeJson(payloadFile, payload);
  await assert.rejects(buildSingle({ root }), /payload hash mismatch/i);
});

test("rejects external module dependencies", async () => {
  const { root } = await makeFixture({ externalImport: true });
  await assert.rejects(buildSingle({ root }), /External module specifier is forbidden/);
});

test("rejects a bundle that exceeds the approved size budget", async () => {
  const { root } = await makeFixture();
  await writeJson(path.join(root, "src", "data", "build-budget.json"), {
    schemaVersion: 1,
    maximumBundleBytes: 1,
    maximumRuntimeSourceBytes: 10000,
    maximumAssetBytes: 10000,
    maximumManifestBytes: 10000,
  });
  await assert.rejects(buildSingle({ root }), /exceeds maximumBundleBytes/);
});

test("verification rejects an artifact modified after the build report", async () => {
  const { root } = await makeFixture();
  await buildSingle({ root });
  const htmlFile = path.join(root, "dist", "index.html");
  await writeFile(htmlFile, `${await readFile(htmlFile, "utf8")}\n<!-- tampered -->\n`);
  await assert.rejects(verifyDistribution({ root }), /artifact hash does not match build report/);
});

test("verification recomputes compression and bucket report fields", async () => {
  const { root } = await makeFixture();
  await buildSingle({ root });
  const reportFile = path.join(root, "artifacts", "build", "build-report.json");
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  report.seedPayloadGzipBytes += 1;
  await writeJson(reportFile, report);
  await assert.rejects(verifyDistribution({ root }), /Payload gzip byte size does not match build report/);
});

test("verification requires labeled parse and build memory measurements", async () => {
  const { root } = await makeFixture();
  await buildSingle({ root });
  const reportFile = path.join(root, "artifacts", "build", "build-report.json");
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  report.jsonParseBenchmark.environment = "browser";
  await writeJson(reportFile, report);
  await assert.rejects(verifyDistribution({ root }), /benchmark environment must be node-build-process/);
});

test("bundles the repository's complete browser module graph", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "spider-real-source-build-"));
  const config = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "src", "config", "seed-pool-config.json"), "utf8"));
  for (const bucket of Object.values(config.buckets)) {
    bucket.certifiedTarget = 0;
    bucket.embeddedTarget = 0;
    bucket.minimumPublishableCount = 0;
    bucket.allowEmptyBucket = true;
  }
  const payload = { payloadSchemaVersion: 1, seedLibraryVersion: "source-graph-test", deals: [] };
  const buckets = Object.fromEntries(Object.entries(config.buckets).map(([id, bucket]) => [id, {
    ...bucket,
    candidatesScanned: 0,
    candidateScanScope: bucket.enabled ? "bucket" : "disabled",
    rawCertifiedCount: 0,
    actualCount: 0,
    embeddedCount: 0,
    encodedBytes: 0,
  }]));
  const payloadIndex = Object.fromEntries(Object.keys(config.buckets).map((id) => [id, { startOffset: 0, entryCount: 0 }]));
  const manifest = {
    schemaVersion: 1,
    configVersion: config.configVersion,
    createdAt: "2026-01-01T00:00:00.000Z",
    payloadSchemaVersion: 1,
    seedLibraryVersion: payload.seedLibraryVersion,
    parentLibraryVersion: null,
    minRuntimeVersion: "0.1.0",
    maxRuntimeVersion: "0.1.x",
    ruleVersion: config.ruleVersion,
    generatorVersion: config.generatorVersion,
    solverVersion: "test",
    solverConfigHash: "c".repeat(64),
    validatorVersion: "test",
    classifierVersion: "test",
    calibrationDatasetHash: "d".repeat(64),
    classificationCatalogHash: "e".repeat(64),
    classificationStatus: "provisional",
    configHash: sha256Canonical(config),
    payloadHash: sha256Canonical(payload),
    libraryHash: sha256Canonical([]),
    certificateCatalogHash: EMPTY_CATALOG_HASH,
    maximumEmbeddedCount: config.maximumEmbeddedCount,
    maximumEmbeddedBytes: config.maximumEmbeddedBytes,
    buckets,
    payloadIndex,
    deals: [],
    totalEmbeddedCount: 0,
    totalEncodedBytes: 0,
  };
  const configFile = path.join(temporary, "config.json");
  const manifestFile = path.join(temporary, "manifest.json");
  const payloadFile = path.join(temporary, "payload.json");
  const budgetFile = path.join(temporary, "budget.json");
  const htmlFile = path.join(temporary, "index.html");
  const reportFile = path.join(temporary, "build-report.json");
  await writeJson(configFile, config);
  await writeJson(manifestFile, manifest);
  await writeJson(payloadFile, payload);
  await writeJson(budgetFile, {
    schemaVersion: 1,
    maximumBundleBytes: 8388608,
    maximumRuntimeSourceBytes: 2097152,
    maximumAssetBytes: 2097152,
    maximumManifestBytes: 2097152,
  });
  const report = await buildSingle({
    root: REPOSITORY_ROOT,
    config: configFile,
    manifest: manifestFile,
    payload: payloadFile,
    budget: budgetFile,
    out: htmlFile,
    report: reportFile,
  });
  assert.ok(report.moduleCount >= 4);
  await verifyDistribution({
    root: REPOSITORY_ROOT,
    config: configFile,
    budget: budgetFile,
    html: htmlFile,
    report: reportFile,
  });
});
