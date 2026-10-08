import { SeedSelectionError } from "./errors.js";
import { chooseCrypto } from "./random.js";
import { makeBucketId, validateSeedArtifacts } from "./manifest.js";

export const BUCKET_STATUS = Object.freeze({
  AVAILABLE: "available",
  DISABLED: "disabled",
  EMPTY: "empty",
  EXHAUSTED: "exhausted",
});

function completedSet(value) {
  if (value instanceof Set) return value;
  return new Set(value ?? []);
}

export class SeedLibrary {
  static async fromArtifacts(manifest, payload, options) {
    return new SeedLibrary(await validateSeedArtifacts(manifest, payload, options));
  }

  constructor(artifacts) {
    this.manifest = artifacts.manifest;
    this.deals = artifacts.activeDeals;
    this.historyDeals = artifacts.deals ?? artifacts.payload.deals;
    this.byId = new Map(this.historyDeals.map((deal) => [deal.dealId, deal]));
    this.activeById = new Map(this.deals.map((deal) => [deal.dealId, deal]));
    this.lastSelectedByBucket = new Map();
    this.byBucket = new Map(Object.keys(this.manifest.buckets).map((bucketId) => [bucketId, []]));
    for (const deal of this.deals) this.byBucket.get(deal.bucketId).push(deal);
  }

  resolveBucketId(bucketOrSuit, difficulty) {
    return difficulty == null ? bucketOrSuit : makeBucketId(bucketOrSuit, difficulty);
  }

  getDeal(dealId) {
    return this.byId.get(dealId) ?? null;
  }

  getActiveDeal(dealId) {
    return this.activeById.get(dealId) ?? null;
  }

  getCompletedDealStatus(dealId) {
    const deal = this.getDeal(dealId);
    if (!deal) return Object.freeze({ dealId, known: false, active: false, status: "unknown", supersededBy: null });
    return Object.freeze({
      dealId,
      known: true,
      active: this.activeById.has(dealId),
      status: deal.status,
      supersededBy: deal.supersededBy ?? null,
      difficulty: deal.difficulty,
      originalDifficulty: deal.originalDifficulty ?? deal.difficulty,
    });
  }

  classifyCompletedDealIds(dealIds) {
    const result = { recognized: new Set(), active: new Set(), unavailable: new Set(), unknown: new Set() };
    for (const dealId of completedSet(dealIds)) {
      const status = this.getCompletedDealStatus(dealId);
      if (!status.known) result.unknown.add(dealId);
      else {
        result.recognized.add(dealId);
        (status.active ? result.active : result.unavailable).add(dealId);
      }
    }
    return result;
  }

  getBucketStatus(bucketOrSuit, completedDealIds = [], difficulty) {
    const bucketId = this.resolveBucketId(bucketOrSuit, difficulty);
    const bucket = this.manifest.buckets[bucketId];
    if (!bucket || !bucket.enabled) return { bucketId, status: BUCKET_STATUS.DISABLED, total: 0, remaining: 0 };
    const deals = this.byBucket.get(bucketId) ?? [];
    if (deals.length === 0) return { bucketId, status: BUCKET_STATUS.EMPTY, total: 0, remaining: 0 };
    const completed = completedSet(completedDealIds);
    const remaining = deals.reduce((count, deal) => count + (completed.has(deal.dealId) ? 0 : 1), 0);
    return { bucketId, status: remaining === 0 ? BUCKET_STATUS.EXHAUSTED : BUCKET_STATUS.AVAILABLE, total: deals.length, remaining };
  }

  listAvailable(bucketOrSuit, completedDealIds = [], difficulty) {
    const bucketId = this.resolveBucketId(bucketOrSuit, difficulty);
    const status = this.getBucketStatus(bucketId, completedDealIds);
    if (status.status !== BUCKET_STATUS.AVAILABLE) return [];
    const completed = completedSet(completedDealIds);
    return this.byBucket.get(bucketId).filter((deal) => !completed.has(deal.dealId));
  }

  select(bucketOrSuit, options = {}) {
    const bucketId = this.resolveBucketId(bucketOrSuit, options.difficulty);
    const completed = completedSet(options.completedDealIds);
    const state = this.getBucketStatus(bucketId, completed);
    if (state.status === BUCKET_STATUS.DISABLED) throw new SeedSelectionError("BUCKET_DISABLED", `Bucket ${bucketId} is not offered`, state);
    if (state.status === BUCKET_STATUS.EMPTY) throw new SeedSelectionError("BUCKET_EMPTY", `Bucket ${bucketId} has no deals`, state);
    let candidates = this.byBucket.get(bucketId);
    if (state.status === BUCKET_STATUS.EXHAUSTED) {
      if (!options.replayCompleted) throw new SeedSelectionError("BUCKET_EXHAUSTED", `Bucket ${bucketId} is complete`, state);
    } else {
      candidates = candidates.filter((deal) => !completed.has(deal.dealId));
    }
    const lastSelected = this.lastSelectedByBucket.get(bucketId);
    const randomizedCandidates = candidates.length > 1 && lastSelected
      ? candidates.filter((deal) => deal.dealId !== lastSelected)
      : candidates;
    const selected = chooseCrypto(randomizedCandidates.length > 0 ? randomizedCandidates : candidates, options.crypto);
    this.lastSelectedByBucket.set(bucketId, selected.dealId);
    return selected;
  }
}
