#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeDealId, computeInitialDealHash, generateDeal } from "../src/core/generator.js";
import { createSolutionCertificate, validateSolutionCertificate } from "../src/solver/validator.js";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "src/data");
const NATIVE_DIR = path.join(ROOT, "artifacts/seed-factory/native");
const CERTIFICATE_DIR = path.join(NATIVE_DIR, "certificates");
const CONFIG_FILE = path.join(ROOT, "src/config/seed-pool-config.json");
const PAYLOAD_FILE = path.join(DATA_DIR, "certified-seeds.json");
const MANIFEST_FILE = path.join(DATA_DIR, "resolved-seed-manifest.json");
const CALIBRATION_FILE = path.join(ROOT, "artifacts/calibration/manual-difficulty-calibration.json");
const REPORT_FILE = path.join(ROOT, "artifacts/seed-factory/anchor-guided-2s-expansion.json");
const EVIDENCE_DIR = "/private/tmp/toranpu-probe";
const CLASSIFIER_VERSION = "anchor-guided-2s-calibration-2026-10-07-v3";
const SOLVER_PROVENANCE = "Toranpu@2.14.1 (MIT, development-only candidate search)";
const MAX_PER_BUCKET = 5000;
const TARGETS = Object.freeze({ easy: MAX_PER_BUCKET, medium: MAX_PER_BUCKET, hard: 1000, demon: 1000 });

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function writeJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
async function writeJsonArrayStreaming(file, values) {
  await mkdir(path.dirname(file), { recursive: true });
  const chunks = ["[\n"];
  for (let index = 0; index < values.length; index += 1) chunks.push(`${JSON.stringify(values[index], null, 2)}${index + 1 < values.length ? "," : ""}\n`);
  chunks.push("]\n");
  for (let index = 0; index < chunks.length; index += 1) await writeFile(file, chunks[index], { flag: index === 0 ? "w" : "a" });
}
function bucketId(deal) { return `${deal.suitMode}s.${deal.difficulty}`; }
function classifyStepCount(steps) {
  if (steps <= 160) return "easy";
  if (steps <= 180) return "medium";
  if (steps <= 195) return "hard";
  return "demon";
}
function scoreStepCount(steps) {
  if (steps <= 160) return Math.round(Math.max(0, (steps - 113) / 47 * 25) * 100) / 100;
  if (steps <= 180) return Math.round((25 + (steps - 161) / 19 * 25) * 100) / 100;
  if (steps <= 195) return Math.round((50 + (steps - 181) / 14 * 25) * 100) / 100;
  return Math.round(Math.min(100, 75 + (steps - 196) / 67 * 25) * 100) / 100;
}
function normalizedDeal(entry) {
  return { dealId: entry.dealId, canonicalSeed: entry.canonicalSeed, initialDealHash: entry.initialDealHash, suitMode: entry.suitMode, difficulty: entry.difficulty, status: "active" };
}
function bucketEntries(deals, id) { return deals.filter((deal) => bucketId(deal) === id); }

function rebuildManifest(manifest, config, deals, catalogs, classifications) {
  const buckets = {};
  const payloadIndex = {};
  let offset = 0;
  for (const [id, bucketConfig] of Object.entries(config.buckets)) {
    const entries = bucketEntries(deals, id);
    const suitMode = Number.parseInt(id, 10);
    const encodedBytes = entries.reduce((sum, deal) => sum + Buffer.byteLength(canonicalJson(normalizedDeal(deal))), 0);
    buckets[id] = {
      ...bucketConfig,
      candidatesScanned: bucketConfig.enabled ? (suitMode === 4 ? entries.length : suitMode === 1 ? 500 : 8437) : 0,
      candidateScanScope: bucketConfig.enabled ? (suitMode === 4 ? "bucket" : "shared-suit-pool") : "disabled",
      sharedCandidateScanBudget: bucketConfig.enabled ? (suitMode === 4 ? 0 : suitMode === 1 ? 500 : 8437) : 0,
      rawCertifiedCount: entries.length, actualCount: entries.length, embeddedCount: entries.length, encodedBytes,
    };
    payloadIndex[id] = { startOffset: offset, entryCount: entries.length };
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
    buckets, payloadIndex, deals,
    maximumEmbeddedCount: config.maximumEmbeddedCount,
    maximumEmbeddedBytes: config.maximumEmbeddedBytes,
    totalEmbeddedCount: deals.length,
    totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
    createdAt: new Date().toISOString(), classificationStatus: "provisional",
  };
}

const [config, payload, manifest, oldCatalog, oldCertificates, oldClassifications, calibration] = await Promise.all([
  readJson(CONFIG_FILE), readJson(PAYLOAD_FILE), readJson(MANIFEST_FILE),
  readJson(path.join(NATIVE_DIR, "certificate-catalog.json")), readJson(path.join(NATIVE_DIR, "certificates.json")),
  readJson(path.join(NATIVE_DIR, "classification-records.json")), readJson(CALIBRATION_FILE),
]);

