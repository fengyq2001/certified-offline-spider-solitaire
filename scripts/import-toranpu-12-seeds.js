#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeDealId, computeInitialDealHash, generateDeal } from "../src/core/generator.js";
import { createSolutionCertificate, validateSolutionCertificate } from "../src/solver/validator.js";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const EVIDENCE_FILE = path.join(ROOT, "artifacts/seed-factory/toranpu-12/solution-evidence.json");
const CONFIG_FILE = path.join(ROOT, "src/config/seed-pool-config.json");
const MANIFEST_FILE = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const PAYLOAD_FILE = path.join(ROOT, "src/data/certified-seeds.json");
const NATIVE_DIR = path.join(ROOT, "artifacts/seed-factory/native");
const CERTIFICATE_DIR = path.join(NATIVE_DIR, "certificates");
const DIFFICULTIES = ["easy", "medium", "hard", "demon"];
const SOLVER_PROVENANCE = "Toranpu@2.14.1 (MIT, development-only candidate search)";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizedDeal(entry) {
  return {
    dealId: entry.dealId,
    canonicalSeed: entry.canonicalSeed,
    initialDealHash: entry.initialDealHash,
    suitMode: entry.suitMode,
    difficulty: entry.difficulty,
    status: "active",
  };
}

function targetForSuit(config, suitMode) {
  return DIFFICULTIES.reduce((sum, difficulty) => sum + (config.buckets[`${suitMode}s.${difficulty}`]?.certifiedTarget ?? 0), 0);
}

function classify(evidenceDeals, suitMode, expected) {
  const sorted = evidenceDeals
    .filter((deal) => deal.suitMode === suitMode)
    .sort((left, right) => left.solutionLength - right.solutionLength || left.canonicalSeed.localeCompare(right.canonicalSeed));
  if (sorted.length !== expected) throw new Error(`${suitMode}-suit evidence must contain exactly ${expected} solved deals`);
  const bucketSize = expected / DIFFICULTIES.length;
  if (!Number.isSafeInteger(bucketSize)) throw new Error(`${suitMode}-suit certified target must divide evenly across ${DIFFICULTIES.length} difficulties`);
  return new Map(sorted.map((deal, index) => [deal.canonicalSeed, {
    difficulty: DIFFICULTIES[Math.floor(index / bucketSize)],
    difficultyScore: Math.round(index * 10000 / (expected - 1)) / 100,
  }]));
}

