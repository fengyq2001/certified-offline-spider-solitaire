import { createHash } from "node:crypto";

export const KNOWN_SEED_DERIVATION_VERSION = "github-known-seed-v1";
export const CALIBRATED_DIFFICULTIES = Object.freeze(["easy", "medium", "hard", "demon"]);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Upstream numeric seeds are identifiers, not board identities. The source
 * repository, fixed commit, source seed, and requested suit mode are all
 * included before hashing into this runtime's u64 namespace.
 */
export function deriveKnownSeed({ repository, commit, sourceSeed, suitMode }) {
  if (!repository || !commit || !String(sourceSeed) || ![1, 2, 4].includes(Number(suitMode))) {
    throw new TypeError("repository, commit, sourceSeed and suitMode are required");
  }
  const input = `${KNOWN_SEED_DERIVATION_VERSION}|${repository}|${commit}|${sourceSeed}|${Number(suitMode)}`;
  return `u64:${createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16)}`;
}

export function quantile(sortedValues, probability) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  if (!(probability >= 0 && probability <= 1)) throw new RangeError("probability must be between 0 and 1");
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

export function buildCalibrationThresholds(records) {
  const thresholds = {};
  for (const suitMode of [1, 2, 4]) {
    const lengths = records
      .filter((record) => record.suitMode === suitMode && record.status === "SOLVED" && Number.isFinite(record.solutionLength))
      .map((record) => record.solutionLength)
      .sort((a, b) => a - b);
    thresholds[suitMode] = {
      sampleCount: lengths.length,
      minimumSolutionLength: lengths[0] ?? null,
      q25: quantile(lengths, 0.25),
      q50: quantile(lengths, 0.5),
      q75: quantile(lengths, 0.75),
      maximumSolutionLength: lengths.at(-1) ?? null,
      sufficientForFormalCalibration: lengths.length >= 8,
    };
  }
  return thresholds;
}

export function scoreKnownLength(solutionLength, threshold) {
  if (!threshold || threshold.minimumSolutionLength === null || threshold.maximumSolutionLength === null) return null;
  const span = threshold.maximumSolutionLength - threshold.minimumSolutionLength;
  if (span <= 0) return 50;
  return Math.round(Math.max(0, Math.min(100, (solutionLength - threshold.minimumSolutionLength) * 100 / span)) * 100) / 100;
}

export function classifyKnownLength(solutionLength, threshold) {
  if (!threshold || threshold.q25 === null) return null;
  if (solutionLength <= threshold.q25) return "easy";
  if (solutionLength <= threshold.q50) return "medium";
  if (solutionLength <= threshold.q75) return "hard";
  return "demon";
}

export function calibrationDatasetHash(calibration) {
  const { datasetHash: _ignored, generatedAt: _generatedAt, calibrationSummary: _summary, ...stable } = calibration;
  if (Array.isArray(stable.records)) {
    stable.records = stable.records.map(({ elapsedMs: _elapsedMs, ...record }) => record);
  }
  return sha256Canonical(stable);
}
