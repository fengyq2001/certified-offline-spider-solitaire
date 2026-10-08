#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { generateDeal, computeDealId, computeInitialDealHash } from "../src/core/generator.js";
import { createSolutionCertificate, validateSolutionCertificate } from "../src/solver/validator.js";
import { candidateSeed } from "../src/solver/seed-factory.js";
import { validateSeedPoolConfig } from "../src/solver/config.js";
import { canonicalJson, sha256Canonical } from "./build-single.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIFFICULTIES = ["easy", "medium", "hard", "demon"];
const SUIT_MODES = [1, 2, 4];
const SUIT_BYTES = { clubs: 0, diamonds: 1, hearts: 2, spades: 3 };

export const SOLVER_VERSION = "SolverLab@cc21d7e9345cce0506fad5c64ddfe7f833f0c51f";
export const CLASSIFIER_VERSION = "rank-quantile-0.2-provisional";
export const NATIVE_SCAN_POLICY = "per-suit-shared-stream-v1";
export const SOLVER_POLICY = Object.freeze({
  profile: "solverlab-upstream-default",
  wrapperTimeoutMsBySuit: Object.freeze({ 1: 70_000, 2: 130_000, 4: 190_000 }),
  internalTimeoutMsBySuit: Object.freeze({ 1: 60_000, 2: 120_000, 4: 180_000 }),
  perDealNodeBudgetUpperBoundBySuit: Object.freeze({ 1: 141_300_000, 2: 417_600_000, 4: 921_000_000 }),
  stopReasonPolicy: "wrapper timeout is TIMEOUT; native None is UNSOLVED_OR_INTERNAL_TIMEOUT because upstream does not expose the distinction",
});
export const SOLVER_CONFIG_HASH = sha256Canonical({ upstream: SOLVER_VERSION, policy: SOLVER_POLICY });

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    config: path.join(ROOT, "src/config/seed-pool-config.json"),
    solver: path.join(ROOT, "artifacts/native/solverlab-spider-cli"),
    out: path.join(ROOT, "artifacts/seed-factory/native"),
    promote: false,
    fresh: false,
    allowIncomplete: false,
    maxCandidates: Infinity,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--promote") options.promote = true;
    else if (flag === "--fresh") options.fresh = true;
    else if (flag === "--allow-incomplete") options.allowIncomplete = true;
    else if (flag === "--config") options.config = path.resolve(argv[++index]);
    else if (flag === "--solver") options.solver = path.resolve(argv[++index]);
    else if (flag === "--out") options.out = path.resolve(argv[++index]);
    else if (flag === "--max-candidates") options.maxCandidates = parsePositiveInteger(argv[++index], flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

export function solverDeckHex(state) {
  const cards = [...state.tableau.flat(), ...state.stock.flat()];
  return cards.map((card) => (SUIT_BYTES[card.suit] * 16 + card.rank).toString(16).padStart(2, "0")).join("");
}

export function parseNativeMoves(encoded) {
  if (!encoded) return [];
  return encoded.split(";").filter(Boolean).map((item) => {
    if (item === "D") return { type: "deal" };
    const [kind, from, to, count] = item.split(",");
    if (kind !== "M") throw new Error(`Unknown SolverLab move: ${item}`);
    const move = { type: "move", from: Number(from), to: Number(to), count: Number(count) };
    if (![move.from, move.to, move.count].every(Number.isSafeInteger)) throw new Error(`Malformed SolverLab move: ${item}`);
    return move;
  });
}

export function parseNativeSolverLine(line, id) {
  const [outputId, status, checkpoints, encoded = ""] = line.split("\t");
  if (outputId !== id) return { status: "ERROR", stopReason: "IDENTITY_MISMATCH", error: "SolverLab response identity mismatch" };
  if (status === "SOLVED") return { status, stopReason: "SOLVED", checkpoints: Number(checkpoints), moves: parseNativeMoves(encoded) };
  if (status === "UNSOLVED") return { status, stopReason: "UNSOLVED_OR_INTERNAL_TIMEOUT", checkpoints: Number(checkpoints) || 0, moves: [] };
  return { status: "ERROR", stopReason: "NATIVE_ERROR", error: encoded || checkpoints || status || "malformed response", moves: [] };
}

export function runNativeSolver(binary, state, id) {
  const input = `${id}\t${state.suitMode}\t${solverDeckHex(state)}\n`;
  const startedAt = performance.now();
  const result = spawnSync(binary, { input, encoding: "utf8", timeout: SOLVER_POLICY.wrapperTimeoutMsBySuit[state.suitMode], maxBuffer: 8 * 1024 * 1024 });
  const elapsedMs = performance.now() - startedAt;
  if (result.error?.code === "ETIMEDOUT") return { status: "TIMEOUT", stopReason: "WRAPPER_TIMEOUT", elapsedMs, error: result.error.message };
  if (result.error) return { status: "ERROR", stopReason: "SPAWN_ERROR", elapsedMs, error: result.error.message };
  if (result.status !== 0) return { status: "ERROR", stopReason: "NON_ZERO_EXIT", elapsedMs, error: result.stderr.trim() || `exit ${result.status}` };
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return { ...parseNativeSolverLine(line, id), elapsedMs };
}

export function assignRankedDifficulty(candidates, targets) {
  const sorted = [...candidates].sort((a, b) => a.solutionLength - b.solutionLength || a.canonicalSeed.localeCompare(b.canonicalSeed));
  const required = Object.values(targets).reduce((sum, value) => sum + value, 0);
  if (sorted.length < required) throw new Error(`Cannot classify ${sorted.length} candidates into ${required} target slots`);
  const result = [];
  let offset = 0;
  for (const difficulty of DIFFICULTIES) {
    const count = targets[difficulty] ?? 0;
    for (const candidate of sorted.slice(offset, offset + count)) {
      const rank = required <= 1 ? 0.5 : result.length / (required - 1);
      result.push({ ...candidate, difficulty, difficultyScore: Math.round(rank * 10_000) / 100, classificationStatus: "provisional" });
    }
    offset += count;
  }
  return result;
}

function emptyOutcomes() {
  return { solved: 0, certified: 0, validatorRejected: 0, duplicate: 0, unsolvedOrInternalTimeout: 0, wrapperTimeout: 0, errors: 0 };
}

export function createNativeCheckpoint(configHash) {
  return {
    schemaVersion: 2,
    configHash,
    solverVersion: SOLVER_VERSION,
    solverConfigHash: SOLVER_CONFIG_HASH,
    classifierVersion: CLASSIFIER_VERSION,
    scanPolicy: NATIVE_SCAN_POLICY,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    suits: Object.fromEntries(SUIT_MODES.map((suitMode) => [suitMode, {
      nextOffset: 0,
      candidatesScanned: 0,
      outcomes: emptyOutcomes(),
      certifiedCandidates: [],
      terminal: false,
    }])),
  };
}

export function assertNativeCheckpoint(checkpoint, configHash) {
  if (!checkpoint || checkpoint.schemaVersion !== 2) throw new Error("Native checkpoint schema is incompatible; rerun with --fresh");
  for (const [field, expected] of Object.entries({
    configHash,
    solverVersion: SOLVER_VERSION,
    solverConfigHash: SOLVER_CONFIG_HASH,
    classifierVersion: CLASSIFIER_VERSION,
    scanPolicy: NATIVE_SCAN_POLICY,
  })) if (checkpoint[field] !== expected) throw new Error(`Native checkpoint ${field} is incompatible; rerun with --fresh`);
  for (const suitMode of SUIT_MODES) {
    const state = checkpoint.suits?.[suitMode];
    if (!state || !Number.isSafeInteger(state.nextOffset) || state.nextOffset < 0 || !Number.isSafeInteger(state.candidatesScanned) || state.candidatesScanned < 0 || !Array.isArray(state.certifiedCandidates)) {
      throw new Error(`Native checkpoint has invalid ${suitMode}-suit progress`);
    }
  }
  return checkpoint;
}

function normalizedRuntimeDeal({ dealId, canonicalSeed, initialDealHash, suitMode, difficulty, status }) {
  return { dealId, canonicalSeed, initialDealHash, suitMode, difficulty, status };
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function loadJsonIfPresent(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function suitPlan(config, suitMode) {
  const prefix = `${suitMode}s.`;
  const enabledDifficulties = DIFFICULTIES.filter((difficulty) => config.buckets[`${prefix}${difficulty}`]?.enabled);
  const certifiedTargets = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, config.buckets[`${prefix}${difficulty}`]?.certifiedTarget ?? 0]));
  const embeddedTargets = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, config.buckets[`${prefix}${difficulty}`]?.embeddedTarget ?? 0]));
  return {
    enabledDifficulties,
    certifiedTargets,
    embeddedTargets,
    certifiedTarget: Object.values(certifiedTargets).reduce((sum, value) => sum + value, 0),
    embeddedTarget: Object.values(embeddedTargets).reduce((sum, value) => sum + value, 0),
    sharedCandidateScanBudget: enabledDifficulties.reduce((sum, difficulty) => sum + config.buckets[`${prefix}${difficulty}`].candidateScanBudget, 0),
  };
}

