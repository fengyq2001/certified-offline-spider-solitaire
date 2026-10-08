#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(path.join(ROOT, "src/config/test-quality.json"), "utf8"));

const mutants = [
  { id: "allow-zero-count", file: "src/core/engine.js", from: "if (move.count <= 0)", to: "if (move.count < 0)" },
  { id: "allow-negative-source", file: "src/core/engine.js", from: "move.from < 0", to: "move.from < -1" },
  { id: "truncate-moved-run", file: "src/core/engine.js", from: "source.slice(-move.count);", to: "source.slice(-move.count + 1);" },
  { id: "permit-empty-stock-deal", file: "src/core/engine.js", from: "state.tableau.some((column) => column.length === 0)", to: "state.tableau.every((column) => column.length === 0)" },
  { id: "shuffle-skips-index-one", file: "src/core/generator.js", from: "i > 0; i -= 1", to: "i > 1; i -= 1" },
  { id: "deal-sixth-round-to-all", file: "src/core/generator.js", from: "round < 5 ? 10 : 4", to: "round <= 5 ? 10 : 4" },
  { id: "initial-tableau-face-down", file: "src/core/generator.js", from: "cloneCard(column[column.length - 1], true)", to: "cloneCard(column[column.length - 1], false)" },
  { id: "uppercase-seed-accepted", file: "src/core/generator.js", from: "/^u64:[0-9a-f]{16}$/", to: "/^u64:[0-9a-fA-F]{16}$/" },
];

if (config.schemaVersion !== 1) throw new Error("Unsupported test-quality schemaVersion");
if (mutants.length < config.coreMutation.minimumMutants) throw new Error("Mutation corpus is below the approved minimum");

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "spider-core-mutation-"));
const results = [];
try {
  await mkdir(path.join(temporaryRoot, "src"), { recursive: true });
  await mkdir(path.join(temporaryRoot, "tests"), { recursive: true });
  await cp(path.join(ROOT, "src/core"), path.join(temporaryRoot, "src/core"), { recursive: true });
  await cp(path.join(ROOT, "tests/core"), path.join(temporaryRoot, "tests/core"), { recursive: true });
  await cp(path.join(ROOT, "tests/fixtures"), path.join(temporaryRoot, "tests/fixtures"), { recursive: true });
  await writeFile(path.join(temporaryRoot, "package.json"), "{\"type\":\"module\"}\n");

  for (const mutant of mutants) {
    const target = path.join(temporaryRoot, mutant.file);
    const original = await readFile(path.join(ROOT, mutant.file), "utf8");
    const occurrences = original.split(mutant.from).length - 1;
    if (occurrences !== 1) throw new Error(`${mutant.id} expected one mutation site, found ${occurrences}`);
    await writeFile(target, original.replace(mutant.from, mutant.to));
    const run = spawnSync(process.execPath, ["--test", "tests/core/engine.test.js", "tests/core/generator.test.js"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    const killed = run.status !== 0;
    results.push({ id: mutant.id, killed, exitCode: run.status, timedOut: run.error?.code === "ETIMEDOUT" });
    await writeFile(target, original);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const killed = results.filter((result) => result.killed).length;
const scorePercent = (killed / results.length) * 100;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  operator: "deterministic-source-mutants",
  mutants: results.length,
  killed,
  survived: results.length - killed,
  scorePercent,
  minimumScorePercent: config.coreMutation.minimumScorePercent,
  results,
};
await mkdir(path.join(ROOT, "artifacts/test-quality"), { recursive: true });
await writeFile(path.join(ROOT, "artifacts/test-quality/core-mutation.json"), `${JSON.stringify(report, null, 2)}\n`);
if (scorePercent < config.coreMutation.minimumScorePercent) {
  throw new Error(`Core mutation score ${scorePercent}% is below ${config.coreMutation.minimumScorePercent}%`);
}
process.stdout.write(`Core mutation PASS (${killed}/${results.length}, ${scorePercent.toFixed(1)}%)\n`);
