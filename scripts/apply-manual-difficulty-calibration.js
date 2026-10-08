#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_FILE = path.join(ROOT, "src/config/seed-pool-config.json");
const PAYLOAD_FILE = path.join(ROOT, "src/data/certified-seeds.json");
const MANIFEST_FILE = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const NATIVE_PAYLOAD_FILE = path.join(ROOT, "artifacts/seed-factory/native/certified-seeds.json");
const NATIVE_MANIFEST_FILE = path.join(ROOT, "artifacts/seed-factory/native/resolved-seed-manifest.json");
const CLASSIFICATIONS_FILE = path.join(ROOT, "artifacts/seed-factory/native/classification-records.json");
const REPORT_FILE = path.join(ROOT, "artifacts/calibration/manual-difficulty-calibration.json");
const DIFFICULTIES = ["easy", "medium", "hard", "demon"];
const CLASSIFIER_VERSION = "manual-human-calibration-2s-v1";
const RECLASSIFICATION = Object.freeze({
  "2s.hard": "2s.easy",
  "2s.demon": "2s.medium",
});

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function bucketId(deal) {
  return `${deal.suitMode}s.${deal.difficulty}`;
}

function targetForBucket(config, id) {
  return config.buckets[id]?.embeddedTarget ?? 0;
}

function classifyDeal(deal) {
  return RECLASSIFICATION[bucketId(deal)]?.split(".")[1] ?? deal.difficulty;
}

function normalizedDeal(deal) {
  return {
    dealId: deal.dealId,
    canonicalSeed: deal.canonicalSeed,
    initialDealHash: deal.initialDealHash,
    suitMode: deal.suitMode,
    difficulty: deal.difficulty,
    status: deal.status,
  };
}

function rebuildManifest(manifest, config, payload, classifications) {
  const buckets = {};
  const payloadIndex = {};
  let offset = 0;
  for (const [id, bucketConfig] of Object.entries(config.buckets)) {
    const entries = payload.deals.filter((deal) => bucketId(deal) === id);
    const enabled = bucketConfig.enabled;
    const encodedBytes = entries.reduce((sum, deal) => sum + Buffer.byteLength(canonicalJson(normalizedDeal(deal))), 0);
    const suitMode = Number.parseInt(id, 10);
    const sharedPool = suitMode === 1 ? 500 : suitMode === 2 ? 5000 : 0;
    buckets[id] = {
      ...bucketConfig,
      candidatesScanned: enabled ? (suitMode === 4 ? entries.length : sharedPool) : 0,
      candidateScanScope: enabled ? (suitMode === 4 ? "bucket" : "shared-suit-pool") : "disabled",
      sharedCandidateScanBudget: enabled ? (suitMode === 4 ? 0 : sharedPool) : 0,
      rawCertifiedCount: entries.length,
      actualCount: entries.length,
      embeddedCount: entries.length,
      encodedBytes,
    };
    payloadIndex[id] = { startOffset: offset, entryCount: entries.length };
    offset += entries.length;
  }
  const catalog = classifications.map((entry) => ({ dealId: entry.dealId, certificateHash: entry.certificateHash }));
  return {
    ...manifest,
    classifierVersion: CLASSIFIER_VERSION,
    classificationCatalogHash: sha256Canonical(classifications),
    configHash: sha256Canonical(config),
    payloadHash: sha256Canonical(payload),
    libraryHash: sha256Canonical(payload.deals.map(normalizedDeal)),
    certificateCatalogHash: sha256Canonical(catalog),
    buckets,
    payloadIndex,
    deals: payload.deals.map(normalizedDeal),
    totalEmbeddedCount: payload.deals.length,
    totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
    createdAt: new Date().toISOString(),
    classificationStatus: "provisional",
  };
}

const [config, payload, manifest, nativePayload, nativeManifest, classifications] = await Promise.all([
  readJson(CONFIG_FILE), readJson(PAYLOAD_FILE), readJson(MANIFEST_FILE),
  readJson(NATIVE_PAYLOAD_FILE), readJson(NATIVE_MANIFEST_FILE), readJson(CLASSIFICATIONS_FILE),
]);

const relabeled = payload.deals.map((deal) => ({ ...deal, difficulty: classifyDeal(deal) }));
const orderedDeals = Object.keys(config.buckets).flatMap((id) => relabeled.filter((deal) => bucketId(deal) === id));
const expectedCount = Object.values(config.buckets).reduce((sum, bucket) => sum + bucket.embeddedTarget, 0);
if (orderedDeals.length !== expectedCount) throw new Error(`Manual calibration changed runtime count: expected ${expectedCount}, got ${orderedDeals.length}`);

const counts = Object.fromEntries(Object.keys(config.buckets).map((id) => [id, orderedDeals.filter((deal) => bucketId(deal) === id).length]));
for (const [id, bucket] of Object.entries(config.buckets)) {
  if (counts[id] !== targetForBucket(config, id)) throw new Error(`${id} has ${counts[id]} deals but target is ${targetForBucket(config, id)}`);
  if (!bucket.enabled && counts[id] !== 0) throw new Error(`Disabled bucket ${id} received manually relabeled deals`);
}

const nextPayload = { ...payload, deals: orderedDeals };
const classificationById = new Map(classifications.map((entry) => [entry.dealId, entry]));
const nextClassifications = orderedDeals.map((deal) => {
  const previous = classificationById.get(deal.dealId);
  if (!previous) throw new Error(`Missing classification for ${deal.dealId}`);
  return {
    ...previous,
    classifierVersion: CLASSIFIER_VERSION,
    difficulty: deal.difficulty,
    manualCalibration: "user-reviewed-2s-bucket-mapping-2026-10-07",
  };
});
const nextManifest = rebuildManifest(manifest, config, nextPayload, nextClassifications);
const nextNativeManifest = rebuildManifest(nativeManifest, config, nextPayload, nextClassifications);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  classifierVersion: CLASSIFIER_VERSION,
  status: "provisional",
  source: "user manual review",
  suitMode: 2,
  mapping: RECLASSIFICATION,
  policy: "Existing 2-suit hard deals are labeled easy; existing 2-suit demon deals are labeled medium at the low end. Existing easy/medium labels remain unchanged. 2-suit hard and demon buckets are disabled until higher-difficulty deals receive independent human ratings.",
  counts,
  payloadHash: sha256Canonical(nextPayload),
};

await Promise.all([
  writeJson(PAYLOAD_FILE, nextPayload),
  writeJson(NATIVE_PAYLOAD_FILE, nextPayload),
  writeJson(MANIFEST_FILE, nextManifest),
  writeJson(NATIVE_MANIFEST_FILE, nextNativeManifest),
  writeJson(CLASSIFICATIONS_FILE, nextClassifications),
  writeJson(REPORT_FILE, report),
]);
process.stdout.write(`Applied manual 2-suit calibration: ${JSON.stringify(counts)}\n`);