function allKnownIdentities(checkpoint) {
  const dealIds = new Set();
  const initialDealHashes = new Set();
  for (const suit of Object.values(checkpoint.suits)) for (const entry of suit.certifiedCandidates) {
    dealIds.add(entry.dealId);
    initialDealHashes.add(entry.initialDealHash);
  }
  return { dealIds, initialDealHashes };
}

async function scanCandidate({ options, config, checkpoint, suitMode, certificateDirectory, identities }) {
  const progress = checkpoint.suits[suitMode];
  const canonicalSeed = candidateSeed(`native.${suitMode}s`, progress.nextOffset);
  const initialState = generateDeal(canonicalSeed, suitMode);
  const proposal = runNativeSolver(options.solver, initialState, canonicalSeed);
  progress.nextOffset += 1;
  progress.candidatesScanned += 1;
  if (proposal.status !== "SOLVED") {
    if (proposal.status === "TIMEOUT") progress.outcomes.wrapperTimeout += 1;
    else if (proposal.status === "UNSOLVED") progress.outcomes.unsolvedOrInternalTimeout += 1;
    else progress.outcomes.errors += 1;
    process.stdout.write(`${suitMode}s ${canonicalSeed} ${proposal.stopReason}\n`);
    return;
  }
  progress.outcomes.solved += 1;
  const dealId = await computeDealId(canonicalSeed, suitMode, config.ruleVersion, config.generatorVersion);
  const initialDealHash = await computeInitialDealHash(initialState);
  const certificate = await createSolutionCertificate(initialState, proposal.moves, { dealId, initialDealHash, solverVersion: SOLVER_VERSION, solverConfigHash: SOLVER_CONFIG_HASH });
  const validation = await validateSolutionCertificate(initialState, certificate);
  if (!validation.pass) {
    progress.outcomes.validatorRejected += 1;
    process.stdout.write(`${suitMode}s ${canonicalSeed} VALIDATOR_REJECTED ${validation.errorCode}\n`);
    return;
  }
  if (identities.dealIds.has(dealId) || identities.initialDealHashes.has(initialDealHash)) {
    progress.outcomes.duplicate += 1;
    process.stdout.write(`${suitMode}s ${canonicalSeed} DUPLICATE\n`);
    return;
  }
  const entry = {
    dealId, canonicalSeed, initialDealHash, suitMode, status: "active",
    solverVersion: SOLVER_VERSION, solverConfigHash: SOLVER_CONFIG_HASH,
    validatorVersion: validation.validatorVersion, classifierVersion: CLASSIFIER_VERSION,
    certificateHash: certificate.certificateHash, solutionLength: proposal.moves.length,
    metrics: { checkpointsAdopted: proposal.checkpoints, elapsedMs: Number(proposal.elapsedMs.toFixed(3)) },
  };
  await atomicJson(path.join(certificateDirectory, `${dealId}.json`), { dealId, certificateHash: certificate.certificateHash, certificate });
  progress.certifiedCandidates.push(entry);
  progress.outcomes.certified += 1;
  identities.dealIds.add(dealId);
  identities.initialDealHashes.add(initialDealHash);
  process.stdout.write(`${suitMode}s ${canonicalSeed} CERTIFIED moves=${proposal.moves.length}\n`);
}

