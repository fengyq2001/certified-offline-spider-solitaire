#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  applyMove,
  assertState,
  deserializeState,
  getLegalMoves,
  restart,
  serializeState,
  undo,
} from "../src/core/engine.js";
import { generateDeal } from "../src/core/generator.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const budget = JSON.parse(await readFile(path.join(ROOT, "src/config/stress-budget.json"), "utf8"));
const regressionCorpus = JSON.parse(await readFile(path.join(ROOT, "tests/fixtures/engine-regression-corpus.json"), "utf8"));
const reportFile = path.join(ROOT, "artifacts/stress/engine-stress.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function boardDigest(state) {
  const value = {
    tableau: state.tableau,
    stock: state.stock,
    completed: state.completed,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

let randomState = 0x9e3779b9;
function nextUint32() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return randomState >>> 0;
}

function seedFor(index) {
  const value = (0x5eed000000000000n + BigInt(index)).toString(16).padStart(16, "0");
  return `u64:${value}`;
}

function validateBudget() {
  invariant(budget.schemaVersion === 1, "Unsupported stress budget schemaVersion");
  for (const key of ["minimumEngineActions", "maximumActionP95Ms", "maximumHeapGrowthBytes", "maximumHeapGrowthSlopeBytesPerAction", "maximumPeakResidentSetBytes", "allowedFailures"]) {
    invariant(Number.isFinite(budget[key]) && budget[key] >= 0, `Invalid stress budget ${key}`);
  }
  invariant(budget.minimumEngineActions >= 100000, "Stress budget must require at least 100,000 engine actions");
}

validateBudget();
global.gc?.();
const memoryBefore = process.memoryUsage();
const samples = [];
const counters = { apply: 0, deal: 0, undo: 0, restart: 0, invalidRejected: 0, serializationRoundTrips: 0 };
let failures = 0;
let state = null;
let episode = 0;
let peakResidentSetBytes = memoryBefore.rss;
const memorySamples = [{ action: 0, heapUsedBytes: memoryBefore.heapUsed }];

function newEpisode() {
  const suitMode = [1, 2, 4][episode % 3];
  state = generateDeal(seedFor(episode), suitMode);
  episode += 1;
  assertState(state);
}

newEpisode();
for (let actionIndex = 0; actionIndex < budget.minimumEngineActions; actionIndex += 1) {
  const start = performance.now();
  try {
    if (actionIndex > 0 && actionIndex % 7 === 0) {
      state = restart(state);
      counters.restart += 1;
      if (actionIndex % 14 === 0) newEpisode();
    } else if (actionIndex % 29 === 0) {
      const beforeHash = boardDigest(state);
      let rejected = false;
      try { applyMove(state, { type: "move", from: -1, to: 0, count: 1 }); }
      catch { rejected = true; }
      invariant(rejected, "Invalid action was accepted");
      invariant(boardDigest(state) === beforeHash, "Rejected action mutated state");
      counters.invalidRejected += 1;
    } else if (state.history.length > 0 && actionIndex % 11 === 0) {
      state = undo(state);
      counters.undo += 1;
    } else {
      const moves = getLegalMoves(state);
      if (moves.length === 0) {
        newEpisode();
        counters.restart += 1;
      } else {
        const move = moves[nextUint32() % moves.length];
        state = applyMove(state, move);
        if (move.type === "deal") counters.deal += 1;
        else counters.apply += 1;
      }
    }

    if (actionIndex % 127 === 0) {
      const expected = boardDigest(state);
      state = deserializeState(serializeState(state));
      invariant(boardDigest(state) === expected, "Serialization round-trip changed board state");
      counters.serializationRoundTrips += 1;
    }
  } catch (error) {
    failures += 1;
    if (failures > budget.allowedFailures) throw error;
  } finally {
    samples.push(performance.now() - start);
    peakResidentSetBytes = Math.max(peakResidentSetBytes, process.memoryUsage().rss);
  }
  if (actionIndex > 0 && actionIndex % 5000 === 0) {
    global.gc?.();
    if (actionIndex % 25000 === 0) {
      memorySamples.push({ action: actionIndex, heapUsedBytes: process.memoryUsage().heapUsed });
    }
  }
  if (actionIndex > 0 && actionIndex % 10000 === 0) process.stdout.write(`stress progress ${actionIndex}/${budget.minimumEngineActions}\n`);
}

global.gc?.();
const memoryAfter = process.memoryUsage();
memorySamples.push({ action: budget.minimumEngineActions, heapUsedBytes: memoryAfter.heapUsed });
const sorted = [...samples].sort((left, right) => left - right);

invariant(regressionCorpus.schemaVersion === 1 && Array.isArray(regressionCorpus.cases), "Invalid regression corpus");
for (const fixture of regressionCorpus.cases) {
  let regressionState = generateDeal(fixture.seed, fixture.suitMode);
  for (const action of fixture.actions) regressionState = applyMove(regressionState, action);
  invariant(boardDigest(regressionState) === fixture.expectedBoardDigest, `Regression corpus mismatch for ${fixture.seed}`);
}

const validSerialized = serializeState(generateDeal(seedFor(999999), 2));
const corruptionCases = [
  null,
  { ...structuredClone(validSerialized), dealId: "0".repeat(64) },
  (() => {
    const value = structuredClone(validSerialized);
    value.tableau[0].pop();
    return value;
  })(),
];
for (const corrupted of corruptionCases) {
  let rejected = false;
  try { deserializeState(corrupted); } catch { rejected = true; }
  invariant(rejected, "Corrupt save state was accepted");
}

const meanAction = memorySamples.reduce((sum, sample) => sum + sample.action, 0) / memorySamples.length;
const meanHeap = memorySamples.reduce((sum, sample) => sum + sample.heapUsedBytes, 0) / memorySamples.length;
const slopeNumerator = memorySamples.reduce((sum, sample) => sum + ((sample.action - meanAction) * (sample.heapUsedBytes - meanHeap)), 0);
const slopeDenominator = memorySamples.reduce((sum, sample) => sum + ((sample.action - meanAction) ** 2), 0);
const heapGrowthSlopeBytesPerAction = slopeDenominator === 0 ? 0 : slopeNumerator / slopeDenominator;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  actions: samples.length,
  episodes: episode,
  counters,
  regressionCases: regressionCorpus.cases.length,
  corruptSaveCasesRejected: corruptionCases.length,
  failures,
  latencyMs: {
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
  },
  memory: {
    heapBeforeBytes: memoryBefore.heapUsed,
    heapAfterBytes: memoryAfter.heapUsed,
    heapGrowthBytes: Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed),
    heapGrowthSlopeBytesPerAction,
    samples: memorySamples,
    peakResidentSetBytes,
  },
  budgets: budget,
};

invariant(report.actions >= budget.minimumEngineActions, "Engine action count is below budget");
invariant(report.failures <= budget.allowedFailures, "Stress failures exceed budget");
invariant(report.latencyMs.p95 <= budget.maximumActionP95Ms, `Action p95 ${report.latencyMs.p95}ms exceeds budget`);
invariant(report.memory.heapGrowthBytes <= budget.maximumHeapGrowthBytes, "Heap growth exceeds budget");
invariant(report.memory.heapGrowthSlopeBytesPerAction <= budget.maximumHeapGrowthSlopeBytesPerAction, "Heap growth slope exceeds budget");
invariant(report.memory.peakResidentSetBytes <= budget.maximumPeakResidentSetBytes, "Peak RSS exceeds budget");
report.result = "PASS";

await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Engine stress PASS (${report.actions} actions, p95 ${report.latencyMs.p95.toFixed(3)} ms, peak RSS ${report.memory.peakResidentSetBytes} bytes)\n`);
