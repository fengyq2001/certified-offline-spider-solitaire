#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeDealId, computeInitialDealHash, generateDeal } from "../src/core/generator.js";
import { createSolutionCertificate, validateSolutionCertificate } from "../src/solver/validator.js";
import {
  KNOWN_SEED_DERIVATION_VERSION,
  buildCalibrationThresholds,
  calibrationDatasetHash,
  classifyKnownLength,
  deriveKnownSeed,
  scoreKnownLength,
} from "../src/solver/known-seed-calibration.js";
import { runNativeSolver, SOLVER_CONFIG_HASH, SOLVER_VERSION } from "./generate-native-seeds.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_FILE = path.join(ROOT, "src/data/github-known-seeds.json");
const OUTPUT_FILE = path.join(ROOT, "artifacts/calibration/github-known-seed-calibration.json");
const SOLVER_FILE = path.join(ROOT, "artifacts/native/solverlab-spider-cli");

function parseArgs(argv) {
  const options = { source: SOURCE_FILE, out: OUTPUT_FILE, solver: SOLVER_FILE };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") options.source = path.resolve(argv[++index]);
    else if (flag === "--out") options.out = path.resolve(argv[++index]);
    else if (flag === "--solver") options.solver = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = JSON.parse(await readFile(options.source, "utf8"));
  if (source.schemaVersion !== 1 || !Array.isArray(source.sources) || source.sources.length === 0) throw new Error("known seed source registry is invalid");
  const records = [];
  for (const entry of source.sources) {
    if (!/^[0-9a-f]{40}$/.test(entry.commit)) throw new Error(`${entry.id} must pin a full commit SHA`);
    for (const sourceSeed of entry.seeds) {
      for (const suitMode of entry.calibrationSuitModes) {
        const canonicalSeed = deriveKnownSeed({ ...entry, sourceSeed, suitMode });
        const initialState = generateDeal(canonicalSeed, suitMode);
        const proposal = runNativeSolver(options.solver, initialState, canonicalSeed);
        const record = {
          sourceId: entry.id,
          repository: entry.repository,
          commit: entry.commit,
          sourceSeed: String(sourceSeed),
          upstreamSuitMode: entry.upstreamSuitMode,
          suitMode,
          canonicalSeed,
          status: proposal.status,
          stopReason: proposal.stopReason,
          elapsedMs: Number(proposal.elapsedMs.toFixed(3)),
        };
        if (proposal.status === "SOLVED") {
          const dealId = await computeDealId(canonicalSeed, suitMode, "1.0", "1");
          const initialDealHash = await computeInitialDealHash(initialState);
          const certificate = await createSolutionCertificate(initialState, proposal.moves, {
            dealId,
            initialDealHash,
            solverVersion: SOLVER_VERSION,
            solverConfigHash: SOLVER_CONFIG_HASH,
          });
          const validation = await validateSolutionCertificate(initialState, certificate);
          if (!validation.pass) throw new Error(`Known seed ${canonicalSeed} failed certificate validation: ${validation.errorCode}`);
          record.dealId = dealId;
          record.initialDealHash = initialDealHash;
          record.solutionLength = proposal.moves.length;
          record.checkpointsAdopted = proposal.checkpoints;
        }
        records.push(record);
        process.stdout.write(`${entry.id} seed=${sourceSeed} ${suitMode}s ${proposal.status}${record.solutionLength ? ` moves=${record.solutionLength}` : ""}\n`);
      }
    }
  }
  const thresholds = buildCalibrationThresholds(records);
  const stable = {
    schemaVersion: 1,
    derivationVersion: KNOWN_SEED_DERIVATION_VERSION,
    solverVersion: SOLVER_VERSION,
    solverConfigHash: SOLVER_CONFIG_HASH,
    sourceRegistry: source,
    records,
    thresholds,
    calibrationMethod: "external-known-seed-derived-solver-quantile-v1",
    formalCalibrationPolicy: "minimum 8 solved anchors per suit mode plus independent human agreement; until then remain provisional",
  };
  const calibration = {
    ...stable,
    generatedAt: new Date().toISOString(),
    datasetHash: calibrationDatasetHash(stable),
    calibrationSummary: Object.fromEntries([1, 2, 4].map((suitMode) => {
      const threshold = thresholds[suitMode];
      const solved = records.filter((record) => record.suitMode === suitMode && record.status === "SOLVED");
      return [suitMode, {
        solvedCount: solved.length,
        failedCount: records.filter((record) => record.suitMode === suitMode && record.status !== "SOLVED").length,
        difficultyBands: solved.map((record) => ({
          canonicalSeed: record.canonicalSeed,
          solutionLength: record.solutionLength,
          calibratedDifficulty: classifyKnownLength(record.solutionLength, threshold),
          calibratedDifficultyScore: scoreKnownLength(record.solutionLength, threshold),
        })),
      }];
    })),
  };
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(calibration, null, 2)}\n`);
  process.stdout.write(`Known-seed calibration written to ${options.out}\nDataset hash: ${calibration.datasetHash}\n`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });

