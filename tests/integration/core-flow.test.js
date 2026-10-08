import assert from "node:assert/strict";
import test from "node:test";

import {
  exists,
  importProjectModule,
  liveCards,
  normalizedState,
} from "./test-support.js";

const hasCore = await exists("src", "core", "generator.js")
  && await exists("src", "core", "engine.js");

test("Seed -> Deal conserves all 104 physical cards for every suit mode", {
  skip: hasCore ? false : "core generator/engine are not implemented yet",
}, async () => {
  const generator = await importProjectModule("src", "core", "generator.js");
  const engine = await importProjectModule("src", "core", "engine.js");
  const seeds = ["u64:0000000000000000", "u64:0000000000000001", "u64:ffffffffffffffff"];

  for (const suitMode of [1, 2, 4]) {
    for (const seed of seeds) {
      const state = generator.generateDeal(seed, suitMode);
      assert.equal(engine.assertState(state), true);
      const cards = liveCards(state);
      assert.equal(cards.length, 104, `${suitMode}-suit ${seed} must have 104 live cards`);
      assert.equal(new Set(cards.map((card) => card.id)).size, 104, `${suitMode}-suit ${seed} card ids must be unique`);
    }
  }
});

test("serialized state round-trips and restart returns the exact initial deal", {
  skip: hasCore ? false : "core generator/engine are not implemented yet",
}, async () => {
  const generator = await importProjectModule("src", "core", "generator.js");
  const engine = await importProjectModule("src", "core", "engine.js");
  const initial = generator.generateDeal("u64:0123456789abcdef", 2);
  const restored = engine.deserializeState(engine.serializeState(initial));
  assert.deepEqual(normalizedState(restored), normalizedState(initial));

  const legalMoves = engine.getLegalMoves(initial);
  const changed = legalMoves.length > 0 ? engine.applyMove(initial, legalMoves[0]) : initial;
  const restarted = engine.restart(changed);
  assert.deepEqual(
    normalizedState(engine.restart(initial)),
    normalizedState(restarted),
    "restart must depend on deal identity rather than the current move history",
  );
  assert.equal(restarted.canonicalSeed, initial.canonicalSeed);
  assert.equal(restarted.suitMode, initial.suitMode);
  assert.equal(
    await generator.computeDealId(restarted.canonicalSeed, restarted.suitMode),
    await generator.computeDealId(initial.canonicalSeed, initial.suitMode),
  );
  assert.equal(
    await generator.computeInitialDealHash(engine.restart(restored)),
    await generator.computeInitialDealHash(engine.restart(initial)),
  );
});
