#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { readSeedPoolConfig } from "../src/solver/config.js";
import { createFactoryCheckpoint, runSeedFactory } from "../src/solver/seed-factory.js";
import { stableStringify, sha256 } from "../src/solver/canonical.js";

function usage() {
  return `Usage: node scripts/generate-seeds.js [options]

Options:
  --config PATH              SeedPoolConfig JSON
  --output PATH              artifact directory
  --buckets LIST             comma-separated bucket ids
  --node-budget N            per-deal search node budget
  --timeout-ms N             per-deal wall-clock limit
  --transposition-limit N     per-deal state table limit
  --max-candidates N          stop this invocation after N candidates
  --checkpoint-every N        persist after every N candidates (default 25)
  --fresh                     discard an existing checkpoint
  --allow-incomplete          exit zero even when publish gates are unmet
  --help                      show this text`;
}

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${flag} requires a positive integer`);
  return value;
}

function parseArgs(argv) {
  const options = {
    configPath: "src/config/seed-pool-config.json",
    outputPath: "artifacts/seed-factory/default",
    checkpointEvery: 25,
    solverOptions: {},
    fresh: false,
    allowIncomplete: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--help") options.help = true;
    else if (flag === "--fresh") options.fresh = true;
    else if (flag === "--allow-incomplete") options.allowIncomplete = true;
    else if (flag === "--config") { options.configPath = value; index += 1; }
    else if (flag === "--output") { options.outputPath = value; index += 1; }
    else if (flag === "--buckets") { options.bucketIds = value.split(",").filter(Boolean); index += 1; }
    else if (flag === "--node-budget") { options.solverOptions.nodeBudget = positiveInteger(value, flag); index += 1; }
    else if (flag === "--timeout-ms") { options.solverOptions.timeoutMs = positiveInteger(value, flag); index += 1; }
    else if (flag === "--transposition-limit") { options.solverOptions.transpositionLimit = positiveInteger(value, flag); index += 1; }
    else if (flag === "--max-candidates") { options.maxCandidates = positiveInteger(value, flag); index += 1; }
    else if (flag === "--checkpoint-every") { options.checkpointEvery = positiveInteger(value, flag); index += 1; }
    else throw new TypeError(`unknown option: ${flag}`);
  }
  return options;
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readCheckpoint(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function buildSummary(config, checkpoint, configHash) {
  const buckets = {};
  let totalCertified = 0;
  let allPublishable = true;
  for (const [bucketId, bucketConfig] of Object.entries(config.buckets)) {
    const progress = checkpoint.buckets[bucketId];
    const actualCount = progress.entries.length;
    const embeddedCount = Math.min(actualCount, bucketConfig.embeddedTarget);
    const publishable = !bucketConfig.enabled
      ? embeddedCount === 0
      : bucketConfig.allowEmptyBucket && embeddedCount === 0
        ? true
        : embeddedCount > 0 && embeddedCount >= bucketConfig.minimumPublishableCount;
    buckets[bucketId] = {
      enabled: bucketConfig.enabled,
      candidateScanBudget: bucketConfig.candidateScanBudget,
      candidatesScanned: progress.candidatesScanned,
      certifiedTarget: bucketConfig.certifiedTarget,
      actualCount,
      embeddedTarget: bucketConfig.embeddedTarget,
      embeddedCount,
      minimumPublishableCount: bucketConfig.minimumPublishableCount,
      allowEmptyBucket: bucketConfig.allowEmptyBucket,
      complete: progress.complete,
      publishable,
      outcomes: progress.outcomes,
    };
    totalCertified += actualCount;
    if (!publishable) allPublishable = false;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configHash,
    solverConfigHash: checkpoint.solverConfigHash,
    status: allPublishable ? "PUBLISHABLE" : "INCOMPLETE_FAIL_CLOSED",
    totalCertified,
    buckets,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const configPath = resolve(options.configPath);
  const outputPath = resolve(options.outputPath);
  const checkpointPath = join(outputPath, "checkpoint.json");
  const certificateDirectory = join(outputPath, "certificates");
  const { config, configHash } = await readSeedPoolConfig(configPath);
  if (options.fresh) await rm(outputPath, { recursive: true, force: true });
  await mkdir(certificateDirectory, { recursive: true });
  let checkpoint = await readCheckpoint(checkpointPath) ?? createFactoryCheckpoint(config, configHash);
  let sinceCheckpoint = 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  checkpoint = await runSeedFactory({
    config,
    configHash,
    checkpoint,
    bucketIds: options.bucketIds,
    solverOptions: options.solverOptions,
    maxCandidates: options.maxCandidates,
    signal: controller.signal,
    onCertified: async (entry, certificate) => {
      await atomicJson(join(certificateDirectory, `${entry.dealId}.json`), certificate);
    },
    onProgress: async (current, event) => {
      sinceCheckpoint += event.canonicalSeed ? 1 : 0;
      if (event.entry || sinceCheckpoint >= options.checkpointEvery || controller.signal.aborted) {
        await atomicJson(checkpointPath, current);
        sinceCheckpoint = 0;
      }
    },
  });
  await atomicJson(checkpointPath, checkpoint);
  const entries = Object.values(checkpoint.buckets).flatMap((bucket) => bucket.entries);
  const catalog = { schemaVersion: 1, configHash, generatedAt: new Date().toISOString(), entries };
  catalog.catalogHash = sha256(stableStringify(catalog));
  await atomicJson(join(outputPath, "certified-catalog.json"), catalog);
  const summary = buildSummary(config, checkpoint, configHash);
  await atomicJson(join(outputPath, "run-summary.json"), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (controller.signal.aborted) process.exitCode = 130;
  else if (summary.status !== "PUBLISHABLE" && !options.allowIncomplete) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
