#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeDealId, computeInitialDealHash, generateDeal } from "../src/core/generator.js";
import { createSolutionCertificate, validateSolutionCertificate } from "../src/solver/validator.js";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_FILE = path.join(ROOT, "src/config/seed-pool-config.json");
const PAYLOAD_FILE = path.join(ROOT, "src/data/certified-seeds.json");
const MANIFEST_FILE = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const NATIVE_DIR = path.join(ROOT, "artifacts/seed-factory/native");
const CERTIFICATE_DIR = path.join(NATIVE_DIR, "certificates");
const EVIDENCE_FILES = [
  "/private/tmp/toranpu-probe/2s-5401-6100.json",
  "/private/tmp/toranpu-probe/2s-6101-6800.json",
  "/private/tmp/toranpu-probe/2s-6801-7500.json",
  "/private/tmp/toranpu-probe/2s-7501-8200.json",
  "/private/tmp/toranpu-probe/2s-8201-8900.json",
];
const HARD_TARGET = 1250;
const DEMON_TARGET = 1250;
const CLASSIFIER_VERSION = "manual-human-calibration-2s-v2";
const SOLVER_PROVENANCE = "Toranpu@2.14.1 (MIT, development-only candidate search)";

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function writeJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
function normalizedDeal(entry) {
  return { dealId: entry.dealId, canonicalSeed: entry.canonicalSeed, initialDealHash: entry.initialDealHash, suitMode: entry.suitMode, difficulty: entry.difficulty, status: "active" };
}
function complexityCompare(left, right) {
  return right.solutionLength - left.solutionLength || right.tablesSearched - left.tablesSearched || left.canonicalSeed.localeCompare(right.canonicalSeed);
}
function bucketConfigFor(config, bucketId, count) {
  return { ...config.buckets[bucketId], enabled: true, candidateScanBudget: count, certifiedTarget: count, embeddedTarget: count, minimumPublishableCount: count, allowEmptyBucket: false };
}
function rebuild(config, manifest, deals, catalogs, classifications) {
  const buckets = {};
  const payloadIndex = {};
  let offset = 0;
  for (const [bucketId, bucketConfig] of Object.entries(config.buckets)) {
    const entries = deals.filter((deal) => `${deal.suitMode}s.${deal.difficulty}` === bucketId);
    const suitMode = Number.parseInt(bucketId, 10);
    const encodedBytes = entries.reduce((sum, deal) => sum + Buffer.byteLength(canonicalJson(deal)), 0);
    buckets[bucketId] = {
      ...bucketConfig,
      candidatesScanned: bucketConfig.enabled ? (suitMode === 4 ? entries.length : suitMode === 1 ? 500 : 8437) : 0,
      candidateScanScope: bucketConfig.enabled ? (suitMode === 4 ? "bucket" : "shared-suit-pool") : "disabled",
      sharedCandidateScanBudget: bucketConfig.enabled ? (suitMode === 4 ? 0 : suitMode === 1 ? 500 : 8437) : 0,
      rawCertifiedCount: entries.length, actualCount: entries.length, embeddedCount: entries.length, encodedBytes,
    };
    payloadIndex[bucketId] = { startOffset: offset, entryCount: entries.length };
    offset += entries.length;
  }
  return {
    ...manifest,
    classifierVersion: CLASSIFIER_VERSION,
    classificationCatalogHash: sha256Canonical(classifications),
    configHash: sha256Canonical(config),
    payloadHash: sha256Canonical({ payloadSchemaVersion: 1, seedLibraryVersion: "1", deals }),
    libraryHash: sha256Canonical(deals),
    certificateCatalogHash: sha256Canonical(catalogs),
    buckets, payloadIndex, deals, totalEmbeddedCount: deals.length,
    totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
    createdAt: new Date().toISOString(), classificationStatus: "provisional",
  };
}

const [config, payload, manifest, oldCatalog, oldCertificates, oldClassifications] = await Promise.all([
  readJson(CONFIG_FILE), readJson(PAYLOAD_FILE), readJson(MANIFEST_FILE),
  readJson(path.join(NATIVE_DIR, "certificate-catalog.json")), readJson(path.join(NATIVE_DIR, "certificates.json")),
  readJson(path.join(NATIVE_DIR, "classification-records.json")),
]);
const candidates = (await Promise.all(EVIDENCE_FILES.map(readJson))).flatMap((file) => file.deals)
  .filter((deal) => deal?.canonicalSeed?.startsWith("u64:20000000"));
