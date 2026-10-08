#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cpus, arch, platform, release, totalmem } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { generateDeal } from "../src/core/generator.js";
import { candidateSeed } from "../src/solver/seed-factory.js";
import { canonicalJson, sha256Bytes, sha256Canonical } from "./build-single.js";
import {
  SOLVER_CONFIG_HASH,
  SOLVER_POLICY,
  SOLVER_VERSION,
  parseNativeSolverLine,
  solverDeckHex,
} from "./generate-native-seeds.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "artifacts/seed-factory/benchmark");
const SUIT_MODES = [1, 2, 4];
const MINIMUM_WORKER_MEMORY = Object.freeze({ 1: 128 * 1024 * 1024, 2: 256 * 1024 * 1024, 4: 384 * 1024 * 1024 });

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} requires a positive integer`);
  return value;
}

function parseArgs(argv) {
  const options = {
    manifest: path.join(DEFAULT_OUTPUT, "benchmark-manifest.json"),
    checkpoint: path.join(DEFAULT_OUTPUT, "benchmark-checkpoint.json"),
    report: path.join(DEFAULT_OUTPUT, "benchmark-report.json"),
    solver: path.join(ROOT, "artifacts/native/solverlab-spider-cli"),
    suits: [1, 2],
    sampleSize: 100,
    minimumSampleSize: 100,
    threads: 1,
    memoryLimitBytes: 1024 * 1024 * 1024,
    fresh: false,
    allowIncomplete: false,
    manifestOnly: false,
    maxCases: Infinity,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--fresh") options.fresh = true;
    else if (flag === "--allow-incomplete") options.allowIncomplete = true;
    else if (flag === "--manifest-only") options.manifestOnly = true;
    else if (flag === "--manifest") options.manifest = path.resolve(argv[++index]);
    else if (flag === "--checkpoint") options.checkpoint = path.resolve(argv[++index]);
    else if (flag === "--report") options.report = path.resolve(argv[++index]);
    else if (flag === "--solver") options.solver = path.resolve(argv[++index]);
    else if (flag === "--sample-size") options.sampleSize = positiveInteger(argv[++index], flag);
    else if (flag === "--minimum-sample-size") options.minimumSampleSize = positiveInteger(argv[++index], flag);
    else if (flag === "--threads") options.threads = positiveInteger(argv[++index], flag);
    else if (flag === "--memory-limit-bytes") options.memoryLimitBytes = positiveInteger(argv[++index], flag);
    else if (flag === "--max-cases") options.maxCases = positiveInteger(argv[++index], flag);
    else if (flag === "--suits") {
      options.suits = argv[++index].split(",").map(Number);
      if (!options.suits.length || options.suits.some((value) => !SUIT_MODES.includes(value))) throw new Error("--suits must contain only 1,2,4");
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
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

function hardwareProfile() {
  const processors = cpus();
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    logicalCpuCount: processors.length,
    cpuModels: [...new Set(processors.map((cpu) => cpu.model))].sort(),
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
  };
}

function benchmarkIdentity(manifest) {
  const { benchmarkId: ignoredId, createdAt: ignoredCreatedAt, ...identity } = manifest;
  return identity;
}

export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(trials) || successes < 0 || trials < 1 || successes > trials) throw new RangeError("invalid Wilson interval inputs");
  const proportion = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (proportion + z2 / (2 * trials)) / denominator;
  const radius = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * trials)) / trials) / denominator;
  return { confidenceLevel: 0.95, lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

export function assessSuitEvidence({ suitMode, solved, total, minimumSampleSize, ambiguousCount = 0, errorCount = 0 }) {
  const threshold = suitMode === 1 ? 0.9 : suitMode === 2 ? 0.5 : null;
  const confidenceInterval = wilsonInterval(solved, total);
  const stopReasonBoundary = ambiguousCount > 0
    ? "Native UNSOLVED and internal timeout share one adapter outcome; both remain non-solved attempts in the solve-rate denominator."
    : null;
  if (errorCount > 0) return { status: "EXECUTION_FAILED", threshold, confidenceInterval, stopReasonBoundary };
  if (suitMode === 4) return { status: "REPORTED_NOT_GATE", threshold, confidenceInterval, stopReasonBoundary };
  if (total < minimumSampleSize) return { status: "INSUFFICIENT_EVIDENCE", threshold, confidenceInterval, stopReasonBoundary };
  return { status: confidenceInterval.lower > threshold ? "PASS" : "FAIL", threshold, confidenceInterval, stopReasonBoundary };
}

async function createManifest(options, solverBinaryHash) {
  const ranges = options.suits.map((suitMode) => {
    const seeds = Array.from({ length: options.sampleSize }, (_, offset) => candidateSeed(`benchmark.${suitMode}s`, offset));
    return {
      suitMode,
      seedNamespace: `benchmark.${suitMode}s`,
      startOffset: 0,
      sampleSize: options.sampleSize,
      seedListHash: sha256Canonical(seeds),
    };
  });
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ruleVersion: "1.0",
    generatorVersion: "1",
    solverVersion: SOLVER_VERSION,
    solverConfigHash: SOLVER_CONFIG_HASH,
    solverBinaryHash,
    seedRanges: ranges,
    sampleSize: ranges.reduce((sum, range) => sum + range.sampleSize, 0),
    perDealTimeoutMsBySuit: SOLVER_POLICY.wrapperTimeoutMsBySuit,
    perDealNodeBudgetUpperBoundBySuit: SOLVER_POLICY.perDealNodeBudgetUpperBoundBySuit,
    nodeCountReporting: "unavailable-from-pinned-adapter",
    stopReasonPolicy: SOLVER_POLICY.stopReasonPolicy,
    threadCount: options.threads,
    memoryLimitBytes: options.memoryLimitBytes,
    memoryLimitPolicy: "scheduler admission bound; no OS hard cap",
    minimumSampleSizePerSuit: options.minimumSampleSize,
    hardwareProfile: hardwareProfile(),
    acceptance: {
      "1s": { solveRateGreaterThan: 0.9, decisionStatistic: "95% Wilson lower bound" },
      "2s": { solveRateGreaterThan: 0.5, decisionStatistic: "95% Wilson lower bound" },
      "4s": { solveRateGreaterThan: null, decisionStatistic: "reported, not a benchmark gate" },
    },
  };
  manifest.benchmarkId = sha256Canonical(benchmarkIdentity(manifest));
  return manifest;
}

function validateManifest(manifest, solverBinaryHash) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("Unsupported benchmark manifest");
  if (manifest.benchmarkId !== sha256Canonical(benchmarkIdentity(manifest))) throw new Error("Benchmark manifest identity mismatch");
  if (manifest.solverVersion !== SOLVER_VERSION || manifest.solverConfigHash !== SOLVER_CONFIG_HASH || manifest.solverBinaryHash !== solverBinaryHash) throw new Error("Benchmark manifest solver identity mismatch");
  if (canonicalJson(manifest.hardwareProfile) !== canonicalJson(hardwareProfile())) throw new Error("Benchmark hardware profile differs from the frozen manifest");
  if (!Number.isSafeInteger(manifest.threadCount) || manifest.threadCount < 1) throw new Error("Invalid benchmark threadCount");
  if (!Number.isSafeInteger(manifest.memoryLimitBytes) || manifest.memoryLimitBytes < 1) throw new Error("Invalid benchmark memoryLimitBytes");
  for (const range of manifest.seedRanges ?? []) {
    if (!SUIT_MODES.includes(range.suitMode) || !Number.isSafeInteger(range.startOffset) || !Number.isSafeInteger(range.sampleSize) || range.sampleSize < 1) throw new Error("Invalid benchmark seed range");
    const seeds = Array.from({ length: range.sampleSize }, (_, index) => candidateSeed(range.seedNamespace, range.startOffset + index));
    if (sha256Canonical(seeds) !== range.seedListHash) throw new Error(`Benchmark seed range hash mismatch for ${range.suitMode}s`);
  }
  const largestWorker = Math.max(...manifest.seedRanges.map((range) => MINIMUM_WORKER_MEMORY[range.suitMode]));
  if (manifest.threadCount * largestWorker > manifest.memoryLimitBytes) throw new Error("Benchmark threadCount exceeds the declared scheduler memory limit");
  return manifest;
}

function runNativeSolverAsync(binary, state, id, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let wrapperTimedOut = false;
    let outputOverflow = false;
    const timer = setTimeout(() => { wrapperTimedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) { outputOverflow = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "ERROR", stopReason: "SPAWN_ERROR", error: error.message, elapsedMs: performance.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - startedAt;
      if (wrapperTimedOut) return resolve({ status: "TIMEOUT", stopReason: "WRAPPER_TIMEOUT", elapsedMs });
      if (outputOverflow) return resolve({ status: "ERROR", stopReason: "OUTPUT_LIMIT", elapsedMs });
      if (code !== 0) return resolve({ status: "ERROR", stopReason: "NON_ZERO_EXIT", error: stderr.trim() || `exit ${code}`, elapsedMs });
      const line = stdout.trim().split("\n").at(-1) ?? "";
      resolve({ ...parseNativeSolverLine(line, id), elapsedMs });
    });
    child.stdin.end(`${id}\t${state.suitMode}\t${solverDeckHex(state)}\n`);
  });
}

function makeTasks(manifest) {
  return manifest.seedRanges.flatMap((range) => Array.from({ length: range.sampleSize }, (_, index) => {
    const offset = range.startOffset + index;
    return { suitMode: range.suitMode, offset, canonicalSeed: candidateSeed(range.seedNamespace, offset) };
  }));
}

function buildReport(manifest, manifestHash, results, complete) {
  const suits = {};
  for (const range of manifest.seedRanges) {
    const rows = results.filter((result) => result.suitMode === range.suitMode);
    if (!rows.length) continue;
    const counts = { solved: 0, timeout: 0, unsolvedOrInternalTimeout: 0, resourceLimit: 0, error: 0 };
    for (const row of rows) {
      if (row.stopReason === "SOLVED") counts.solved += 1;
      else if (row.stopReason === "WRAPPER_TIMEOUT") counts.timeout += 1;
      else if (row.stopReason === "UNSOLVED_OR_INTERNAL_TIMEOUT") counts.unsolvedOrInternalTimeout += 1;
      else if (row.stopReason === "RESOURCE_LIMIT") counts.resourceLimit += 1;
      else counts.error += 1;
    }
    const assessment = assessSuitEvidence({
      suitMode: range.suitMode,
      solved: counts.solved,
      total: rows.length,
      minimumSampleSize: manifest.minimumSampleSizePerSuit,
      ambiguousCount: counts.unsolvedOrInternalTimeout,
      errorCount: counts.error,
    });
    suits[`${range.suitMode}s`] = {
      sampleSize: rows.length,
      expectedSampleSize: range.sampleSize,
      counts,
      observedSolveRate: counts.solved / rows.length,
      ...assessment,
      elapsedMs: {
        average: rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length,
        maximum: Math.max(...rows.map((row) => row.elapsedMs)),
      },
    };
  }
  const statuses = Object.values(suits).map((suit) => suit.status);
  const status = !complete ? "INCOMPLETE"
    : statuses.includes("EXECUTION_FAILED") ? "EXECUTION_FAILED"
      : statuses.includes("FAIL") ? "FAIL"
        : statuses.includes("INSUFFICIENT_EVIDENCE") ? "INSUFFICIENT_EVIDENCE"
          : "PASS";
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmarkId: manifest.benchmarkId,
    benchmarkManifestHash: manifestHash,
    solverVersion: manifest.solverVersion,
    solverConfigHash: manifest.solverConfigHash,
    sampleSize: results.length,
    expectedSampleSize: manifest.sampleSize,
    threadCount: manifest.threadCount,
    memoryLimitBytes: manifest.memoryLimitBytes,
    stopReasonPolicy: manifest.stopReasonPolicy,
    status,
    suits,
    results: [...results].sort((a, b) => a.suitMode - b.suitMode || a.offset - b.offset),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const solverBinary = await readFile(options.solver);
  const solverBinaryHash = sha256Bytes(solverBinary);
  let manifest = options.fresh ? null : await loadJsonIfPresent(options.manifest);
  if (!manifest) {
    manifest = await createManifest(options, solverBinaryHash);
    await atomicJson(options.manifest, manifest);
  }
  validateManifest(manifest, solverBinaryHash);
  const manifestHash = sha256Canonical(manifest);
  if (options.manifestOnly) {
    process.stdout.write(`${JSON.stringify({ benchmarkId: manifest.benchmarkId, benchmarkManifestHash: manifestHash, sampleSize: manifest.sampleSize, status: "MANIFEST_FROZEN_NOT_RUN" }, null, 2)}\n`);
    return;
  }
  let checkpoint = options.fresh ? null : await loadJsonIfPresent(options.checkpoint);
  if (checkpoint && (checkpoint.schemaVersion !== 1 || checkpoint.benchmarkManifestHash !== manifestHash)) throw new Error("Benchmark checkpoint does not match the frozen manifest; rerun with --fresh");
  checkpoint ??= { schemaVersion: 1, benchmarkManifestHash: manifestHash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), results: [] };
  const completed = new Set(checkpoint.results.map((row) => `${row.suitMode}:${row.offset}`));
  const pending = makeTasks(manifest).filter((task) => !completed.has(`${task.suitMode}:${task.offset}`)).slice(0, options.maxCases);
  let cursor = 0;
  let interrupted = false;
  process.once("SIGINT", () => { interrupted = true; });
  process.once("SIGTERM", () => { interrupted = true; });
  let checkpointWrites = Promise.resolve();
  async function worker() {
    while (!interrupted) {
      const taskIndex = cursor;
      cursor += 1;
      if (taskIndex >= pending.length) return;
      const task = pending[taskIndex];
      const state = generateDeal(task.canonicalSeed, task.suitMode);
      const outcome = await runNativeSolverAsync(options.solver, state, task.canonicalSeed, manifest.perDealTimeoutMsBySuit[task.suitMode]);
      checkpoint.results.push({
        suitMode: task.suitMode,
        offset: task.offset,
        canonicalSeed: task.canonicalSeed,
        status: outcome.status,
        stopReason: outcome.stopReason,
        elapsedMs: Number(outcome.elapsedMs.toFixed(3)),
        checkpointsAdopted: outcome.checkpoints ?? null,
        solutionLength: outcome.moves?.length ?? null,
        error: outcome.error ?? null,
      });
      checkpoint.updatedAt = new Date().toISOString();
      checkpointWrites = checkpointWrites.then(() => atomicJson(options.checkpoint, checkpoint));
    }
  }
  await Promise.all(Array.from({ length: manifest.threadCount }, () => worker()));
  await checkpointWrites;
  const complete = checkpoint.results.length === manifest.sampleSize;
  const report = buildReport(manifest, manifestHash, checkpoint.results, complete);
  await atomicJson(options.report, report);
  process.stdout.write(`${JSON.stringify({ ...report, results: undefined }, null, 2)}\n`);
  if (!complete && !options.allowIncomplete) process.exitCode = 2;
  if (report.status === "EXECUTION_FAILED" || report.status === "FAIL") process.exitCode = 3;
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
