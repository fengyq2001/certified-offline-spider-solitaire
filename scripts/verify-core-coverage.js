#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(path.join(ROOT, "src/config/test-quality.json"), "utf8"));
if (config.schemaVersion !== 1) throw new Error("Unsupported test-quality schemaVersion");
const thresholds = config.coreCoverage;
const args = [
  "--experimental-test-coverage",
  `--test-coverage-lines=${thresholds.minimumLinePercent}`,
  `--test-coverage-branches=${thresholds.minimumBranchPercent}`,
  `--test-coverage-functions=${thresholds.minimumFunctionPercent}`,
  "--test",
  "tests/core/engine.test.js",
  "tests/core/generator.test.js",
  "tests/core/property.test.js",
];
const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const match = combined.match(/all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  thresholds,
  result: run.status === 0 && match ? "PASS" : "FAIL",
  actual: match ? {
    linePercent: Number(match[1]),
    branchPercent: Number(match[2]),
    functionPercent: Number(match[3]),
  } : null,
  exitCode: run.status,
};
await mkdir(path.join(ROOT, "artifacts/test-quality"), { recursive: true });
await writeFile(path.join(ROOT, "artifacts/test-quality/core-coverage.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(ROOT, "artifacts/test-quality/core-coverage.txt"), combined);
if (report.result !== "PASS") {
  process.stderr.write(combined);
  throw new Error("Core coverage gate failed or its report could not be parsed");
}
process.stdout.write(`Core coverage PASS (lines ${report.actual.linePercent}%, branches ${report.actual.branchPercent}%, functions ${report.actual.functionPercent}%)\n`);