async function loadEmbeddedCertificates(certificateDirectory, deals) {
  const records = [];
  for (const deal of deals) {
    const record = JSON.parse(await readFile(path.join(certificateDirectory, `${deal.dealId}.json`), "utf8"));
    if (record.dealId !== deal.dealId || record.certificateHash !== deal.certificateHash || record.certificate?.certificateHash !== deal.certificateHash) throw new Error(`Certificate checkpoint linkage mismatch for ${deal.dealId}`);
    records.push(record);
  }
  return records;
}

function reportFromCheckpoint(config, configHash, checkpoint) {
  const scan = {};
  let complete = true;
  for (const suitMode of SUIT_MODES) {
    const plan = suitPlan(config, suitMode);
    const progress = checkpoint.suits[suitMode];
    if (plan.enabledDifficulties.length === 0) continue;
    const targetMet = progress.certifiedCandidates.length >= plan.certifiedTarget;
    const budgetExhausted = progress.candidatesScanned >= plan.sharedCandidateScanBudget;
    if (!targetMet) complete = false;
    scan[suitMode] = {
      scanPolicy: NATIVE_SCAN_POLICY,
      enabledDifficulties: plan.enabledDifficulties,
      sharedCandidateScanBudget: plan.sharedCandidateScanBudget,
      candidatesScanned: progress.candidatesScanned,
      certifiedTarget: plan.certifiedTarget,
      certifiedCount: progress.certifiedCandidates.length,
      targetMet, budgetExhausted, nextOffset: progress.nextOffset, outcomes: progress.outcomes,
    };
  }
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(), configHash,
    solverVersion: SOLVER_VERSION, solverConfigHash: SOLVER_CONFIG_HASH,
    classifierVersion: CLASSIFIER_VERSION, classificationStatus: "provisional",
    scanPolicy: NATIVE_SCAN_POLICY,
    status: complete ? "COMPLETE" : "INCOMPLETE_FAIL_CLOSED",
    scan,
  };
}

