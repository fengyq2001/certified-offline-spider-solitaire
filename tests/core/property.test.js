import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMove,
  assertState,
  deserializeState,
  getLegalMoves,
  serializeState,
  undo,
} from "../../src/core/engine.js";
import { generateDeal } from "../../src/core/generator.js";

function digest(state) {
  return JSON.stringify({
    tableau: state.tableau,
    stock: state.stock,
    completed: state.completed,
    history: state.history,
  });
}

test("deterministic action sequences preserve cards, serialization, undo, and rejected-action immutability", () => {
  for (const suitMode of [1, 2, 4]) {
    for (let sample = 0; sample < 12; sample += 1) {
      let state = generateDeal(BigInt(10_000 * suitMode + sample), suitMode);
      for (let step = 0; step < 20; step += 1) {
        assert.equal(assertState(state), true);
        const serialized = serializeState(state);
        assert.deepEqual(deserializeState(serialized), state);

        const beforeRejected = digest(state);
        assert.throws(() => applyMove(state, { type: "move", from: -1, to: 10, count: 0 }));
        assert.equal(digest(state), beforeRejected);

        const moves = getLegalMoves(state);
        if (moves.length === 0) break;
        const previous = state;
        state = applyMove(state, moves[(sample * 17 + step * 31) % moves.length]);
        assert.equal(assertState(state), true);
        const restored = undo(state);
        assert.deepEqual(restored.tableau, previous.tableau);
        assert.deepEqual(restored.stock, previous.stock);
        assert.deepEqual(restored.completed, previous.completed);
      }
    }
  }
});
