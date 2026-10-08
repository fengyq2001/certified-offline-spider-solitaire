import { readFile } from "node:fs/promises";
import { sha256, stableStringify } from "./canonical.js";

const BUCKET_PATTERN = /^(1s|2s|4s)\.(easy|medium|hard|demon)$/;

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

export function validateSeedPoolConfig(config) {
  if (!config || typeof config !== "object" || !config.buckets || typeof config.buckets !== "object") throw new TypeError("config.buckets is required");
  assertInteger(config.maximumEmbeddedCount, "maximumEmbeddedCount");
  assertInteger(config.maximumEmbeddedBytes, "maximumEmbeddedBytes");
  let targetTotal = 0;
  const bucketIds = Object.keys(config.buckets).sort();
  if (bucketIds.length === 0) throw new TypeError("at least one bucket is required");
  for (const bucketId of bucketIds) {
    if (!BUCKET_PATTERN.test(bucketId)) throw new TypeError(`invalid bucket id: ${bucketId}`);
    const bucket = config.buckets[bucketId];
    if (typeof bucket.enabled !== "boolean" || typeof bucket.allowEmptyBucket !== "boolean") throw new TypeError(`${bucketId} flags must be booleans`);
    for (const field of ["candidateScanBudget", "certifiedTarget", "embeddedTarget", "minimumPublishableCount"]) assertInteger(bucket[field], `${bucketId}.${field}`);
    if (bucket.minimumPublishableCount > bucket.embeddedTarget || bucket.embeddedTarget > bucket.certifiedTarget) throw new RangeError(`${bucketId} target ordering is invalid`);
    if (!bucket.enabled && (bucket.certifiedTarget || bucket.embeddedTarget || bucket.minimumPublishableCount)) throw new RangeError(`${bucketId} is disabled but has non-zero targets`);
    if (bucket.enabled && !bucket.allowEmptyBucket && bucket.minimumPublishableCount === 0) throw new RangeError(`${bucketId} must publish at least one deal or explicitly allow an empty bucket`);
    if (bucket.enabled) targetTotal += bucket.embeddedTarget;
  }
  if (targetTotal > config.maximumEmbeddedCount) throw new RangeError("sum of embedded targets exceeds maximumEmbeddedCount");
  return config;
}

export async function readSeedPoolConfig(path) {
  const source = await readFile(path, "utf8");
  const config = validateSeedPoolConfig(JSON.parse(source));
  return { config, configHash: sha256(stableStringify(config)) };
}

export function splitBucketId(bucketId) {
  const match = BUCKET_PATTERN.exec(bucketId);
  if (!match) throw new TypeError(`invalid bucket id: ${bucketId}`);
  return { suitMode: match[1], difficulty: match[2] };
}
