#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  calibrationDatasetHash,
  classifyKnownLength,
  scoreKnownLength,
} from "../src/solver/known-seed-calibration.js";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const calibrationFile = path.join(ROOT, "artifacts/calibration/github-known-seed-calibration.json");
const manifestFile = path.join(ROOT, "src/data/resolved-seed-manifest.json");
const classificationsFile = path.join(ROOT, "artifacts/seed-factory/native/classification-records.json");
const nativeManifestFile = path.join(ROOT, "artifacts/seed-factory/native/resolved-seed-manifest.json");

const calibration = JSON.parse(await readFile(calibrationFile, "utf8"));
if (calibration.datasetHash !== calibrationDatasetHash(calibration)) throw new Error("known-seed calibration dataset hash mismatch");
const classifications = JSON.parse(await readFile(classificationsFile, "utf8"));
const nextClassifications = classifications.map((entry) => {
  const threshold = calibration.thresholds[String(entry.suitMode)];
  return {
    ...entry,
    classifierVersion: "known-seed-quantile-0.1-provisional",
    calibrationDatasetHash: calibration.datasetHash,
    calibratedDifficulty: classifyKnownLength(entry.solutionLength, threshold),
    calibratedDifficultyScore: scoreKnownLength(entry.solutionLength, threshold),
  };
});
const updateManifest = (manifest) => ({
  ...manifest,
  classifierVersion: "known-seed-quantile-0.1-provisional",
  calibrationDatasetHash: calibration.datasetHash,
  classificationCatalogHash: sha256Canonical(nextClassifications),
});
const manifest = updateManifest(JSON.parse(await readFile(manifestFile, "utf8")));
const nativeManifest = updateManifest(JSON.parse(await readFile(nativeManifestFile, "utf8")));
await Promise.all([
  writeFile(classificationsFile, `${JSON.stringify(nextClassifications, null, 2)}\n`),
  writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`),
  writeFile(nativeManifestFile, `${JSON.stringify(nativeManifest, null, 2)}\n`),
]);
process.stdout.write(`Applied known-seed calibration ${calibration.datasetHash} to ${nextClassifications.length} classification records\n`);

