import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

test("blind calibration packet freezes acceptance and dispute rules before human ratings", async () => {
  const [packet, template, answerKey] = await Promise.all([
    readFile(new URL("artifacts/calibration/blind-rater-packet.json", ROOT), "utf8").then(JSON.parse),
    readFile(new URL("artifacts/calibration/blind-rater-response-template.json", ROOT), "utf8").then(JSON.parse),
    readFile(new URL("artifacts/calibration/answer-key.json", ROOT), "utf8").then(JSON.parse),
  ]);
  assert.equal(packet.minimumIndependentRaters >= 2, true);
  assert.equal(packet.classificationStatus, "provisional");
  assert.equal(packet.acceptancePolicy.policyVersion, 1);
  assert.equal(packet.acceptancePolicy.minimumExactAgreementRate > 0, true);
  assert.equal(packet.acceptancePolicy.minimumWithinOneLevelAgreementRate > 0, true);
  assert.match(packet.acceptancePolicy.disputeResolution, /third independent blind rating/i);
  assert.equal(template.packetId, packet.packetId);
  assert.equal(answerKey.packetId, packet.packetId);
  assert.deepEqual(
    packet.deals.map((deal) => deal.blindId).sort(),
    template.ratings.map((rating) => rating.blindId).sort(),
  );
  assert.deepEqual(
    packet.deals.map((deal) => deal.blindId).sort(),
    answerKey.answerKey.map((entry) => entry.blindId).sort(),
  );
  for (const deal of packet.deals) {
    assert.equal("provisionalDifficulty" in deal, false);
    assert.match(deal.launchQuery, /^\?calibrationDealId=[0-9a-f]{64}&blindId=P\d{2,}$/);
  }
});
