import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  SOLVER_CONFIG_HASH,
  assertNativeCheckpoint,
  assignRankedDifficulty,
  createNativeCheckpoint,
} from "../../scripts/generate-native-seeds.js";
import { assessSuitEvidence, wilsonInterval } from "../../scripts/benchmark-native-solver.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");

async function fakeSolver(directory, status = "UNSOLVED") {
  const file = path.join(directory, `fake-${status.toLowerCase()}-solver.js`);
  await writeFile(file, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const [id] = input.trim().split("\\t");
  process.stdout.write(id + "\\t${status}\\t0\\t\\n");
});
`);
  await chmod(file, 0o755);
  return file;
}

test("Wilson decisions fail closed for small samples and retain ambiguous stop-reason boundaries", () => {
  assert.deepEqual(wilsonInterval(0, 1), {
    confidenceLevel: 0.95,
    lower: 0,
    upper: 0.7934506856227626,
  });
  assert.equal(assessSuitEvidence({ suitMode: 1, solved: 9, total: 10, minimumSampleSize: 100 }).status, "INSUFFICIENT_EVIDENCE");
  const ambiguous = assessSuitEvidence({ suitMode: 2, solved: 99, total: 100, minimumSampleSize: 100, ambiguousCount: 1 });
  assert.equal(ambiguous.status, "PASS");
  assert.match(ambiguous.stopReasonBoundary, /solve-rate denominator/);
  assert.equal(assessSuitEvidence({ suitMode: 4, solved: 1, total: 1, minimumSampleSize: 100 }).status, "REPORTED_NOT_GATE");
});

test("native checkpoints bind config and solver policy and ranking uses certified targets", () => {
  const checkpoint = createNativeCheckpoint("a".repeat(64));
  assert.equal(checkpoint.solverConfigHash, SOLVER_CONFIG_HASH);
  assert.equal(assertNativeCheckpoint(checkpoint, "a".repeat(64)), checkpoint);
  assert.throws(() => assertNativeCheckpoint(checkpoint, "b".repeat(64)), /configHash is incompatible/);
  const candidates = [3, 1, 4, 2].map((solutionLength, index) => ({ canonicalSeed: `u64:${String(index).padStart(16, "0")}`, solutionLength }));
  const ranked = assignRankedDifficulty(candidates, { easy: 2, medium: 1, hard: 1, demon: 0 });
  assert.deepEqual(ranked.map((entry) => [entry.solutionLength, entry.difficulty]), [[1, "easy"], [2, "easy"], [3, "medium"], [4, "hard"]]);
});

test("benchmark manifest is frozen and a complete tiny run remains insufficient evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "spider-benchmark-test-"));
  const solver = await fakeSolver(directory, "SOLVED");
  const manifest = path.join(directory, "manifest.json");
  const checkpoint = path.join(directory, "checkpoint.json");
  const report = path.join(directory, "report.json");
  await execFileAsync(process.execPath, [
    path.join(ROOT, "scripts/benchmark-native-solver.js"),
    "--solver", solver,
    "--manifest", manifest,
    "--checkpoint", checkpoint,
    "--report", report,
    "--suits", "1,2",
    "--sample-size", "2",
    "--minimum-sample-size", "100",
    "--threads", "2",
    "--memory-limit-bytes", String(1024 * 1024 * 1024),
    "--fresh",
  ]);
  const [frozen, result] = await Promise.all([
    readFile(manifest, "utf8").then(JSON.parse),
    readFile(report, "utf8").then(JSON.parse),
  ]);
  assert.match(frozen.benchmarkId, /^[0-9a-f]{64}$/);
  assert.equal(frozen.sampleSize, 4);
  assert.equal(result.sampleSize, 4);
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.suits["1s"].counts.solved, 2);
  assert.equal(result.suits["2s"].counts.solved, 2);
});

test("native generation resumes the same shared suit stream without publishing an incomplete pool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "spider-native-resume-test-"));
  const solver = await fakeSolver(directory, "UNSOLVED");
  const output = path.join(directory, "output");
  const configFile = path.join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    configVersion: 1,
    ruleVersion: "1.0",
    generatorVersion: "1",
    buckets: {
      "1s.easy": { enabled: true, candidateScanBudget: 2, certifiedTarget: 1, embeddedTarget: 1, minimumPublishableCount: 1, allowEmptyBucket: false },
    },
    maximumEmbeddedCount: 1,
    maximumEmbeddedBytes: 10000,
  }));
  const baseArgs = [
    path.join(ROOT, "scripts/generate-native-seeds.js"),
    "--solver", solver,
    "--config", configFile,
    "--out", output,
    "--max-candidates", "1",
    "--allow-incomplete",
  ];
  await execFileAsync(process.execPath, [...baseArgs, "--fresh"]);
  let checkpoint = JSON.parse(await readFile(path.join(output, "checkpoint.json"), "utf8"));
  assert.equal(checkpoint.suits[1].nextOffset, 1);
  assert.equal(checkpoint.suits[1].candidatesScanned, 1);
  await execFileAsync(process.execPath, baseArgs);
  checkpoint = JSON.parse(await readFile(path.join(output, "checkpoint.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(output, "generation-report.json"), "utf8"));
  assert.equal(checkpoint.suits[1].nextOffset, 2);
  assert.equal(checkpoint.suits[1].candidatesScanned, 2);
  assert.equal(report.status, "INCOMPLETE_FAIL_CLOSED");
  await assert.rejects(readFile(path.join(output, "certified-seeds.json"), "utf8"), { code: "ENOENT" });
});
