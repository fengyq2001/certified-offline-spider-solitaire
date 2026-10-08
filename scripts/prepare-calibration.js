#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const payload = JSON.parse(await readFile(path.join(ROOT, "src/data/certified-seeds.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(ROOT, "src/data/resolved-seed-manifest.json"), "utf8"));
let artifactSha256 = "REPLACE_WITH_VERIFIED_ARTIFACT_SHA256";
try {
  const buildReport = JSON.parse(await readFile(path.join(ROOT, "artifacts/build/build-report.json"), "utf8"));
  if (/^[0-9a-f]{64}$/.test(buildReport.artifactSha256 ?? "")) artifactSha256 = buildReport.artifactSha256;
} catch {
  // Preparing before a build is allowed; the response template remains visibly incomplete.
}
const outputDirectory = path.join(ROOT, "artifacts/calibration");
const orderingSalt = "spider-difficulty-pilot-v1";

function orderKey(deal) {
  return createHash("sha256").update(`${orderingSalt}:${deal.dealId}`).digest("hex");
}

const ordered = [...payload.deals].sort((left, right) => orderKey(left).localeCompare(orderKey(right)));
const blindedDeals = ordered.map((deal, index) => {
  const blindId = `P${String(index + 1).padStart(2, "0")}`;
  return {
  blindId,
  dealId: deal.dealId,
  canonicalSeed: deal.canonicalSeed,
  suitMode: deal.suitMode,
  launchQuery: `?calibrationDealId=${deal.dealId}&blindId=${blindId}`,
};
});
const answerKey = ordered.map((deal, index) => ({
  blindId: `P${String(index + 1).padStart(2, "0")}`,
  dealId: deal.dealId,
  provisionalDifficulty: deal.difficulty,
}));

const packet = {
  schemaVersion: 1,
  packetId: `pilot-${manifest.libraryHash.slice(0, 12)}`,
  libraryHash: manifest.libraryHash,
  classificationStatus: manifest.classificationStatus,
  minimumIndependentRaters: 2,
  acceptancePolicy: {
    policyVersion: 1,
    minimumExactAgreementRate: 0.5,
    minimumWithinOneLevelAgreementRate: 0.875,
    minimumProvisionalWithinOneLevelRate: 0.75,
    requireEveryRaterToAttemptEveryDeal: true,
    disputedWhen: [
      "any rater does not complete or rate a deal",
      "the maximum and minimum rating differ by two or more levels",
      "the median blind rating differs from the provisional label by two or more levels"
    ],
    disputeResolution: "Collect a third independent blind rating. If the deal remains disputed, reclassify it from the new median or withhold it from a formal release. Never silently retain the provisional label."
  },
  instructions: [
    "Complete every deal without consulting the answer key or another rater.",
    "Record completion, elapsed seconds, moves, undo count, hint count, perceived difficulty 1-4, and notes.",
    "Use the exact distributed index.html artifact and a fresh local profile for each rater.",
    "Open each deal with its launchQuery appended to index.html; blind mode hides the provisional difficulty and does not persist game or statistics records.",
  ],
  ratingScale: { 1: "easy", 2: "medium", 3: "hard", 4: "demon" },
  deals: blindedDeals,
};

const responseTemplate = {
  schemaVersion: 1,
  packetId: packet.packetId,
  raterId: "REPLACE_WITH_PSEUDONYMOUS_ID",
  independentAndBlind: true,
  artifactSha256,
  ratings: blindedDeals.map(({ blindId }) => ({
    blindId,
    completed: null,
    elapsedSeconds: null,
    moves: null,
    undoCount: null,
    hintCount: null,
    perceivedDifficulty: null,
    notes: "",
  })),
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, "blind-rater-packet.json"), `${JSON.stringify(packet, null, 2)}\n`),
  writeFile(path.join(outputDirectory, "blind-rater-response-template.json"), `${JSON.stringify(responseTemplate, null, 2)}\n`),
  writeFile(path.join(outputDirectory, "answer-key.json"), `${JSON.stringify({ schemaVersion: 1, packetId: packet.packetId, answerKey }, null, 2)}\n`),
]);
process.stdout.write(`Prepared ${blindedDeals.length} blinded deals for at least ${packet.minimumIndependentRaters} raters in artifacts/calibration\n`);
