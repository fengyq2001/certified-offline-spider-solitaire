import { generateDeal, computeDealId, computeInitialDealHash } from "../core/generator.js";
import { solve } from "./search.js";
import { analyzeDifficulty } from "./difficulty.js";
import { createSolutionCertificate, validateSolutionCertificate } from "./validator.js";
import { SOLVER_VERSION, VALIDATOR_VERSION, CLASSIFIER_VERSION, DEFAULT_SOLVER_OPTIONS } from "./constants.js";
import { sha256, stableStringify } from "./canonical.js";
import { splitBucketId, validateSeedPoolConfig } from "./config.js";

const MASK64 = (1n << 64n) - 1n;

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

export function candidateSeed(bucketId, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative safe integer");
  const value = (fnv1a64(`certified-spider:${bucketId}`) + BigInt(offset)) & MASK64;
  return `u64:${value.toString(16).padStart(16, "0")}`;
}

export function createFactoryCheckpoint(config, configHash, solverConfigHash = null) {
  const buckets = {};
  for (const bucketId of Object.keys(config.buckets).sort()) {
    buckets[bucketId] = {
      nextOffset: 0,
      candidatesScanned: 0,
      outcomes: { solved: 0, certified: 0, classificationMismatch: 0, unsolved: 0, resourceLimit: 0, validatorRejected: 0, duplicate: 0 },
      entries: [],
      complete: !config.buckets[bucketId].enabled,
    };
  }
  return {
    schemaVersion: 1,
    configHash,
    solverConfigHash,
    solverVersion: SOLVER_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    buckets,
  };
}

function checkpointIsPristine(checkpoint) {
  return Object.values(checkpoint.buckets ?? {}).every((bucket) => (
    bucket.candidatesScanned === 0 && bucket.nextOffset === 0 && bucket.entries?.length === 0
  ));
}

function assertCheckpoint(checkpoint, config, configHash, solverConfigHash) {
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.configHash !== configHash) throw new Error("checkpoint is incompatible with the current config");
  for (const bucketId of Object.keys(config.buckets)) if (!checkpoint.buckets?.[bucketId]) throw new Error(`checkpoint is missing ${bucketId}`);
  if (checkpoint.solverConfigHash === null || checkpoint.solverConfigHash === undefined) {
    if (!checkpointIsPristine(checkpoint)) throw new Error("checkpoint has scan progress but is not bound to a solverConfigHash");
    checkpoint.solverConfigHash = solverConfigHash;
  }
  if (checkpoint.solverConfigHash !== solverConfigHash) throw new Error("checkpoint solverConfigHash does not match the requested solver configuration");
}

function shouldStopBucket(bucketConfig, progress) {
  return progress.entries.length >= bucketConfig.certifiedTarget || progress.candidatesScanned >= bucketConfig.candidateScanBudget;
}

/**
 * Scan configured buckets sequentially. Deterministic offsets plus a checkpoint
 * make interruption and resumption safe. Only validator-approved deals enter
 * `entries`; resource-limit results remain ordinary failed candidates.
 */
