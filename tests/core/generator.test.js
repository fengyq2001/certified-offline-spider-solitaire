import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalizeSeed,
  computeDealId,
  computeInitialDealHash,
  createDeck,
  createXoshiro256StarStar,
  generateDeal,
  shuffleDeck,
} from "../../src/core/generator.js";

test("canonical u64 seeds reject lossy and ambiguous representations", () => {
  assert.equal(canonicalizeSeed(0n), "u64:0000000000000000");
  assert.equal(canonicalizeSeed(0xffffffffffffffffn), "u64:ffffffffffffffff");
  for (const invalid of [0, -1n, 1n << 64n, "1", "u64:1", "u64:ABCDEF0123456789"]) {
    assert.throws(() => canonicalizeSeed(invalid));
  }
});

test("SplitMix64 plus xoshiro256** matches the frozen reference vector", () => {
  const random = createXoshiro256StarStar(0n);
  const actual = Array.from({ length: 8 }, () => random.nextUint64().toString(16).padStart(16, "0"));
  assert.deepEqual(actual, [
    "99ec5f36cb75f2b4", "bf6e1f784956452a", "1a5f849d4933e6e0", "6aa594f1262d2d2c",
    "bba5ad4a1f842e59", "ffef8375d9ebcaca", "6c160deed2f54c98", "8920ad648fc30a3f",
  ]);
});

test("deck construction preserves the physical 104-card multiset in every mode", () => {
  for (const mode of [1, 2, 4]) {
    const deck = createDeck(mode);
    assert.equal(deck.length, 104);
    assert.equal(new Set(deck.map((card) => card.id)).size, 104);
    assert.equal(new Set(deck.map((card) => card.suit)).size, mode);
    assert.deepEqual(
      [...new Set(deck.map((card) => card.rank))],
      Array.from({ length: 13 }, (_, index) => index + 1),
    );
  }
});

test("shuffle and deal are deterministic and preserve frozen traversal", async () => {
  const known = JSON.parse(await readFile(new URL("../fixtures/known-seed-fixtures.json", import.meta.url), "utf8"));
  assert.equal(known.schemaVersion, 1);
  for (const fixture of known.fixtures) {
    const state = generateDeal(fixture.canonicalSeed, fixture.suitMode);
    assert.deepEqual(state.tableau.map((column) => column.length), [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]);
    assert.deepEqual(state.stock.map((round) => round.length), [10, 10, 10, 10, 10]);
    assert.equal(state.tableau.flat().filter((card) => card.faceUp).length, 10);
    assert.equal(state.stock.flat().some((card) => card.faceUp), false);
    assert.deepEqual(shuffleDeck(fixture.canonicalSeed, fixture.suitMode), shuffleDeck(fixture.canonicalSeed, fixture.suitMode));
    assert.equal(state.dealId, fixture.dealId);
    assert.equal(state.initialDealHash, fixture.initialDealHash);
    assert.equal(await computeDealId(fixture.canonicalSeed, fixture.suitMode), state.dealId);
    assert.equal(await computeInitialDealHash(state), state.initialDealHash);
  }
});

test("factory namespaces use the pinned Toranpu-compatible deal stream", () => {
  const state = generateDeal("u64:400000000000000b", 4);
  assert.deepEqual(
    state.tableau.map((column) => `${column[0].rank}:${column[0].suit}`),
    ["13:spades", "9:clubs", "12:diamonds", "3:clubs", "1:clubs", "9:hearts", "7:clubs", "11:hearts", "5:hearts", "4:spades"],
  );
  for (const [seed, mode] of [["u64:1000000000000001", 1], ["u64:2000000000000001", 2]]) {
    const factory = generateDeal(seed, mode);
    const legacy = generateDeal("u64:0000000000000001", mode);
    assert.equal(factory.tableau.flat().length, 54);
    assert.notDeepEqual(factory.tableau, legacy.tableau);
  }
});

test("deal identity SHA-256 agrees with an independent Node implementation", async () => {
  const canonical = [
    "ruleVersion=1.0",
    "generatorVersion=1",
    "suitMode=2",
    "canonicalSeed=u64:0123456789abcdef",
  ].join("\n");
  assert.equal(
    await computeDealId("u64:0123456789abcdef", 2),
    createHash("sha256").update(canonical, "utf8").digest("hex"),
  );
});