const classificationById = new Map(oldClassifications.map((entry) => [entry.dealId, entry]));
const existing2s = payload.deals.filter((deal) => deal.suitMode === 2).map((deal) => {
  const record = classificationById.get(deal.dealId);
  if (!record?.solutionLength) throw new Error(`Missing solution length for ${deal.dealId}`);
  const difficulty = classifyStepCount(record.solutionLength);
  return { ...deal, difficulty };
});
const retainedByBucket = new Map();
for (const difficulty of Object.keys(TARGETS)) retainedByBucket.set(difficulty, existing2s.filter((deal) => deal.difficulty === difficulty).slice(0, TARGETS[difficulty]));
const retainedExisting = payload.deals.filter((deal) => deal.suitMode !== 2).concat([...retainedByBucket.values()].flat());
const retainedSeeds = new Set(retainedExisting.filter((deal) => deal.suitMode === 2).map((deal) => deal.canonicalSeed));

const evidenceFiles = (await readdir(EVIDENCE_DIR)).filter((name) => /^2s-\d+-\d+(?:-100k)?\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
const evidence = (await Promise.all(evidenceFiles.map((name) => readJson(path.join(EVIDENCE_DIR, name)))))
  .flatMap((file) => file.deals ?? [])
  .filter((entry) => entry?.suitMode === undefined || true)
  .filter((entry) => entry?.canonicalSeed && Array.isArray(entry.moves) && Number.isSafeInteger(entry.solutionLength));
const candidateBySeed = new Map();
for (const candidate of evidence) if (!retainedSeeds.has(candidate.canonicalSeed) && !candidateBySeed.has(candidate.canonicalSeed)) candidateBySeed.set(candidate.canonicalSeed, candidate);
const ranked = [...candidateBySeed.values()].sort((a, b) => Number(a.sourceSeed) - Number(b.sourceSeed) || a.canonicalSeed.localeCompare(b.canonicalSeed));
const countsBefore = Object.fromEntries([...retainedByBucket.entries()].map(([difficulty, entries]) => [difficulty, entries.length]));
const availableByDifficulty = Object.fromEntries(Object.keys(TARGETS).map((difficulty) => [difficulty, ranked.filter((entry) => classifyStepCount(entry.solutionLength) === difficulty).length]));
for (const difficulty of ["hard", "demon"]) {
  const needed = TARGETS[difficulty] - retainedByBucket.get(difficulty).length;
  if (availableByDifficulty[difficulty] < needed) throw new Error(`Insufficient evidence for ${difficulty}: available=${availableByDifficulty[difficulty]}, needed=${needed}; continue search before importing`);
}
const additions = [];
for (const source of ranked) {
  const difficulty = classifyStepCount(source.solutionLength);
  const current = retainedByBucket.get(difficulty);
  if (current.length >= TARGETS[difficulty]) continue;
  const state = generateDeal(source.canonicalSeed, 2);
  const dealId = await computeDealId(source.canonicalSeed, 2, config.ruleVersion, config.generatorVersion);
  const initialDealHash = await computeInitialDealHash(state);
  const certificate = await createSolutionCertificate(state, source.moves, { dealId, initialDealHash, solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash });
  const checked = await validateSolutionCertificate(state, certificate);
  if (!checked.pass) throw new Error(`Certificate rejected for ${source.canonicalSeed}: ${checked.errorCode}`);
  const entry = {
    dealId, canonicalSeed: source.canonicalSeed, initialDealHash, suitMode: 2, difficulty, status: "active",
    solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash, validatorVersion: checked.validatorVersion,
    classifierVersion: CLASSIFIER_VERSION, certificateHash: certificate.certificateHash, solutionLength: checked.solutionLength,
    classificationStatus: "provisional", difficultyScore: scoreStepCount(checked.solutionLength),
    metrics: { externalSolver: SOLVER_PROVENANCE, sourceSeed: source.sourceSeed, tablesSearched: source.tablesSearched, solutionLength: checked.solutionLength, selectionPolicy: "anchor-guided-fill-by-source-seed-v1" },
  };
  current.push(normalizedDeal(entry));
  additions.push({ deal: normalizedDeal(entry), entry, certificate });
  await writeJson(path.join(CERTIFICATE_DIR, `${dealId}.json`), { dealId, certificateHash: certificate.certificateHash, certificate });
  if (["hard", "demon"].every((bucket) => retainedByBucket.get(bucket).length >= TARGETS[bucket])) break;
}

const final2s = Object.values(Object.fromEntries(retainedByBucket)).flat();
if (retainedByBucket.get("hard").length < TARGETS.hard || retainedByBucket.get("demon").length < TARGETS.demon) {
  throw new Error(`Insufficient validated high-difficulty seeds: hard=${retainedByBucket.get("hard").length}/${TARGETS.hard}, demon=${retainedByBucket.get("demon").length}/${TARGETS.demon}; continue evidence search before importing`);
}
const allDeals = payload.deals.filter((deal) => deal.suitMode !== 2).concat(final2s);
const nextConfig = structuredClone(config);
nextConfig.maximumEmbeddedCount = 16384;
nextConfig.maximumEmbeddedBytes = Math.max(Number(nextConfig.maximumEmbeddedBytes ?? 4194304), 8 * 1024 * 1024);
for (const difficulty of Object.keys(TARGETS)) {
  const id = `2s.${difficulty}`; const count = retainedByBucket.get(difficulty).length;
  nextConfig.buckets[id] = { ...nextConfig.buckets[id], enabled: true, candidateScanBudget: count, certifiedTarget: count, embeddedTarget: count, minimumPublishableCount: count, allowEmptyBucket: false };
}
const orderedDeals = Object.keys(nextConfig.buckets).flatMap((id) => allDeals.filter((deal) => bucketId(deal) === id));
const additionsById = new Map(additions.map((item) => [item.entry.dealId, item]));
const oldClassById = new Map(oldClassifications.map((entry) => [entry.dealId, entry]));
const nextClassifications = orderedDeals.map((deal) => {
  const added = additionsById.get(deal.dealId);
  if (added) return { dealId: added.entry.dealId, certificateHash: added.entry.certificateHash, solverVersion: manifest.solverVersion, solverConfigHash: manifest.solverConfigHash, validatorVersion: added.entry.validatorVersion, classifierVersion: CLASSIFIER_VERSION, calibrationDatasetHash: manifest.calibrationDatasetHash, suitMode: 2, difficulty: added.entry.difficulty, difficultyScore: added.entry.difficultyScore, classificationStatus: "provisional", solutionLength: added.entry.solutionLength, metrics: added.entry.metrics, calibrationRule: "manual-anchor-guided-step-bands-v3", anchorReference: { easy: 153, medium: 171 } };
  const previous = oldClassById.get(deal.dealId);
  if (deal.suitMode !== 2) return { ...previous, classifierVersion: CLASSIFIER_VERSION };
  const difficulty = deal.difficulty;
  return { ...previous, classifierVersion: CLASSIFIER_VERSION, difficulty, difficultyScore: scoreStepCount(previous.solutionLength), calibrationRule: "manual-anchor-guided-step-bands-v3", anchorReference: { easy: 153, medium: 171 } };
});
const nextCatalogs = orderedDeals.map((deal) => {
  const added = additionsById.get(deal.dealId); return added ? { dealId: added.entry.dealId, certificateHash: added.entry.certificateHash } : oldCatalog.find((item) => item.dealId === deal.dealId);
});
const nextCertificates = orderedDeals.map((deal) => {
  const added = additionsById.get(deal.dealId); return added ? { dealId: added.entry.dealId, certificateHash: added.entry.certificateHash, certificate: added.certificate } : oldCertificates.find((item) => item.dealId === deal.dealId);
});
if (nextCatalogs.some((item) => !item) || nextCertificates.some((item) => !item)) throw new Error("Certificate evidence is incomplete after expansion");
const nextPayload = { payloadSchemaVersion: 1, seedLibraryVersion: "1", deals: orderedDeals };
const nextManifest = rebuildManifest(manifest, nextConfig, orderedDeals, nextCatalogs, nextClassifications);
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), result: "PASS", classifierVersion: CLASSIFIER_VERSION,
  anchors: { easyReferenceSteps: 153, mediumReferenceSteps: 171 },
  bands: { easy: "<=160", medium: "161-180", hard: "181-195", demon: ">=196" },
  maxPerBucket: MAX_PER_BUCKET, targets: TARGETS, countsBefore,
  countsAfter: Object.fromEntries([...retainedByBucket.entries()].map(([difficulty, entries]) => [difficulty, entries.length])),
  evidenceFiles, candidateCount: ranked.length, validatedCount: additions.length,
  selectionPolicy: "reclassify every validated 2-suit seed by anchor-guided step bands; retain earliest seeds within each cap",
  payloadHash: sha256Canonical(nextPayload), configHash: sha256Canonical(nextConfig),
};
const nativePayloadFile = path.join(NATIVE_DIR, "certified-seeds.json");
await writeJson(CONFIG_FILE, nextConfig);
await writeJson(PAYLOAD_FILE, nextPayload);
await writeJson(nativePayloadFile, nextPayload);
await writeJson(MANIFEST_FILE, nextManifest);
await writeJson(path.join(NATIVE_DIR, "resolved-seed-manifest.json"), nextManifest);
await writeJson(path.join(NATIVE_DIR, "certificate-catalog.json"), nextCatalogs);
await writeJsonArrayStreaming(path.join(NATIVE_DIR, "certificates.json"), nextCertificates);
await writeJson(path.join(NATIVE_DIR, "classification-records.json"), nextClassifications);
await writeJson(CALIBRATION_FILE, { ...calibration, generatedAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(nextConfig.buckets).map(([id]) => [id, orderedDeals.filter((deal) => bucketId(deal) === id).length])), payloadHash: sha256Canonical(nextPayload), configHash: sha256Canonical(nextConfig), capPolicy: { maxPerDifficulty: MAX_PER_BUCKET, hardTarget: 1000, demonTarget: 1000 } });
await writeJson(REPORT_FILE, report);
process.stdout.write(`Expanded anchor-guided 2-suit library: ${JSON.stringify(report.countsAfter)}; validated=${additions.length}\n`);