async function main() {
  const [evidence, config, manifest, oldPayload, oldCatalog, oldCertificates, oldClassifications] = await Promise.all([
    readJson(EVIDENCE_FILE), readJson(CONFIG_FILE), readJson(MANIFEST_FILE), readJson(PAYLOAD_FILE),
    readJson(path.join(NATIVE_DIR, "certificate-catalog.json")),
    readJson(path.join(NATIVE_DIR, "certificates.json")),
    readJson(path.join(NATIVE_DIR, "classification-records.json")),
  ]);
  const expectedBySuit = Object.fromEntries([1, 2].map((suitMode) => [suitMode, targetForSuit(config, suitMode)]));
  const expectedEvidenceCount = expectedBySuit[1] + expectedBySuit[2];
  if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.deals) || evidence.deals.length !== expectedEvidenceCount) {
    throw new Error(`Toranpu 1/2-suit evidence must contain exactly ${expectedEvidenceCount} deals`);
  }
  const evidenceDeals = evidence.deals.map((deal) => ({
    ...deal,
    suitMode: deal.suitMode ?? (deal.canonicalSeed?.startsWith("u64:10000000") ? 1 : deal.canonicalSeed?.startsWith("u64:20000000") ? 2 : null),
  }));
  for (const suitMode of [1, 2]) {
    const records = evidenceDeals.filter((deal) => deal.suitMode === suitMode);
    if (records.length !== expectedBySuit[suitMode]) throw new Error(`${suitMode}-suit evidence must contain ${expectedBySuit[suitMode]} deals`);
    const marker = suitMode === 1 ? "10000000" : "20000000";
    if (records.some((deal) => !new RegExp(`^u64:${marker}[0-9a-f]{8}$`).test(deal.canonicalSeed))) {
      throw new Error(`${suitMode}-suit evidence contains a seed outside its dedicated factory namespace`);
    }
  }

  const classifications = new Map([
    [1, classify(evidenceDeals, 1, expectedBySuit[1])],
    [2, classify(evidenceDeals, 2, expectedBySuit[2])],
  ]);
  const oldById = new Map(oldPayload.deals.map((deal) => [deal.dealId, deal]));
  const oldCatalogById = new Map(oldCatalog.map((entry) => [entry.dealId, entry]));
  const oldCertificateById = new Map(oldCertificates.map((entry) => [entry.dealId, entry]));
  const oldClassificationById = new Map(oldClassifications.map((entry) => [entry.dealId, entry]));
  const retained4s = oldPayload.deals.filter((deal) => deal.suitMode === 4);
  const added = [];
  const validation = [];
  for (const source of evidenceDeals) {
    const suitMode = source.suitMode;
    const state = generateDeal(source.canonicalSeed, suitMode);
    const dealId = await computeDealId(source.canonicalSeed, suitMode, config.ruleVersion, config.generatorVersion);
    const initialDealHash = await computeInitialDealHash(state);
    const classification = classifications.get(suitMode).get(source.canonicalSeed);
    const certificate = await createSolutionCertificate(state, source.moves, {
      dealId, initialDealHash, solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash,
    });
    const checked = await validateSolutionCertificate(state, certificate);
    if (!checked.pass) throw new Error(`Toranpu certificate rejected for ${source.canonicalSeed}: ${checked.errorCode}`);
    const entry = {
      dealId, canonicalSeed: source.canonicalSeed, initialDealHash, suitMode, difficulty: classification.difficulty,
      status: "active", solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash,
      validatorVersion: checked.validatorVersion, classifierVersion: manifest.classifierVersion,
      certificateHash: certificate.certificateHash, solutionLength: checked.solutionLength,
      difficultyScore: classification.difficultyScore, classificationStatus: "provisional",
      metrics: { externalSolver: SOLVER_PROVENANCE, sourceSeed: source.sourceSeed, tablesSearched: source.tablesSearched, solutionLength: checked.solutionLength },
    };
    added.push({ runtime: normalizedDeal(entry), entry, certificate });
    validation.push({ sourceSeed: source.sourceSeed, canonicalSeed: source.canonicalSeed, dealId, suitMode, difficulty: entry.difficulty, solutionLength: checked.solutionLength, certificateHash: certificate.certificateHash, result: "PASS" });
    await writeJson(path.join(CERTIFICATE_DIR, `${dealId}.json`), { dealId, certificateHash: certificate.certificateHash, certificate });
  }

  const addedByBucket = new Map();
  for (const item of added) {
    const bucketId = `${item.entry.suitMode}s.${item.entry.difficulty}`;
    if (!addedByBucket.has(bucketId)) addedByBucket.set(bucketId, []);
    addedByBucket.get(bucketId).push(item);
  }
  const retainedItems = retained4s.map((deal) => ({
    runtime: deal,
    entry: {
      ...deal,
      solverVersion: manifest.solverVersion,
      solverConfigHash: manifest.solverConfigHash,
      validatorVersion: manifest.validatorVersion,
      classifierVersion: manifest.classifierVersion,
      certificateHash: oldCatalogById.get(deal.dealId)?.certificateHash,
      solutionLength: oldClassificationById.get(deal.dealId)?.solutionLength,
      difficultyScore: oldClassificationById.get(deal.dealId)?.difficultyScore,
      classificationStatus: manifest.classificationStatus,
      metrics: oldClassificationById.get(deal.dealId)?.metrics,
    },
    certificate: oldCertificateById.get(deal.dealId)?.certificate,
  }));
  for (const item of retainedItems) if (!item.certificate) throw new Error(`Missing retained 4-suit certificate for ${item.runtime.dealId}`);
  for (const item of retainedItems) {
    const bucketId = `${item.entry.suitMode}s.${item.entry.difficulty}`;
    if (!addedByBucket.has(bucketId)) addedByBucket.set(bucketId, []);
    addedByBucket.get(bucketId).push(item);
  }

  const deals = [];
  const catalog = [];
  const certificates = [];
  const classificationRecords = [];
  const buckets = {};
  const payloadIndex = {};
  let offset = 0;
  for (const [bucketId, bucketConfig] of Object.entries(config.buckets)) {
    const entries = addedByBucket.get(bucketId) ?? [];
    entries.sort((left, right) => left.entry.solutionLength - right.entry.solutionLength || left.runtime.canonicalSeed.localeCompare(right.runtime.canonicalSeed));
    if (entries.length < bucketConfig.minimumPublishableCount) throw new Error(`${bucketId} has only ${entries.length} entries`);
    const selected = entries.slice(0, bucketConfig.embeddedTarget);
    deals.push(...selected.map((item) => item.runtime));
    for (const item of selected) {
      catalog.push({ dealId: item.entry.dealId, certificateHash: item.entry.certificateHash });
      certificates.push({ dealId: item.entry.dealId, certificateHash: item.entry.certificateHash, certificate: item.certificate });
      classificationRecords.push({
        dealId: item.entry.dealId, certificateHash: item.entry.certificateHash,
        solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash,
        validatorVersion: manifest.validatorVersion, classifierVersion: manifest.classifierVersion,
        calibrationDatasetHash: manifest.calibrationDatasetHash, suitMode: item.entry.suitMode,
        difficulty: item.entry.difficulty, difficultyScore: item.entry.difficultyScore,
        classificationStatus: manifest.classificationStatus, solutionLength: item.entry.solutionLength,
        metrics: item.entry.metrics,
      });
    }
    buckets[bucketId] = {
      ...bucketConfig,
      candidatesScanned: bucketId.startsWith("4s.") ? entries.length : expectedBySuit[Number.parseInt(bucketId, 10)],
      candidateScanScope: bucketId.startsWith("4s.") ? "bucket" : "shared-suit-pool",
      sharedCandidateScanBudget: bucketId.startsWith("4s.") ? 0 : expectedBySuit[Number.parseInt(bucketId, 10)],
      rawCertifiedCount: entries.length, actualCount: entries.length,
      embeddedCount: selected.length,
      encodedBytes: selected.reduce((sum, item) => sum + Buffer.byteLength(canonicalJson(item.runtime)), 0),
    };
    payloadIndex[bucketId] = { startOffset: offset, entryCount: selected.length };
    offset += selected.length;
  }
  const payload = { payloadSchemaVersion: 1, seedLibraryVersion: "1", deals };
  const nextManifest = {
    ...manifest,
    configHash: sha256Canonical(config), payloadHash: sha256Canonical(payload), libraryHash: sha256Canonical(deals),
    certificateCatalogHash: sha256Canonical(catalog), classificationCatalogHash: sha256Canonical(classificationRecords),
    buckets, payloadIndex, deals, totalEmbeddedCount: deals.length,
    totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
    maximumEmbeddedCount: config.maximumEmbeddedCount, maximumEmbeddedBytes: config.maximumEmbeddedBytes,
    createdAt: new Date().toISOString(), classificationStatus: "provisional",
  };
  const expectedRuntimeCount = Object.values(config.buckets).reduce((sum, bucket) => sum + bucket.embeddedTarget, 0);
  if (deals.length !== expectedRuntimeCount) throw new Error(`Expected ${expectedRuntimeCount} total runtime deals, got ${deals.length}`);
  if (nextManifest.totalEmbeddedCount > config.maximumEmbeddedCount || nextManifest.totalEncodedBytes > config.maximumEmbeddedBytes) throw new Error("Expanded payload exceeds configured limits");
  await Promise.all([
    writeJson(PAYLOAD_FILE, payload), writeJson(MANIFEST_FILE, nextManifest),
    writeJson(path.join(NATIVE_DIR, "certified-seeds.json"), payload),
    writeJson(path.join(NATIVE_DIR, "resolved-seed-manifest.json"), nextManifest),
    writeJson(path.join(NATIVE_DIR, "certificate-catalog.json"), catalog),
    writeJson(path.join(NATIVE_DIR, "certificates.json"), certificates),
    writeJson(path.join(NATIVE_DIR, "classification-records.json"), classificationRecords),
    writeJson(path.join(ROOT, "artifacts/seed-factory/toranpu-12/import-report.json"), {
      schemaVersion: 1, generatedAt: new Date().toISOString(), solverProvenance: SOLVER_PROVENANCE,
      evidenceHash: sha256Canonical(evidence), validatedCount: validation.length, result: "PASS", deals: validation,
    }),
  ]);
  process.stdout.write(`Imported and independently validated ${validation.length} Toranpu 1/2-suit certificates; total runtime pool ${deals.length}\n`);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
