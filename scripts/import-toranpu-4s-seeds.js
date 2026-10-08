#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeDealId,
  computeInitialDealHash,
  generateDeal,
} from "../src/core/generator.js";
import {
  createSolutionCertificate,
  validateSolutionCertificate,
} from "../src/solver/validator.js";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const EVIDENCE_FILE = path.join(ROOT, "artifacts/seed-factory/toranpu-4s/solution-evidence.json");
const CONFIG_FILE = path.join(ROOT, "src/config/seed-pool-config.json");
const MANIFEST_FILE = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const PAYLOAD_FILE = path.join(ROOT, "src/data/certified-seeds.json");
const NATIVE_DIR = path.join(ROOT, "artifacts/seed-factory/native");
const CERTIFICATE_DIR = path.join(NATIVE_DIR, "certificates");

const DIFFICULTIES = ["easy", "medium", "hard", "demon"];
const SOLVER_PROVENANCE = "Toranpu@2.14.0 (MIT, development-only candidate search)";

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
    suitMode: 4,
    difficulty: entry.difficulty,
    status: "active",
  };
}

async function main() {
  const [evidence, config, manifest, payload, catalog, certificates, classifications] = await Promise.all([
    readJson(EVIDENCE_FILE),
    readJson(CONFIG_FILE),
    readJson(MANIFEST_FILE),
    readJson(PAYLOAD_FILE),
    readJson(path.join(NATIVE_DIR, "certificate-catalog.json")),
    readJson(path.join(NATIVE_DIR, "certificates.json")),
    readJson(path.join(NATIVE_DIR, "classification-records.json")),
  ]);
  if (evidence.schemaVersion !== 1 || evidence.suitMode !== 4 || !Array.isArray(evidence.deals) || evidence.deals.length !== 8) {
    throw new Error("Toranpu evidence must contain exactly eight 4-suit deals");
  }
  if (evidence.deals.some((deal) => !Array.isArray(deal.moves) || deal.moves.length < 1)) {
    throw new Error("Toranpu evidence contains an empty solution");
  }
  const sorted = [...evidence.deals].sort((left, right) => left.solutionLength - right.solutionLength || left.canonicalSeed.localeCompare(right.canonicalSeed));
  const difficultyBySeed = new Map(sorted.map((deal, index) => [deal.canonicalSeed, DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, Math.floor(index / 2))]]));
  const existingIds = new Set(payload.deals.map((deal) => deal.dealId));
  const addedDeals = [];
  const addedCertificates = [];
  const addedCatalog = [];
  const addedClassifications = [];
  const validation = [];

  for (const source of evidence.deals) {
    const difficulty = difficultyBySeed.get(source.canonicalSeed);
    const state = generateDeal(source.canonicalSeed, 4);
    const dealId = await computeDealId(source.canonicalSeed, 4, config.ruleVersion, config.generatorVersion);
    const initialDealHash = await computeInitialDealHash(state);
    if (existingIds.has(dealId)) throw new Error(`Toranpu deal duplicates existing deal ${dealId}`);
    const certificate = await createSolutionCertificate(state, source.moves, {
      dealId,
      initialDealHash,
      solverVersion: manifest.solverVersion,
      solverConfigHash: manifest.solverConfigHash,
    });
    const checked = await validateSolutionCertificate(state, certificate);
    if (!checked.pass) throw new Error(`Toranpu certificate rejected for ${source.canonicalSeed}: ${checked.errorCode}`);
    const entry = {
      dealId,
      canonicalSeed: source.canonicalSeed,
      initialDealHash,
      suitMode: 4,
      difficulty,
      status: "active",
      solverVersion: manifest.solverVersion,
      solverConfigHash: manifest.solverConfigHash,
      validatorVersion: checked.validatorVersion,
      classifierVersion: manifest.classifierVersion,
      certificateHash: certificate.certificateHash,
      solutionLength: checked.solutionLength,
      difficultyScore: Math.round(sorted.findIndex((deal) => deal.canonicalSeed === source.canonicalSeed) * 10000 / (sorted.length - 1)) / 100,
      classificationStatus: "provisional",
      metrics: {
        externalSolver: SOLVER_PROVENANCE,
        sourceSeed: source.sourceSeed,
        tablesSearched: source.tablesSearched,
        solutionLength: checked.solutionLength,
      },
    };
    const runtime = normalizedDeal(entry);
    addedDeals.push(runtime);
    addedCertificates.push({ dealId, certificateHash: certificate.certificateHash, certificate });
    addedCatalog.push({ dealId, certificateHash: certificate.certificateHash });
    addedClassifications.push({
      dealId,
      certificateHash: certificate.certificateHash,
      solverVersion: manifest.solverVersion,
      solverConfigHash: manifest.solverConfigHash,
      validatorVersion: checked.validatorVersion,
      classifierVersion: manifest.classifierVersion,
      calibrationDatasetHash: manifest.calibrationDatasetHash,
      suitMode: 4,
      difficulty,
      difficultyScore: entry.difficultyScore,
      classificationStatus: "provisional",
      solutionLength: checked.solutionLength,
      metrics: entry.metrics,
    });
    validation.push({ sourceSeed: source.sourceSeed, canonicalSeed: source.canonicalSeed, dealId, difficulty, solutionLength: checked.solutionLength, certificateHash: certificate.certificateHash, result: "PASS" });
    await writeJson(path.join(CERTIFICATE_DIR, `${dealId}.json`), { dealId, certificateHash: certificate.certificateHash, certificate });
  }

  addedDeals.sort((left, right) => DIFFICULTIES.indexOf(left.difficulty) - DIFFICULTIES.indexOf(right.difficulty) || left.canonicalSeed.localeCompare(right.canonicalSeed));
  const nextPayload = { ...payload, deals: [...payload.deals, ...addedDeals] };
  const nextCatalog = [...catalog, ...addedCatalog];
  const nextCertificates = [...certificates, ...addedCertificates];
  const nextClassifications = [...classifications, ...addedClassifications];
  const nextManifest = structuredClone(manifest);
  nextManifest.configHash = sha256Canonical(config);
  nextManifest.payloadHash = sha256Canonical(nextPayload);
  nextManifest.libraryHash = sha256Canonical(nextPayload.deals);
  nextManifest.deals = nextPayload.deals;
  nextManifest.certificateCatalogHash = sha256Canonical(nextCatalog);
  nextManifest.classificationCatalogHash = sha256Canonical(nextClassifications);
  nextManifest.createdAt = new Date().toISOString();
  let offset = nextPayload.deals.length - addedDeals.length;
  for (const difficulty of DIFFICULTIES) {
    const bucketId = `4s.${difficulty}`;
    const bucketDeals = addedDeals.filter((deal) => deal.difficulty === difficulty);
    nextManifest.buckets[bucketId] = {
      enabled: true,
      candidateScanBudget: bucketDeals.length,
      certifiedTarget: bucketDeals.length,
      embeddedTarget: bucketDeals.length,
      minimumPublishableCount: bucketDeals.length,
      allowEmptyBucket: false,
      candidatesScanned: bucketDeals.length,
      candidateScanScope: "bucket",
      sharedCandidateScanBudget: 0,
      rawCertifiedCount: bucketDeals.length,
      actualCount: bucketDeals.length,
      embeddedCount: bucketDeals.length,
      encodedBytes: bucketDeals.reduce((sum, deal) => sum + Buffer.byteLength(canonicalJson(deal)), 0),
    };
    nextManifest.payloadIndex[bucketId] = { startOffset: offset, entryCount: bucketDeals.length };
    offset += bucketDeals.length;
  }
  nextManifest.totalEmbeddedCount = nextPayload.deals.length;
  nextManifest.totalEncodedBytes = Object.values(nextManifest.buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0);
  if (nextManifest.totalEmbeddedCount > config.maximumEmbeddedCount) throw new Error("4-suit expansion exceeds maximumEmbeddedCount");

  await Promise.all([
    writeJson(PAYLOAD_FILE, nextPayload),
    writeJson(MANIFEST_FILE, nextManifest),
    writeJson(path.join(NATIVE_DIR, "certified-seeds.json"), nextPayload),
    writeJson(path.join(NATIVE_DIR, "resolved-seed-manifest.json"), nextManifest),
    writeJson(path.join(NATIVE_DIR, "certificate-catalog.json"), nextCatalog),
    writeJson(path.join(NATIVE_DIR, "certificates.json"), nextCertificates),
    writeJson(path.join(NATIVE_DIR, "classification-records.json"), nextClassifications),
    writeJson(path.join(ROOT, "artifacts/seed-factory/toranpu-4s/import-report.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      solverProvenance: SOLVER_PROVENANCE,
      evidenceHash: sha256Canonical(evidence),
      validatedCount: validation.length,
      result: "PASS",
      deals: validation,
    }),
  ]);
  process.stdout.write(`Imported and independently validated ${validation.length} Toranpu 4-suit certificates\n`);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
