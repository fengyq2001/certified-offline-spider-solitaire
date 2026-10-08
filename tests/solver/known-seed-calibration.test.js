import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KNOWN_SEED_DERIVATION_VERSION,
  calibrationDatasetHash,
  classifyKnownLength,
  deriveKnownSeed,
} from "../../src/solver/known-seed-calibration.js";

const sourceUrl = new URL("../../src/data/github-known-seeds.json", import.meta.url);
const calibrationUrl = new URL("../../artifacts/calibration/github-known-seed-calibration.json", import.meta.url);
const manifestUrl = new URL("../../src/data/resolved-seed-manifest.json", import.meta.url);
const classificationsUrl = new URL("../../artifacts/seed-factory/native/classification-records.json", import.meta.url);

test("known-seed calibration is provenance-bound and generator-separated", async () => {
  const [source, calibration] = await Promise.all([
    readFile(sourceUrl, "utf8").then(JSON.parse),
    readFile(calibrationUrl, "utf8").then(JSON.parse),
  ]);
  assert.equal(calibration.derivationVersion, KNOWN_SEED_DERIVATION_VERSION);
  assert.equal(calibration.datasetHash, calibrationDatasetHash(calibration));
  assert.equal(calibration.sourceRegistry.schemaVersion, source.schemaVersion);
  const sourceIds = new Set(source.sources.map((entry) => entry.id));
  assert.ok(sourceIds.size >= 3);
  for (const entry of source.sources) {
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
    for (const suitMode of entry.calibrationSuitModes) {
      const derived = deriveKnownSeed({ ...entry, sourceSeed: entry.seeds[0], suitMode });
      assert.match(derived, /^u64:[0-9a-f]{16}$/);
      assert.notEqual(derived, `u64:${String(entry.seeds[0]).padStart(16, "0")}`);
    }
  }
  for (const record of calibration.records) {
    assert.ok(sourceIds.has(record.sourceId));
    assert.match(record.canonicalSeed, /^u64:[0-9a-f]{16}$/);
    if (record.status === "SOLVED") assert.ok(record.solutionLength > 0);
  }
  assert.ok(calibration.thresholds["1"].sampleCount >= 4);
  assert.ok(calibration.thresholds["2"].sampleCount >= 2);
  assert.equal(calibration.thresholds["4"].sampleCount, 0);
});

test("known-seed thresholds expose calibrated bands without promoting formal status", async () => {
  const [calibration, manifest, classifications] = await Promise.all([
    readFile(calibrationUrl, "utf8").then(JSON.parse),
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(classificationsUrl, "utf8").then(JSON.parse),
  ]);
  assert.equal(manifest.calibrationDatasetHash, calibration.datasetHash);
  assert.ok(["known-seed-quantile-0.1-provisional", "manual-human-calibration-2s-v1", "manual-human-calibration-2s-v2", "anchor-guided-2s-calibration-2026-10-07-v3"].includes(manifest.classifierVersion));
  for (const entry of classifications) assert.equal(entry.calibrationDatasetHash, calibration.datasetHash);
  for (const suitMode of ["1", "2"]) {
    const threshold = calibration.thresholds[suitMode];
    assert.equal(threshold.sufficientForFormalCalibration, false);
    const solved = calibration.records.filter((record) => record.suitMode === Number(suitMode) && record.status === "SOLVED");
    for (const record of solved) assert.ok(["easy", "medium", "hard", "demon"].includes(classifyKnownLength(record.solutionLength, threshold)));
  }
});