async function buildCompletedArtifacts({ config, configHash, checkpoint, certificateDirectory }) {
  const classified = [];
  for (const suitMode of SUIT_MODES) {
    const plan = suitPlan(config, suitMode);
    if (plan.enabledDifficulties.length) classified.push(...assignRankedDifficulty(checkpoint.suits[suitMode].certifiedCandidates, plan.certifiedTargets));
  }
  const embeddedDeals = [];
  const buckets = {};
  const payloadIndex = {};
  let offset = 0;
  for (const [bucketId, bucketConfig] of Object.entries(config.buckets)) {
    const suitMode = Number.parseInt(bucketId, 10);
    const candidates = classified.filter((entry) => `${entry.suitMode}s.${entry.difficulty}` === bucketId);
    const entries = candidates.slice(0, bucketConfig.embeddedTarget);
    embeddedDeals.push(...entries);
    const encodedBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(canonicalJson(normalizedRuntimeDeal(entry))), 0);
    const sharedProgress = checkpoint.suits[suitMode];
    const sharedPlan = suitPlan(config, suitMode);
    buckets[bucketId] = {
      ...bucketConfig,
      candidatesScanned: bucketConfig.enabled ? sharedProgress.candidatesScanned : 0,
      candidateScanScope: bucketConfig.enabled ? "shared-suit-pool" : "disabled",
      sharedCandidateScanBudget: bucketConfig.enabled ? sharedPlan.sharedCandidateScanBudget : 0,
      rawCertifiedCount: candidates.length, actualCount: candidates.length,
      embeddedCount: entries.length, encodedBytes,
    };
    payloadIndex[bucketId] = { startOffset: offset, entryCount: entries.length };
    offset += entries.length;
  }
  const normalizedDeals = embeddedDeals.map(normalizedRuntimeDeal);
  const payload = { payloadSchemaVersion: 1, seedLibraryVersion: "1", deals: normalizedDeals };
  const certificateRecords = await loadEmbeddedCertificates(certificateDirectory, embeddedDeals);
  const certificateCatalog = certificateRecords.map(({ dealId, certificateHash }) => ({ dealId, certificateHash }));
  const classificationRecords = embeddedDeals.map((entry) => ({
    dealId: entry.dealId,
    certificateHash: entry.certificateHash,
    solverVersion: entry.solverVersion,
    solverConfigHash: entry.solverConfigHash,
    validatorVersion: entry.validatorVersion,
    classifierVersion: CLASSIFIER_VERSION,
    calibrationDatasetHash: null,
    suitMode: entry.suitMode,
    difficulty: entry.difficulty,
    difficultyScore: entry.difficultyScore,
    classificationStatus: entry.classificationStatus,
    solutionLength: entry.solutionLength,
    metrics: entry.metrics,
  }));
  const calibrationFile = path.join(ROOT, "artifacts/calibration/github-known-seed-calibration.json");
  const calibration = await loadJsonIfPresent(calibrationFile);
  if (!/^[0-9a-f]{64}$/.test(calibration?.datasetHash ?? "")) {
    throw new Error("Known-seed calibration dataset is required before publishing native seed artifacts");
  }
  const manifest = {
    schemaVersion: 1, payloadSchemaVersion: 1, seedLibraryVersion: "1", parentLibraryVersion: null,
    minRuntimeVersion: "0.1.0", maxRuntimeVersion: "0.1.x", configVersion: config.configVersion,
    ruleVersion: config.ruleVersion, generatorVersion: config.generatorVersion,
    solverVersion: SOLVER_VERSION, solverConfigHash: SOLVER_CONFIG_HASH, validatorVersion: "0.1.0",
    classifierVersion: CLASSIFIER_VERSION, calibrationDatasetHash: calibration.datasetHash,
    classificationCatalogHash: sha256Canonical(classificationRecords), classificationStatus: "provisional", createdAt: new Date().toISOString(),
    configHash, payloadHash: sha256Canonical(payload), libraryHash: sha256Canonical(normalizedDeals),
    certificateCatalogHash: sha256Canonical(certificateCatalog), maximumEmbeddedCount: config.maximumEmbeddedCount,
    maximumEmbeddedBytes: config.maximumEmbeddedBytes, buckets, payloadIndex, deals: normalizedDeals,
    totalEmbeddedCount: normalizedDeals.length,
    totalEncodedBytes: Object.values(buckets).reduce((sum, bucket) => sum + bucket.encodedBytes, 0),
  };
  if (manifest.totalEmbeddedCount > config.maximumEmbeddedCount) throw new Error("Generated payload exceeds maximumEmbeddedCount");
  if (manifest.totalEncodedBytes > config.maximumEmbeddedBytes) throw new Error("Generated payload exceeds maximumEmbeddedBytes");
  return { payload, manifest, certificateCatalog, certificateRecords, classificationRecords };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = validateSeedPoolConfig(JSON.parse(await readFile(options.config, "utf8")));
  const configHash = sha256Canonical(config);
  const checkpointFile = path.join(options.out, "checkpoint.json");
  const certificateDirectory = path.join(options.out, "certificates");
  await mkdir(certificateDirectory, { recursive: true });
  let checkpoint = options.fresh ? null : await loadJsonIfPresent(checkpointFile);
  checkpoint = checkpoint ? assertNativeCheckpoint(checkpoint, configHash) : createNativeCheckpoint(configHash);
  const identities = allKnownIdentities(checkpoint);
  let remainingThisInvocation = options.maxCandidates;
  for (const suitMode of SUIT_MODES) {
    const plan = suitPlan(config, suitMode);
    if (!plan.enabledDifficulties.length) { checkpoint.suits[suitMode].terminal = true; continue; }
    const progress = checkpoint.suits[suitMode];
    while (progress.certifiedCandidates.length < plan.certifiedTarget && progress.candidatesScanned < plan.sharedCandidateScanBudget && remainingThisInvocation > 0) {
      await scanCandidate({ options, config, checkpoint, suitMode, certificateDirectory, identities });
      checkpoint.updatedAt = new Date().toISOString();
      await atomicJson(checkpointFile, checkpoint);
      remainingThisInvocation -= 1;
    }
    progress.terminal = progress.certifiedCandidates.length >= plan.certifiedTarget || progress.candidatesScanned >= plan.sharedCandidateScanBudget;
    checkpoint.updatedAt = new Date().toISOString();
    await atomicJson(checkpointFile, checkpoint);
    if (remainingThisInvocation <= 0) break;
  }
  const report = reportFromCheckpoint(config, configHash, checkpoint);
  await atomicJson(path.join(options.out, "generation-report.json"), report);
  if (report.status !== "COMPLETE") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!options.allowIncomplete) process.exitCode = 2;
    return;
  }
  const artifacts = await buildCompletedArtifacts({ config, configHash, checkpoint, certificateDirectory });
  await atomicJson(path.join(options.out, "certified-seeds.json"), artifacts.payload);
  await atomicJson(path.join(options.out, "resolved-seed-manifest.json"), artifacts.manifest);
  await atomicJson(path.join(options.out, "certificate-catalog.json"), artifacts.certificateCatalog);
  await atomicJson(path.join(options.out, "certificates.json"), artifacts.certificateRecords);
  await atomicJson(path.join(options.out, "classification-records.json"), artifacts.classificationRecords);
  if (options.promote) {
    await atomicJson(path.join(ROOT, "src/data/certified-seeds.json"), artifacts.payload);
    await atomicJson(path.join(ROOT, "src/data/resolved-seed-manifest.json"), artifacts.manifest);
    await atomicJson(path.join(ROOT, "artifacts/seed-factory/native/classification-records.json"), artifacts.classificationRecords);
  }
  process.stdout.write(`${JSON.stringify({ ...report, totalEmbeddedCount: artifacts.payload.deals.length }, null, 2)}\n`);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
