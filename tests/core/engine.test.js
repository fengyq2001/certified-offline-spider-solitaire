import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMove,
  assertState,
  dealStock,
  deserializeState,
  getLegalMoves,
  isWin,
  restart,
  serializeState,
  undo,
} from "../../src/core/engine.js";
import { generateDeal } from "../../src/core/generator.js";

function customState(mode, placements, completed = []) {
  const state = generateDeal(0n, mode);
  const cards = new Map([...state.tableau.flat(), ...state.stock.flat()].map((card) => [card.id, { ...card }]));
  const tableau = Array.from({ length: 10 }, () => []);
  for (const [columnIndex, specs] of placements.entries()) {
    tableau[columnIndex] = specs.map(([id, faceUp = true]) => {
      const card = cards.get(id);
      assert.ok(card, `missing test card ${id}`);
      cards.delete(id);
      return { ...card, faceUp };
    });
  }
  const completedSets = completed.map((ids) => ({
    suit: cards.get(ids[0]).suit,
    cards: ids.map((id) => {
      const card = cards.get(id);
      cards.delete(id);
      return { ...card, faceUp: true };
    }),
  }));
  tableau[9].push(...[...cards.values()].map((card) => ({ ...card, faceUp: false })));
  return {
    ...state,
    tableau,
    stock: [],
    completed: completedSets,
    moveCount: 0,
    undoCount: 0,
    history: [],
    lastEvent: null,
  };
}

test("same-suit descending runs move immutably and expose one hidden card", () => {
  const initial = customState(1, new Map([
    [0, [["spades:2:7", false], ["spades:7:0"], ["spades:6:0"]]],
    [1, [["spades:8:1"]]],
  ]));
  const before = serializeState(initial);
  const next = applyMove(initial, { type: "move", from: 0, to: 1, count: 2 });
  assert.deepEqual(serializeState(initial), before, "input state mutated");
  assert.deepEqual(next.tableau[1].slice(-3).map((card) => card.rank), [8, 7, 6]);
  assert.equal(next.tableau[0].at(-1).faceUp, true);
  assert.deepEqual(next.lastEvent.flippedCardIds, ["spades:2:7"]);
  assert.equal(assertState(next), true);

  const restored = undo(next);
  assert.deepEqual(restored.tableau, initial.tableau);
  assert.deepEqual(restored.stock, initial.stock);
  assert.deepEqual(restored.completed, initial.completed);
  assert.equal(restored.moveCount, 2, "undo itself counts as a step");
  assert.equal(restored.undoCount, 1);
});

test("mixed-suit stacks cannot move together, but any suit may attach by rank", () => {
  const state = customState(2, new Map([
    [0, [["spades:7:0"], ["hearts:6:0"]]],
    [1, [["spades:8:1"]]],
    [2, [["hearts:7:1"]]],
  ]));
  assert.throws(() => applyMove(state, { type: "move", from: 0, to: 1, count: 2 }), /same-suit/);
  assert.doesNotThrow(() => applyMove(state, { type: "move", from: 0, to: 2, count: 1 }));
});

test("completing a same-suit K-A tail removes it automatically", () => {
  const runWithoutAce = Array.from({ length: 12 }, (_, index) => [`spades:${13 - index}:0`]);
  const state = customState(1, new Map([
    [0, [["spades:1:0"]]],
    [1, runWithoutAce],
  ]));
  const next = applyMove(state, { type: "move", from: 0, to: 1, count: 1 });
  assert.equal(next.completed.length, 1);
  assert.deepEqual(next.completed[0].cards.map((card) => card.rank), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(next.tableau[1].length, 0);
  assert.equal(next.lastEvent.completed.length, 1);
});

test("stock deals one face-up card to each non-empty column and rejects empty columns", () => {
  const initial = generateDeal(1n, 4);
  const dealt = dealStock(initial);
  assert.deepEqual(dealt.tableau.map((column, index) => column.length - initial.tableau[index].length), Array(10).fill(1));
  assert.equal(dealt.tableau.every((column) => column.at(-1).faceUp), true);
  assert.equal(dealt.stock.length, 4);
  assert.deepEqual(applyMove(initial, { type: "deal" }), dealt);

  const emptyColumn = structuredClone(initial);
  emptyColumn.tableau[1].push(...emptyColumn.tableau[0]);
  emptyColumn.tableau[0] = [];
  emptyColumn.tableau.flat().forEach((card) => { card.faceUp = true; });
  assert.equal(assertState(emptyColumn), true);
  assert.throws(() => dealStock(emptyColumn), /empty/);
});

test("legal move enumeration includes stock only when the deal rule permits it", () => {
  const state = generateDeal(2n, 1);
  assert.ok(getLegalMoves(state).some((move) => move.type === "deal"));
  const emptyColumn = structuredClone(state);
  emptyColumn.tableau[1].push(...emptyColumn.tableau[0]);
  emptyColumn.tableau[0] = [];
  emptyColumn.tableau.flat().forEach((card) => { card.faceUp = true; });
  assert.ok(!getLegalMoves(emptyColumn).some((move) => move.type === "deal"));
});

test("eight valid completed runs are the sole winning terminal layout", () => {
  const runs = Array.from({ length: 8 }, (_, copy) => (
    Array.from({ length: 13 }, (_, index) => `spades:${13 - index}:${copy}`)
  ));
  const state = customState(1, new Map(), runs);
  assert.equal(assertState(state), true);
  assert.equal(isWin(state), true);
});

test("serialization round-trip and restart preserve exact initial identity", () => {
  const initial = generateDeal("u64:0123456789abcdef", 2);
  const restored = deserializeState(serializeState(initial));
  assert.deepEqual(restored, initial);
  const moved = applyMove(initial, getLegalMoves(initial)[0]);
  const reset = restart(moved);
  assert.deepEqual(reset.tableau, initial.tableau);
  assert.deepEqual(reset.stock, initial.stock);
  assert.deepEqual(reset.completed, initial.completed);
  assert.equal(reset.dealId, initial.dealId);
  assert.equal(reset.initialDealHash, initial.initialDealHash);
  assert.equal(reset.history.length, 0);
});

test("strict invariants reject loss, duplication, forged identities, and corrupt hashes", () => {
  const initial = generateDeal(3n, 4);
  const corruptions = [
    (state) => { state.tableau[0].pop(); },
    (state) => { state.tableau[0].push({ ...state.tableau[1][0] }); },
    (state) => { state.tableau[0][0].rank = 1; },
    (state) => { state.dealId = "0".repeat(64); },
    (state) => { state.initialDealHash = "0".repeat(64); },
  ];
  for (const corrupt of corruptions) {
    const state = structuredClone(initial);
    corrupt(state);
    assert.throws(() => assertState(state));
  }
  assert.throws(() => applyMove(initial, { type: "unknown" }), /unknown/);
  assert.throws(() => applyMove(initial, { type: "move", from: 0, to: 1, count: 0 }), /positive/);
  assert.throws(() => applyMove(initial, { type: "move", from: -1, to: 1, count: 1 }), /columns/);
});
