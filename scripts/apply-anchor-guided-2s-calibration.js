#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_FILE = path.join(ROOT, "src/config/seed-pool-config.json");
const PAYLOAD_FILE = path.join(ROOT, "src/data/certified-seeds.json");
const MANIFEST_FILE = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const NATIVE_DIR = path.join(ROOT, "artifacts/seed-factory/native");
const REPORT_FILE = path.join(ROOT, "artifacts/calibration/manual-difficulty-calibration.json");
const CLASSIFIER_VERSION = "anchor-guided-2s-calibration-2026-10-07-v3";
const STEP_RULE = Object.freeze({ easy: [Number.NEGATIVE_INFINITY, 160], medium: [161, 180], hard: [181, 195], demon: [196, Number.POSITIVE_INFINITY] });

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
function bucketId(deal) { return `${deal.suitMode}s.${deal.difficulty}`; }
function normalizedDeal(deal) { return { dealId: deal.dealId, canonicalSeed: deal.canonicalSeed, initialDealHash: deal.initialDealHash, suitMode: deal.suitMode, difficulty: deal.difficulty, status: deal.status }; }
function classifyStepCount(steps) {
  for (const [difficulty, [minimum, maximum]] of Object.entries(STEP_RULE)) if (steps >= minimum && steps <= maximum) return difficulty;
  throw new Error(`No anchor-guided difficulty for ${steps} steps`);
}
function scoreStepCount(steps) {
  if (steps <= 160) return Math.round(Math.max(0, (steps - 113) / (160 - 113) * 25) * 100) / 100;
  if (steps <= 180) return Math.round((25 + (steps - 161) / (180 - 161) * 25) * 100) / 100;
  if (steps <= 195) return Math.round((50 + (steps - 181) / (195 - 181) * 25) * 100) / 100;
  return Math.round(Math.min(100, 75 + (steps - 196) / Math.max(1, 263 - 196) * 25) * 100) / 100;
}
function updateConfig(config, counts) {
  const next = structuredClone(config);
  for (const difficulty of Object.keys(STEP_RULE)) {
    const id = `2s.${difficulty}`;
    next.buckets[id] = { ...next.buckets[id], enabled: true, candidateScanBudget: counts[id], certifiedTarget: counts[id], embeddedTarget: counts[id], minimumPublishableCount: counts[id], allowEmptyBucket: false };
  }
  return next;
}
function rebuildManifest(manifest, config, deals, catalogs, classifications) {
  const buckets = {};
  const payloadIndex = {};
  let offset = 0;
  for (const [id, bucketConfig] of Object.entries(config.buckets)) {
    const entries = deals.filter((deal) => bucketId(deal) === id);
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
    ...manifest, classifierVersion: CLASSIFIER_VERSION,
    classificationCatalogHash: sha256Canonical(classifications), configHash: sha256Canonical(config),
    payloadHash: sha256Canonical({ payloadSchemaVersion: 1, seedLibraryVersion: "1", deals }), libraryHash: sha256Canonical(deals),
    certificateCatalogHash: sha256Canonical(catalogs), buckets, payloadIndex, deals,
    totalEmbeddedCount: deals.length, totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
    createdAt: new Date().toISOString(), classificationStatus: "provisional",
  };
}

const [config, payload, manifest, nativePayload, nativeManifest, catalogs, certificates, classifications] = await Promise.all([
  readJson(CONFIG_FILE), readJson(PAYLOAD_FILE), readJson(MANIFEST_FILE), readJson(path.join(NATIVE_DIR, "certified-seeds.json")), readJson(path.join(NATIVE_DIR, "resolved-seed-manifest.json")),
  readJson(path.join(NATIVE_DIR, "certificate-catalog.json")), readJson(path.join(NATIVE_DIR, "certificates.json")), readJson(path.join(NATIVE_DIR, "classification-records.json")),
]);
const classificationById = new Map(classifications.map((entry) => [entry.dealId, entry]));
const relabeled = payload.deals.map((deal) => {
  if (deal.suitMode !== 2) return deal;
  const classification = classificationById.get(deal.dealId);
  if (!classification || !Number.isSafeInteger(classification.solutionLength)) throw new Error(`Missing solution length for ${deal.dealId}`);
  return { ...deal, difficulty: classifyStepCount(classification.solutionLength) };
});
const preliminaryCounts = Object.fromEntries(Object.keys(config.buckets).map((id) => [id, relabeled.filter((deal) => bucketId(deal) === id).length]));
const nextConfig = updateConfig(config, preliminaryCounts);
const orderedDeals = Object.keys(nextConfig.buckets).flatMap((id) => relabeled.filter((deal) => bucketId(deal) === id));
const counts = Object.fromEntries(Object.keys(nextConfig.buckets).map((id) => [id, orderedDeals.filter((deal) => bucketId(deal) === id).length]));
const nextPayload = { payloadSchemaVersion: 1, seedLibraryVersion: "1", deals: orderedDeals };
const nextClassifications = orderedDeals.map((deal) => {
  const previous = classificationById.get(deal.dealId);
  const step = previous?.solutionLength;
  return deal.suitMode === 2
    ? { ...previous, classifierVersion: CLASSIFIER_VERSION, difficulty: deal.difficulty, difficultyScore: scoreStepCount(step), calibrationRule: "manual-anchor-guided-step-bands-v3", anchorReference: { easy: 153, medium: 171 } }
    : { ...previous, classifierVersion: CLASSIFIER_VERSION };
});
const orderedCatalogs = orderedDeals.map((deal) => catalogs.find((entry) => entry.dealId === deal.dealId));
const orderedCertificates = orderedDeals.map((deal) => certificates.find((entry) => entry.dealId === deal.dealId));
if (orderedCatalogs.some((entry) => !entry) || orderedCertificates.some((entry) => !entry)) throw new Error("Certificate evidence is incomplete");
const nextManifest = rebuildManifest(manifest, nextConfig, orderedDeals, orderedCatalogs, nextClassifications);
const nextNativeManifest = rebuildManifest(nativeManifest, nextConfig, orderedDeals, orderedCatalogs, nextClassifications);
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), classifierVersion: CLASSIFIER_VERSION,
  status: "provisional", source: "user manual anchor references", metric: "solutionLength (solver steps)",
  anchors: { easyReferenceSteps: 153, mediumReferenceSteps: 171, note: "reference points, not exact boundaries" },
  rule: { boundaryPolicy: "inclusive integer bands", bands: { "2s.easy": "<=160", "2s.medium": "161-180", "2s.hard": "181-195", "2s.demon": ">=196" }, rationale: "guard bands around the two manually reviewed reference games; no equal-count requirement" },
  counts, payloadHash: sha256Canonical(nextPayload), configHash: sha256Canonical(nextConfig),
};
await Promise.all([
  writeJson(CONFIG_FILE, nextConfig), writeJson(PAYLOAD_FILE, nextPayload), writeJson(path.join(NATIVE_DIR, "certified-seeds.json"), nextPayload),
  writeJson(MANIFEST_FILE, nextManifest), writeJson(path.join(NATIVE_DIR, "resolved-seed-manifest.json"), nextNativeManifest), writeJson(path.join(NATIVE_DIR, "certificate-catalog.json"), orderedCatalogs), writeJson(path.join(NATIVE_DIR, "certificates.json"), orderedCertificates), writeJson(path.join(NATIVE_DIR, "classification-records.json"), nextClassifications), writeJson(REPORT_FILE, report),
]);
process.stdout.write(`Applied anchor-guided 2-suit calibration: ${JSON.stringify(counts)}\n`);
