#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const responseFiles = process.argv.slice(2).map((file) => path.resolve(process.cwd(), file));
const packet = JSON.parse(await readFile(path.join(ROOT, "artifacts/calibration/blind-rater-packet.json"), "utf8"));
const answerKey = JSON.parse(await readFile(path.join(ROOT, "artifacts/calibration/answer-key.json"), "utf8"));
if (responseFiles.length < packet.minimumIndependentRaters) {
  throw new Error(`Need at least ${packet.minimumIndependentRaters} independent response files`);
}
const responses = await Promise.all(responseFiles.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
const raterIds = new Set();
for (const response of responses) {
  if (response.packetId !== packet.packetId) throw new Error("Response packetId mismatch");
  if (!response.independentAndBlind) throw new Error("Response does not attest independent blind rating");
  if (!response.raterId || response.raterId.startsWith("REPLACE_")) throw new Error("Response needs a pseudonymous raterId");
  if (raterIds.has(response.raterId)) throw new Error("Duplicate raterId");
  raterIds.add(response.raterId);
  if (!/^[0-9a-f]{64}$/.test(response.artifactSha256 ?? "")) throw new Error("Response needs the tested artifact SHA-256");
}
if (new Set(responses.map((response) => response.artifactSha256)).size !== 1) {
  throw new Error("Raters did not use the same artifact SHA-256");
}

const provisionalByBlindId = new Map(answerKey.answerKey.map((entry) => [entry.blindId, ({ easy: 1, medium: 2, hard: 3, demon: 4 })[entry.provisionalDifficulty]]));
let exactPairs = 0;
let withinOnePairs = 0;
let totalPairs = 0;
let provisionalWithinOne = 0;
const disputes = [];
const deals = [];
for (const deal of packet.deals) {
  const ratings = responses.map((response) => response.ratings.find((rating) => rating.blindId === deal.blindId));
  const missing = ratings.some((rating) => !rating || rating.completed !== true || !Number.isInteger(rating.perceivedDifficulty) || rating.perceivedDifficulty < 1 || rating.perceivedDifficulty > 4);
  if (missing) disputes.push({ blindId: deal.blindId, reason: "missing, incomplete, or invalid rating" });
  const values = ratings.filter((rating) => rating && Number.isInteger(rating.perceivedDifficulty)).map((rating) => rating.perceivedDifficulty).sort((a, b) => a - b);
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      totalPairs += 1;
      if (values[left] === values[right]) exactPairs += 1;
      if (Math.abs(values[left] - values[right]) <= 1) withinOnePairs += 1;
    }
  }
  const median = values.length === 0 ? null : values[Math.floor(values.length / 2)];
  const provisional = provisionalByBlindId.get(deal.blindId);
  if (median !== null && Math.abs(median - provisional) <= 1) provisionalWithinOne += 1;
  if (values.length > 1 && values.at(-1) - values[0] >= 2) disputes.push({ blindId: deal.blindId, reason: "rater spread is at least two levels" });
  if (median !== null && Math.abs(median - provisional) >= 2) disputes.push({ blindId: deal.blindId, reason: "median differs from provisional by at least two levels" });
  deals.push({ blindId: deal.blindId, ratings: values, median, provisional });
}
const exactAgreementRate = totalPairs === 0 ? 0 : exactPairs / totalPairs;
const withinOneLevelAgreementRate = totalPairs === 0 ? 0 : withinOnePairs / totalPairs;
const provisionalWithinOneLevelRate = provisionalWithinOne / packet.deals.length;
const policy = packet.acceptancePolicy;
const passed = disputes.length === 0
  && exactAgreementRate >= policy.minimumExactAgreementRate
  && withinOneLevelAgreementRate >= policy.minimumWithinOneLevelAgreementRate
  && provisionalWithinOneLevelRate >= policy.minimumProvisionalWithinOneLevelRate;
const report = {
  schemaVersion: 1,
  packetId: packet.packetId,
  artifactSha256: responses[0].artifactSha256,
  raterCount: responses.length,
  policy,
  exactAgreementRate,
  withinOneLevelAgreementRate,
  provisionalWithinOneLevelRate,
  disputes,
  deals,
  result: passed ? "PASS" : "FAIL",
};
await mkdir(path.join(ROOT, "artifacts/calibration"), { recursive: true });
await writeFile(path.join(ROOT, "artifacts/calibration/evaluation.json"), `${JSON.stringify(report, null, 2)}\n`);
if (!passed) throw new Error(`Calibration FAIL (${disputes.length} disputed deals)`);
process.stdout.write(`Calibration PASS (${responses.length} independent raters, exact agreement ${(exactAgreementRate * 100).toFixed(1)}%)\n`);
