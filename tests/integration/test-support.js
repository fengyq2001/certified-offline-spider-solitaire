import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function projectPath(...parts) {
  return path.join(projectRoot, ...parts);
}

export async function exists(...parts) {
  try {
    await access(projectPath(...parts));
    return true;
  } catch {
    return false;
  }
}

export async function importProjectModule(...parts) {
  return import(pathToFileURL(projectPath(...parts)).href);
}

export async function readProjectJson(...parts) {
  return JSON.parse(await readFile(projectPath(...parts), "utf8"));
}

export async function readFixture(name) {
  return readProjectJson("tests", "fixtures", name);
}

function isCard(value) {
  return Boolean(
    value
      && typeof value === "object"
      && Object.hasOwn(value, "id")
      && Object.hasOwn(value, "rank")
      && Object.hasOwn(value, "suit"),
  );
}

function cardsFrom(value, cards) {
  if (Array.isArray(value)) {
    for (const entry of value) cardsFrom(entry, cards);
    return;
  }
  if (isCard(value)) cards.push(value);
}

/**
 * Read only the live card locations. This deliberately ignores undo history and
 * cached initial states, because those may contain legitimate card snapshots.
 */
export function liveCards(state) {
  const cards = [];
  const tableau = state.tableau ?? state.columns;
  const completed = state.completedRuns ?? state.completedSets ?? state.completed;
  cardsFrom(tableau, cards);
  cardsFrom(state.stock, cards);
  cardsFrom(completed, cards);
  return cards;
}

export function normalizedState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function manifestBuckets(manifest) {
  if (Array.isArray(manifest.buckets)) {
    return Object.fromEntries(
      manifest.buckets.map((bucket) => [
        bucket.key ?? `${bucket.suitMode}s.${bucket.difficulty}`,
        bucket,
      ]),
    );
  }
  return manifest.buckets ?? {};
}

export function assertManifestReleaseContract(assert, manifest) {
  const buckets = manifestBuckets(manifest);
  const seenDealIds = new Set();
  let embeddedTotal = 0;
  let encodedTotal = 0;

  assert.ok(Object.keys(buckets).length > 0, "manifest must contain buckets");

  for (const [key, bucket] of Object.entries(buckets)) {
    const enabled = bucket.enabled === true;
    const embeddedCount = bucket.embeddedCount ?? 0;
    const actualCount = bucket.actualCount ?? 0;
    const embeddedTarget = bucket.embeddedTarget ?? 0;
    const minimum = bucket.minimumPublishableCount ?? 0;
    const allowEmpty = bucket.allowEmptyBucket === true;
    const deals = bucket.deals ?? [];

    assert.ok(Number.isSafeInteger(embeddedCount) && embeddedCount >= 0, `${key}: invalid embeddedCount`);
    assert.ok(Number.isSafeInteger(actualCount) && actualCount >= 0, `${key}: invalid actualCount`);
    assert.ok(Number.isSafeInteger(embeddedTarget) && embeddedTarget >= 0, `${key}: invalid embeddedTarget`);
    assert.ok(Number.isSafeInteger(minimum) && minimum >= 0, `${key}: invalid minimumPublishableCount`);

    if (!enabled) {
      assert.equal(embeddedCount, 0, `${key}: disabled bucket must not embed deals`);
      assert.equal(deals.length, 0, `${key}: disabled bucket must have no payload deals`);
    } else if (embeddedCount === 0) {
      assert.equal(allowEmpty, true, `${key}: empty enabled bucket must explicitly allow empty`);
    } else {
      assert.ok(minimum > 0, `${key}: non-empty enabled bucket cannot bypass the gate with a zero minimum`);
      assert.ok(embeddedCount >= minimum, `${key}: embedded count is below the publication minimum`);
      assert.ok(actualCount >= minimum, `${key}: actual count is below the publication minimum`);
    }

    assert.ok(
      embeddedCount <= Math.min(actualCount, embeddedTarget),
      `${key}: embedded count exceeds actualCount or embeddedTarget`,
    );
    if (deals.length > 0) {
      assert.equal(deals.length, embeddedCount, `${key}: deal payload count differs from embeddedCount`);
    }

    for (const deal of deals) {
      assert.equal(typeof deal.dealId, "string", `${key}: dealId is required`);
      assert.ok(!seenDealIds.has(deal.dealId), `${key}: duplicate dealId ${deal.dealId}`);
      seenDealIds.add(deal.dealId);
      assert.notEqual(deal.status, "disabled", `${key}: disabled deal embedded`);
      assert.notEqual(deal.status, "superseded", `${key}: superseded deal embedded`);
    }

    embeddedTotal += embeddedCount;
    encodedTotal += bucket.encodedBytes ?? 0;
  }

  const configuredCountLimit = manifest.maximumEmbeddedCount
    ?? manifest.limits?.maximumEmbeddedCount;
  const configuredByteLimit = manifest.maximumEmbeddedBytes
    ?? manifest.limits?.maximumEmbeddedBytes;
  const declaredEmbeddedTotal = manifest.totalEmbeddedCount ?? manifest.totals?.embeddedCount;
  const declaredEncodedTotal = manifest.totalEncodedBytes ?? manifest.totals?.encodedBytes;

  if (declaredEmbeddedTotal !== undefined) {
    assert.equal(declaredEmbeddedTotal, embeddedTotal, "totalEmbeddedCount must equal the bucket sum");
  }
  if (declaredEncodedTotal !== undefined) {
    assert.equal(declaredEncodedTotal, encodedTotal, "totalEncodedBytes must equal the bucket sum");
  }
  if (configuredCountLimit !== undefined) {
    assert.ok(embeddedTotal <= configuredCountLimit, "maximumEmbeddedCount exceeded");
  }
  if (configuredByteLimit !== undefined) {
    assert.ok(encodedTotal <= configuredByteLimit, "maximumEmbeddedBytes exceeded");
  }

  return { embeddedTotal, encodedTotal, dealIds: seenDealIds };
}