const deduped = [...new Map(candidates.map((deal) => [deal.canonicalSeed, deal])).values()];
const existingSeeds = new Set(payload.deals.filter((deal) => deal.suitMode === 2).map((deal) => deal.canonicalSeed));
const ranked = deduped.filter((deal) => !existingSeeds.has(deal.canonicalSeed)).sort(complexityCompare);
if (ranked.length < HARD_TARGET + DEMON_TARGET) throw new Error(`Need ${HARD_TARGET + DEMON_TARGET} new candidates, found ${ranked.length}`);
const selected = [
  ...ranked.slice(0, DEMON_TARGET).map((deal) => ({ ...deal, difficulty: "demon" })),
  ...ranked.slice(DEMON_TARGET, DEMON_TARGET + HARD_TARGET).map((deal) => ({ ...deal, difficulty: "hard" })),
];
const additions = [];
for (const source of selected) {
  const state = generateDeal(source.canonicalSeed, 2);
  const dealId = await computeDealId(source.canonicalSeed, 2, config.ruleVersion, config.generatorVersion);
  const initialDealHash = await computeInitialDealHash(state);
  const certificate = await createSolutionCertificate(state, source.moves, { dealId, initialDealHash, solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash });
  const checked = await validateSolutionCertificate(state, certificate);
  if (!checked.pass) throw new Error(`Certificate rejected for ${source.canonicalSeed}: ${checked.errorCode}`);
  const entry = {
    dealId, canonicalSeed: source.canonicalSeed, initialDealHash, suitMode: 2, difficulty: source.difficulty,
    status: "active", solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash,
    validatorVersion: checked.validatorVersion, classifierVersion: CLASSIFIER_VERSION,
    certificateHash: certificate.certificateHash, solutionLength: checked.solutionLength, classificationStatus: "provisional",
    difficultyScore: source.difficulty === "demon" ? 100 : 75,
    metrics: { externalSolver: SOLVER_PROVENANCE, sourceSeed: source.sourceSeed, tablesSearched: source.tablesSearched, solutionLength: checked.solutionLength, selectionPolicy: "new-candidate-tail-v1" },
  };
  additions.push({ deal: normalizedDeal(entry), entry, certificate });
  await writeJson(path.join(CERTIFICATE_DIR, `${dealId}.json`), { dealId, certificateHash: certificate.certificateHash, certificate });
}

const nextConfig = structuredClone(config);
nextConfig.buckets["2s.hard"] = bucketConfigFor(nextConfig, "2s.hard", HARD_TARGET);
nextConfig.buckets["2s.demon"] = bucketConfigFor(nextConfig, "2s.demon", DEMON_TARGET);
const allDeals = [
  ...payload.deals.filter((deal) => !["2s.hard", "2s.demon"].includes(`${deal.suitMode}s.${deal.difficulty}`)),
  ...additions.map((item) => item.deal),
];
const orderedDeals = Object.keys(nextConfig.buckets).flatMap((bucketId) => allDeals.filter((deal) => `${deal.suitMode}s.${deal.difficulty}` === bucketId));
const catalogs = [...oldCatalog, ...additions.map((item) => ({ dealId: item.entry.dealId, certificateHash: item.entry.certificateHash }))];
const certificates = [...oldCertificates, ...additions.map((item) => ({ dealId: item.entry.dealId, certificateHash: item.entry.certificateHash, certificate: item.certificate }))];
const classifications = [...oldClassifications.map((entry) => ({ ...entry, classifierVersion: CLASSIFIER_VERSION })).filter((entry) => !additions.some((item) => item.entry.dealId === entry.dealId)), ...additions.map((item) => ({
  dealId: item.entry.dealId, certificateHash: item.entry.certificateHash, solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash,
  validatorVersion: item.entry.validatorVersion, classifierVersion: CLASSIFIER_VERSION, calibrationDatasetHash: manifest.calibrationDatasetHash,
  suitMode: 2, difficulty: item.entry.difficulty, difficultyScore: item.entry.difficultyScore, classificationStatus: "provisional",
  solutionLength: item.entry.solutionLength, metrics: item.entry.metrics,
}))];
const nextPayload = { payloadSchemaVersion: 1, seedLibraryVersion: "1", deals: orderedDeals };
const nextManifest = rebuild(nextConfig, manifest, orderedDeals, catalogs, classifications);
const nativeManifest = rebuild(nextConfig, manifest, orderedDeals, catalogs, classifications);
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), result: "PASS", classifierVersion: CLASSIFIER_VERSION,
  solverProvenance: SOLVER_PROVENANCE, sourceRanges: [[5401, 6100], [6101, 6800], [6801, 7500], [7501, 8200], [8201, 8900]],
  candidateCount: ranked.length, selectedCount: selected.length, hardCount: HARD_TARGET, demonCount: DEMON_TARGET,
  selectionPolicy: "sort by solutionLength descending, then tablesSearched descending; top 1,250 demon and next 1,250 hard",
  validatedCount: additions.length, payloadHash: sha256Canonical(nextPayload), configHash: sha256Canonical(nextConfig),
};
await Promise.all([
  writeJson(CONFIG_FILE, nextConfig), writeJson(PAYLOAD_FILE, nextPayload), writeJson(path.join(NATIVE_DIR, "certified-seeds.json"), nextPayload),
  writeJson(MANIFEST_FILE, nextManifest), writeJson(path.join(NATIVE_DIR, "resolved-seed-manifest.json"), nativeManifest),
  writeJson(path.join(NATIVE_DIR, "certificate-catalog.json"), catalogs), writeJson(path.join(NATIVE_DIR, "certificates.json"), certificates),
  writeJson(path.join(NATIVE_DIR, "classification-records.json"), classifications), writeJson(path.join(ROOT, "artifacts/seed-factory/toranpu-2s-hard-demon-import.json"), report),
]);
process.stdout.write(`Imported new 2-suit hard/demon certificates: ${JSON.stringify({ hard: HARD_TARGET, demon: DEMON_TARGET, total: orderedDeals.length })}\n`);