export async function runSeedFactory({
  config,
  configHash = sha256(stableStringify(config)),
  checkpoint = null,
  bucketIds = Object.keys(config.buckets).sort(),
  solverOptions = {},
  maxCandidates = Infinity,
  signal,
  onProgress = async () => {},
  onCertified = async () => {},
}) {
  validateSeedPoolConfig(config);
  const resolvedSolverOptions = { ...DEFAULT_SOLVER_OPTIONS, ...solverOptions };
  const solverConfigHash = sha256(stableStringify(resolvedSolverOptions));
  checkpoint ??= createFactoryCheckpoint(config, configHash, solverConfigHash);
  assertCheckpoint(checkpoint, config, configHash, solverConfigHash);
  const knownDealIds = new Set(Object.values(checkpoint.buckets).flatMap((bucket) => bucket.entries.map((entry) => entry.dealId)));
  let scannedThisRun = 0;

  for (const bucketId of bucketIds) {
    const bucketConfig = config.buckets[bucketId];
    if (!bucketConfig) throw new Error(`unknown bucket: ${bucketId}`);
    const progress = checkpoint.buckets[bucketId];
    if (!bucketConfig.enabled) {
      progress.complete = true;
      continue;
    }
    const { suitMode: suitLabel, difficulty } = splitBucketId(bucketId);
    const suitMode = Number.parseInt(suitLabel, 10);
    while (!shouldStopBucket(bucketConfig, progress) && scannedThisRun < maxCandidates && !signal?.aborted) {
      const offset = progress.nextOffset;
      const canonicalSeed = candidateSeed(bucketId, offset);
      progress.nextOffset += 1;
      progress.candidatesScanned += 1;
      scannedThisRun += 1;

      const initialState = generateDeal(canonicalSeed, suitMode);
      const solveResult = solve(initialState, resolvedSolverOptions);
      if (solveResult.status !== "SOLVED") {
        if (solveResult.status === "RESOURCE_LIMIT") progress.outcomes.resourceLimit += 1;
        else progress.outcomes.unsolved += 1;
        checkpoint.updatedAt = new Date().toISOString();
        await onProgress(checkpoint, { bucketId, canonicalSeed, solveResult });
        continue;
      }
      progress.outcomes.solved += 1;
      const dealId = await computeDealId(canonicalSeed, suitMode, config.ruleVersion, config.generatorVersion);
      const initialDealHash = await computeInitialDealHash(initialState);
      const certificate = await createSolutionCertificate(initialState, solveResult.moves, {
        dealId,
        initialDealHash,
        solverVersion: SOLVER_VERSION,
        solverConfigHash,
      });
      const validation = await validateSolutionCertificate(initialState, certificate);
      if (!validation.pass) {
        progress.outcomes.validatorRejected += 1;
        checkpoint.updatedAt = new Date().toISOString();
        await onProgress(checkpoint, { bucketId, canonicalSeed, solveResult, validation });
        continue;
      }
      const analysis = analyzeDifficulty(initialState, solveResult);
      if (analysis.classifiedDifficulty !== difficulty) {
        progress.outcomes.classificationMismatch += 1;
        checkpoint.updatedAt = new Date().toISOString();
        await onProgress(checkpoint, { bucketId, canonicalSeed, solveResult, validation, analysis });
        continue;
      }
      if (knownDealIds.has(dealId)) {
        progress.outcomes.duplicate += 1;
        checkpoint.updatedAt = new Date().toISOString();
        await onProgress(checkpoint, { bucketId, canonicalSeed, solveResult, validation, analysis });
        continue;
      }

      const entry = {
        dealId,
        canonicalSeed,
        initialDealHash,
        suitMode,
        difficulty,
        status: "active",
        solverVersion: SOLVER_VERSION,
        solverConfigHash,
        validatorVersion: VALIDATOR_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        certificateHash: certificate.certificateHash,
        solutionLength: solveResult.solutionLength,
        difficultyScore: analysis.difficultyScore,
        classificationStatus: analysis.classificationStatus,
        metrics: analysis.metrics,
      };
      await onCertified(entry, certificate, { bucketId, solveResult, analysis });
      progress.entries.push(entry);
      progress.outcomes.certified += 1;
      knownDealIds.add(dealId);
      checkpoint.updatedAt = new Date().toISOString();
      await onProgress(checkpoint, { bucketId, canonicalSeed, solveResult, validation, analysis, entry });
    }
    progress.complete = shouldStopBucket(bucketConfig, progress);
    checkpoint.updatedAt = new Date().toISOString();
    await onProgress(checkpoint, { bucketId });
    if (scannedThisRun >= maxCandidates || signal?.aborted) break;
  }
  return checkpoint;
}
