#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(path.join(ROOT, "src/config/seed-pool-config.json"), "utf8"));
const manifestFile = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const payloadFile = path.join(ROOT, "src/data/certified-seeds.json");
const nativeDirectory = path.join(ROOT, "artifacts/seed-factory/native");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
const legacyPayload = JSON.parse(await readFile(payloadFile, "utf8"));
const generationReport = JSON.parse(await readFile(path.join(nativeDirectory, "generation-report.json"), "utf8"));

const runtimeFields = ({ dealId, canonicalSeed, initialDealHash, suitMode, difficulty, status }) => ({
  dealId, canonicalSeed, initialDealHash, suitMode, difficulty, status,
});
const calibrationDataset = legacyPayload.deals.map(({ dealId, suitMode, solutionLength, metrics }) => ({ dealId, suitMode, solutionLength, metrics }));
const calibrationDatasetHash = sha256Canonical(calibrationDataset);
const classifications = legacyPayload.deals.map((deal) => ({
  dealId: deal.dealId,
  certificateHash: deal.certificateHash,
  solverVersion: deal.solverVersion,
  solverConfigHash: deal.solverConfigHash,
  validatorVersion: deal.validatorVersion,
  classifierVersion: deal.classifierVersion,
  calibrationDatasetHash,
  suitMode: deal.suitMode,
  difficulty: deal.difficulty,
  difficultyScore: deal.difficultyScore,
  classificationStatus: deal.classificationStatus,
  solutionLength: deal.solutionLength,
  metrics: deal.metrics,
}));
const runtimePayload = { ...legacyPayload, deals: legacyPayload.deals.map(runtimeFields) };
const buckets = Object.fromEntries(Object.entries(manifest.buckets).map(([bucketId, bucket]) => {
  const suitMode = Number.parseInt(bucketId, 10);
  return [bucketId, {
    ...bucket,
    candidatesScanned: bucket.enabled ? (generationReport.scan?.[suitMode]?.candidatesScanned ?? 0) : 0,
    candidateScanScope: bucket.enabled ? "shared-suit-pool" : "disabled",
    encodedBytes: runtimePayload.deals
      .filter((deal) => `${deal.suitMode}s.${deal.difficulty}` === bucketId)
      .reduce((sum, deal) => sum + Buffer.byteLength(canonicalJson(deal)), 0),
  }];
}));
const nextManifest = {
  ...manifest,
  configVersion: config.configVersion,
  createdAt: generationReport.generatedAt,
  solverConfigHash: legacyPayload.deals[0].solverConfigHash,
  calibrationDatasetHash,
  classificationCatalogHash: sha256Canonical(classifications),
  buckets,
  payloadHash: sha256Canonical(runtimePayload),
  libraryHash: sha256Canonical(runtimePayload.deals),
  deals: runtimePayload.deals,
  totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
};

await Promise.all([
  writeFile(payloadFile, `${JSON.stringify(runtimePayload, null, 2)}\n`),
  writeFile(manifestFile, `${JSON.stringify(nextManifest, null, 2)}\n`),
  writeFile(path.join(nativeDirectory, "certified-seeds.json"), `${JSON.stringify(runtimePayload, null, 2)}\n`),
  writeFile(path.join(nativeDirectory, "resolved-seed-manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`),
  writeFile(path.join(nativeDirectory, "classification-records.json"), `${JSON.stringify(classifications, null, 2)}\n`),
]);
process.stdout.write(`Migrated ${runtimePayload.deals.length} runtime deals and separated development classification evidence\n`);
