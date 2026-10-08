import { RuntimeDataError, CompatibilityError } from "./errors.js";
import { assertVersionInRange } from "./version.js";

const ACTIVE_STATUSES = new Set(["active", "certified"]);
const KNOWN_STATUSES = new Set([...ACTIVE_STATUSES, "disabled", "superseded"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard", "demon"]);
const SUIT_MODES = new Set(["1s", "2s", "4s", 1, 2, 4]);
const CANONICAL_SEED_RE = /^u64:[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const RUNTIME_DEAL_KEYS = Object.freeze([
  "canonicalSeed", "dealId", "difficulty", "initialDealHash", "status", "suitMode",
]);
const TOMBSTONE_KEYS = new Set([
  "classificationOverride",
  "dealId",
  "disabledAt",
  "effectiveLibraryVersion",
  "reasonCode",
  "status",
  "supersededBy",
]);
const TOMBSTONE_STATUSES = new Set(["active", "certified", "disabled", "superseded"]);

function fail(code, message, details) {
  throw new RuntimeDataError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_MANIFEST", `${label} must be a non-negative integer`);
  return value;
}

export function normalizeSuitMode(value) {
  if (!SUIT_MODES.has(value)) fail("INVALID_SUIT_MODE", `Unsupported suit mode: ${value}`);
  return typeof value === "number" ? `${value}s` : value;
}

export function makeBucketId(suitMode, difficulty) {
  const suit = normalizeSuitMode(suitMode);
  if (!DIFFICULTIES.has(difficulty)) fail("INVALID_DIFFICULTY", `Unsupported difficulty: ${difficulty}`);
  return `${suit}.${difficulty}`;
}

export function flattenBuckets(buckets) {
  if (!isObject(buckets)) fail("INVALID_MANIFEST", "Manifest buckets must be an object");
  const flat = {};
  for (const [key, value] of Object.entries(buckets)) {
    if (key.includes(".")) {
      flat[key] = value;
      continue;
    }
    if (isObject(value) && !Object.hasOwn(value, "enabled")) {
      for (const [difficulty, bucket] of Object.entries(value)) flat[makeBucketId(key, difficulty)] = bucket;
      continue;
    }
    fail("INVALID_BUCKET_ID", `Bucket ${key} must use suit.difficulty or nested suit/difficulty form`);
  }
  return flat;
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) return { schemaVersion: 1, deals: payload };
  if (!isObject(payload) || !Array.isArray(payload.deals)) fail("INVALID_PAYLOAD", "Seed payload must contain a deals array");
  if (payload.tombstones != null && !Array.isArray(payload.tombstones)) fail("INVALID_PAYLOAD", "Seed payload tombstones must be an array");
  return { ...payload, tombstones: payload.tombstones ?? [] };
}

function normalizeIndex(payloadIndex) {
  if (payloadIndex == null) return null;
  if (Array.isArray(payloadIndex)) {
    return Object.fromEntries(payloadIndex.map((entry) => [entry.bucketId, entry]));
  }
  if (isObject(payloadIndex)) return payloadIndex;
  fail("INVALID_MANIFEST", "payloadIndex must be an object or array");
}

function validateBucket(bucketId, bucket) {
  if (!isObject(bucket)) fail("INVALID_MANIFEST", `Bucket ${bucketId} must be an object`);
  if (typeof bucket.enabled !== "boolean") fail("INVALID_MANIFEST", `Bucket ${bucketId} enabled must be boolean`);
  const actualCount = nonNegativeInteger(bucket.actualCount ?? 0, `${bucketId}.actualCount`);
  const embeddedCount = nonNegativeInteger(bucket.embeddedCount ?? 0, `${bucketId}.embeddedCount`);
  const embeddedTarget = nonNegativeInteger(bucket.embeddedTarget ?? embeddedCount, `${bucketId}.embeddedTarget`);
  const certifiedTarget = nonNegativeInteger(bucket.certifiedTarget ?? actualCount, `${bucketId}.certifiedTarget`);
  const minimum = nonNegativeInteger(bucket.minimumPublishableCount ?? 0, `${bucketId}.minimumPublishableCount`);
  const encodedBytes = nonNegativeInteger(bucket.encodedBytes ?? 0, `${bucketId}.encodedBytes`);
  const candidatesScanned = nonNegativeInteger(bucket.candidatesScanned, `${bucketId}.candidatesScanned`);
  if (!["bucket", "shared-suit-pool", "disabled"].includes(bucket.candidateScanScope)) {
    fail("INVALID_MANIFEST", `${bucketId}.candidateScanScope is invalid`);
  }
  if (minimum > embeddedTarget || embeddedTarget > certifiedTarget || embeddedCount > Math.min(actualCount, embeddedTarget)) {
    fail("INVALID_BUCKET_COUNTS", `Bucket ${bucketId} violates target/count constraints`);
  }
  if (!bucket.enabled && (certifiedTarget || embeddedTarget || minimum || embeddedCount)) {
    fail("DISABLED_BUCKET_NOT_EMPTY", `Disabled bucket ${bucketId} has non-zero targets or entries`);
  }
  if (!bucket.enabled && (candidatesScanned !== 0 || bucket.candidateScanScope !== "disabled")) {
    fail("DISABLED_BUCKET_NOT_EMPTY", `Disabled bucket ${bucketId} has scan evidence`);
  }
  if (bucket.enabled && embeddedCount === 0 && bucket.allowEmptyBucket !== true) {
    fail("EMPTY_BUCKET_NOT_ALLOWED", `Enabled bucket ${bucketId} cannot be empty`);
  }
  if (bucket.enabled && embeddedCount > 0 && embeddedCount < minimum) {
    fail("BELOW_MINIMUM_PUBLISHABLE", `Bucket ${bucketId} is below its publishable minimum`);
  }
  return { ...bucket, actualCount, embeddedCount, embeddedTarget, certifiedTarget, minimumPublishableCount: minimum, encodedBytes, candidatesScanned };
}

function validateDeal(raw, index) {
  if (!isObject(raw)) fail("INVALID_DEAL", `Deal ${index} must be an object`);
  if (Object.keys(raw).sort().join(",") !== RUNTIME_DEAL_KEYS.join(",")) {
    fail("INVALID_DEAL", `Deal ${index} contains development-only or unknown fields`);
  }
  const deal = { ...raw };
  if (!HASH_RE.test(deal.dealId)) fail("INVALID_DEAL_ID", `Deal ${index} has an invalid dealId`);
  if (!CANONICAL_SEED_RE.test(deal.canonicalSeed)) fail("INVALID_CANONICAL_SEED", `Deal ${deal.dealId} has a non-canonical seed`);
  deal.suitMode = normalizeSuitMode(deal.suitMode);
  if (!DIFFICULTIES.has(deal.difficulty)) fail("INVALID_DIFFICULTY", `Deal ${deal.dealId} has an invalid difficulty`);
  deal.status = deal.status ?? "certified";
  if (!KNOWN_STATUSES.has(deal.status)) fail("INVALID_DEAL_STATUS", `Deal ${deal.dealId} has an unknown status`);
  if (deal.status === "superseded") {
    fail("INVALID_SUPERSEDED_TARGET", `Deal ${deal.dealId} must declare supersession through a V2 tombstone`);
  }
  deal.bucketId = makeBucketId(deal.suitMode, deal.difficulty);
  if (!HASH_RE.test(deal.initialDealHash)) {
    fail("INVALID_INITIAL_DEAL_HASH", `Deal ${deal.dealId} has an invalid initialDealHash`);
  }
  return Object.freeze(deal);
}

function validateTombstone(raw, index, dealIds) {
  if (!isObject(raw)) fail("INVALID_TOMBSTONE", `Tombstone ${index} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!TOMBSTONE_KEYS.has(key)) fail("INVALID_TOMBSTONE", `Tombstone ${index} contains unknown field ${key}`);
  }
  if (!HASH_RE.test(raw.dealId) || !dealIds.has(raw.dealId)) {
    fail("UNKNOWN_TOMBSTONE_DEAL", `Tombstone ${index} references an unknown dealId`);
  }
  if (!TOMBSTONE_STATUSES.has(raw.status)) fail("INVALID_TOMBSTONE_STATUS", `Tombstone ${index} has an invalid status`);
  if (typeof raw.reasonCode !== "string" || raw.reasonCode.length === 0) fail("INVALID_TOMBSTONE", `Tombstone ${index} requires reasonCode`);
  if (typeof raw.effectiveLibraryVersion !== "string" || raw.effectiveLibraryVersion.length === 0) {
    fail("INVALID_TOMBSTONE", `Tombstone ${index} requires effectiveLibraryVersion`);
  }
  if (raw.disabledAt != null && (typeof raw.disabledAt !== "string" || !Number.isFinite(Date.parse(raw.disabledAt)))) {
    fail("INVALID_TOMBSTONE", `Tombstone ${index} disabledAt must be an ISO timestamp`);
  }
  if (raw.classificationOverride != null && !DIFFICULTIES.has(raw.classificationOverride)) {
    fail("INVALID_CLASSIFICATION_OVERRIDE", `Tombstone ${index} has an invalid classificationOverride`);
  }
  if (raw.status === "superseded") {
    if (!HASH_RE.test(raw.supersededBy) || !dealIds.has(raw.supersededBy)) {
      fail("INVALID_SUPERSEDED_TARGET", `Tombstone ${index} supersededBy must reference an existing deal`);
    }
  } else if (raw.supersededBy != null) {
    fail("INVALID_SUPERSEDED_TARGET", `Tombstone ${index} may only set supersededBy with superseded status`);
  }
  if (ACTIVE_STATUSES.has(raw.status) && raw.classificationOverride == null) {
    fail("INVALID_TOMBSTONE", `Active tombstone ${index} must contain a classificationOverride`);
  }
  return Object.freeze({ ...raw, supersededBy: raw.supersededBy ?? null });
}

function applyTombstones(deals, tombstones) {
  const effective = new Map(deals.map((deal) => [deal.dealId, {
    ...deal,
    originalDifficulty: deal.difficulty,
    supersededBy: null,
    classificationOverride: null,
  }]));
  for (const tombstone of tombstones) {
    const current = effective.get(tombstone.dealId);
    const difficulty = tombstone.classificationOverride ?? current.difficulty;
    effective.set(tombstone.dealId, {
      ...current,
      status: tombstone.status,
      difficulty,
      bucketId: makeBucketId(current.suitMode, difficulty),
      classificationOverride: tombstone.classificationOverride ?? current.classificationOverride,
      reasonCode: tombstone.reasonCode,
      disabledAt: tombstone.disabledAt ?? current.disabledAt ?? null,
      effectiveLibraryVersion: tombstone.effectiveLibraryVersion,
      supersededBy: tombstone.status === "superseded" ? tombstone.supersededBy : null,
    });
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(dealId) {
    if (visiting.has(dealId)) fail("SUPERSESSION_CYCLE", `Supersession cycle contains ${dealId}`);
    if (visited.has(dealId)) return;
    visiting.add(dealId);
    const deal = effective.get(dealId);
    if (!deal) fail("INVALID_SUPERSEDED_TARGET", `Supersession references missing deal ${dealId}`);
    if (deal.status === "superseded") visit(deal.supersededBy);
    visiting.delete(dealId);
    visited.add(dealId);
  }
  for (const dealId of effective.keys()) visit(dealId);

  for (const deal of effective.values()) {
    if (deal.status !== "superseded") continue;
    let target = effective.get(deal.supersededBy);
    while (target.status === "superseded") target = effective.get(target.supersededBy);
    if (!ACTIVE_STATUSES.has(target.status)) {
      fail("INVALID_SUPERSEDED_TARGET", `Superseded deal ${deal.dealId} does not resolve to an active certified deal`);
    }
  }
  return [...effective.values()].map((deal) => Object.freeze(deal));
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

export async function sha256Hex(value, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle?.digest) fail("CRYPTO_UNAVAILABLE", "Web Crypto digest is required for artifact hash validation");
  const data = typeof value === "string" ? utf8(value) : value;
  return toHex(await cryptoProvider.subtle.digest("SHA-256", data));
}

export async function validateSeedArtifacts(manifestInput, payloadInput, options = {}) {
  if (!isObject(manifestInput)) fail("INVALID_MANIFEST", "Manifest must be an object");
  const manifest = structuredClone(manifestInput);
  const payload = normalizePayload(payloadInput);
  const supportedManifestSchemas = options.supportedManifestSchemas ?? [1];
  const supportedPayloadSchemas = options.supportedPayloadSchemas ?? [1, 2];
  if (!supportedManifestSchemas.includes(manifest.schemaVersion)) {
    throw new CompatibilityError("UNSUPPORTED_MANIFEST_SCHEMA", `Unsupported manifest schema ${manifest.schemaVersion}`);
  }
  for (const key of ["configHash", "payloadHash", "libraryHash", "certificateCatalogHash", "solverConfigHash", "calibrationDatasetHash", "classificationCatalogHash"]) {
    if (!HASH_RE.test(manifest[key] ?? "")) fail("INVALID_MANIFEST", `Manifest ${key} must be a SHA-256 digest`);
  }
  if (!Number.isSafeInteger(manifest.configVersion) || manifest.configVersion <= 0) fail("INVALID_MANIFEST", "Manifest configVersion must be positive");
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) fail("INVALID_MANIFEST", "Manifest createdAt must be an ISO timestamp");
  const declaredPayloadSchema = payload.payloadSchemaVersion ?? payload.schemaVersion;
  const payloadSchemaVersion = manifest.payloadSchemaVersion ?? declaredPayloadSchema;
  if (!supportedPayloadSchemas.includes(payloadSchemaVersion) || (declaredPayloadSchema != null && declaredPayloadSchema !== payloadSchemaVersion)) {
    throw new CompatibilityError("UNSUPPORTED_PAYLOAD_SCHEMA", `Unsupported or mismatched payload schema ${payloadSchemaVersion}`);
  }
  if (options.runtimeVersion) assertVersionInRange(options.runtimeVersion, manifest.minRuntimeVersion, manifest.maxRuntimeVersion);
  if (options.ruleVersion && manifest.ruleVersion !== options.ruleVersion) throw new CompatibilityError("RULE_VERSION_MISMATCH", "Seed library rule version is incompatible");
  if (options.generatorVersion && manifest.generatorVersion !== options.generatorVersion) throw new CompatibilityError("GENERATOR_VERSION_MISMATCH", "Seed library generator version is incompatible");
  if (payload.seedLibraryVersion != null && payload.seedLibraryVersion !== manifest.seedLibraryVersion) fail("LIBRARY_VERSION_MISMATCH", "Payload and manifest seed library versions differ");

  const buckets = Object.fromEntries(Object.entries(flattenBuckets(manifest.buckets)).map(([id, bucket]) => [id, validateBucket(id, bucket)]));
  const sourceDeals = payload.deals.map(validateDeal);
  const dealIds = new Set();
  const seeds = new Set();
  const initialDealHashes = new Set();
  for (const deal of sourceDeals) {
    if (dealIds.has(deal.dealId)) fail("DUPLICATE_DEAL_ID", `Duplicate dealId ${deal.dealId}`);
    dealIds.add(deal.dealId);
    const seedKey = `${deal.suitMode}:${deal.canonicalSeed}`;
    if (seeds.has(seedKey)) fail("DUPLICATE_CANONICAL_SEED", `Duplicate canonical seed ${seedKey}`);
    if (initialDealHashes.has(deal.initialDealHash)) fail("DUPLICATE_INITIAL_DEAL", `Duplicate initial deal content ${deal.initialDealHash}`);
    seeds.add(seedKey);
    initialDealHashes.add(deal.initialDealHash);
    if (!buckets[deal.bucketId]) fail("UNKNOWN_DEAL_BUCKET", `Deal ${deal.dealId} references missing bucket ${deal.bucketId}`);
  }

  const tombstones = payload.tombstones.map((entry, index) => validateTombstone(entry, index, dealIds));
  const deals = applyTombstones(sourceDeals, tombstones);
  for (const deal of deals) {
    if (!buckets[deal.bucketId]) fail("UNKNOWN_DEAL_BUCKET", `Effective deal ${deal.dealId} references missing bucket ${deal.bucketId}`);
  }

  const activeDeals = deals.filter((deal) => ACTIVE_STATUSES.has(deal.status));
  for (const [bucketId, bucket] of Object.entries(buckets)) {
    const activeCount = activeDeals.filter((deal) => deal.bucketId === bucketId).length;
    if (activeCount !== bucket.embeddedCount) fail("PAYLOAD_COUNT_MISMATCH", `Bucket ${bucketId} has ${activeCount} active payload entries, expected ${bucket.embeddedCount}`);
    if (!bucket.enabled && activeCount !== 0) fail("DISABLED_BUCKET_NOT_EMPTY", `Disabled bucket ${bucketId} contains active entries`);
  }
  const sumEmbedded = Object.values(buckets).reduce((sum, bucket) => sum + bucket.embeddedCount, 0);
  const sumBytes = Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0);
  if (manifest.totalEmbeddedCount !== sumEmbedded || activeDeals.length !== sumEmbedded) fail("TOTAL_COUNT_MISMATCH", "Manifest embedded totals do not match buckets and payload");
  if (manifest.totalEncodedBytes != null && manifest.totalEncodedBytes !== sumBytes) fail("TOTAL_BYTES_MISMATCH", "Manifest encoded byte total does not match buckets");
  if (manifest.maximumEmbeddedCount != null && sumEmbedded > manifest.maximumEmbeddedCount) fail("MAXIMUM_COUNT_EXCEEDED", "Seed library exceeds maximumEmbeddedCount");
  if (manifest.maximumEmbeddedBytes != null && sumBytes > manifest.maximumEmbeddedBytes) fail("MAXIMUM_BYTES_EXCEEDED", "Seed library exceeds maximumEmbeddedBytes");

  const payloadIndex = normalizeIndex(manifest.payloadIndex);
  if (payloadIndex) {
    if (Object.keys(payloadIndex).length !== Object.keys(buckets).length) fail("INVALID_PAYLOAD_INDEX", "payloadIndex must contain every manifest bucket exactly once");
    let expectedOffset = 0;
    for (const [bucketId, entry] of Object.entries(payloadIndex)) {
      if (!buckets[bucketId]) fail("INVALID_PAYLOAD_INDEX", `payloadIndex references ${bucketId}`);
      const start = nonNegativeInteger(entry.startOffset ?? entry.offset, `${bucketId}.startOffset`);
      const count = nonNegativeInteger(entry.entryCount ?? entry.count, `${bucketId}.entryCount`);
      if (start !== expectedOffset) fail("INVALID_PAYLOAD_INDEX", `payloadIndex for ${bucketId} is not contiguous`);
      const slice = sourceDeals.slice(start, start + count);
      if (slice.length !== count || slice.some((deal) => deal.bucketId !== bucketId)) fail("INVALID_PAYLOAD_INDEX", `payloadIndex range for ${bucketId} is invalid`);
      expectedOffset += count;
    }
    if (expectedOffset !== sourceDeals.length) fail("INVALID_PAYLOAD_INDEX", "payloadIndex does not cover every payload deal");
  }

  const rawLibraryView = payload.deals.map(({ dealId, canonicalSeed, initialDealHash, suitMode, difficulty, status }) => ({ dealId, canonicalSeed, initialDealHash, suitMode, difficulty, status }));
  if (Array.isArray(manifest.deals) && canonicalStringify(manifest.deals) !== canonicalStringify(rawLibraryView)) fail("MANIFEST_DEAL_INDEX_MISMATCH", "Manifest deal index does not match payload");

  if (options.verifyHashes !== false && manifest.payloadHash) {
    const actualHash = await sha256Hex(canonicalStringify(payloadInput), options.crypto);
    if (actualHash !== manifest.payloadHash) fail("PAYLOAD_HASH_MISMATCH", "Seed payload hash does not match manifest", { expected: manifest.payloadHash, actual: actualHash });
  }
  if (options.verifyHashes !== false && manifest.libraryHash) {
    const actualHash = await sha256Hex(canonicalStringify(rawLibraryView), options.crypto);
    if (actualHash !== manifest.libraryHash) fail("LIBRARY_HASH_MISMATCH", "Seed library hash does not match manifest", { expected: manifest.libraryHash, actual: actualHash });
  }

  return Object.freeze({
    manifest: Object.freeze({ ...manifest, buckets: Object.freeze(buckets), payloadSchemaVersion }),
    payload: Object.freeze({ ...payload, deals: Object.freeze(sourceDeals), tombstones: Object.freeze(tombstones) }),
    deals: Object.freeze(deals),
    tombstones: Object.freeze(tombstones),
    activeDeals: Object.freeze(activeDeals),
  });
}

export { ACTIVE_STATUSES };
