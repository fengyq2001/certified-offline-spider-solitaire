import test from "node:test";
import assert from "node:assert/strict";
import { solve } from "../../src/solver/search.js";
import { analyzeDifficulty, classifyScore } from "../../src/solver/difficulty.js";
import { nearWinState } from "./fixtures.js";

test("bounded solver emits a replayable path for a near-win state", () => {
  const result = solve(nearWinState(), { nodeBudget: 500, timeoutMs: 2_000 });
  assert.equal(result.status, "SOLVED");
  assert.ok(result.moves.length >= 1);
  assert.ok(result.metrics.nodesExpanded <= 500);
});

test("difficulty ranges are non-overlapping at their boundaries", () => {
  assert.equal(classifyScore(0), "easy");
  assert.equal(classifyScore(24.999), "easy");
  assert.equal(classifyScore(25), "medium");
  assert.equal(classifyScore(55), "hard");
  assert.equal(classifyScore(80), "demon");
  assert.equal(classifyScore(100), "demon");
});


test("difficulty analyzer records the complete metric contract", () => {
  const state = nearWinState();
  const solveResult = solve(state, { nodeBudget: 500, timeoutMs: 2_000 });
  const result = analyzeDifficulty(state, solveResult);
  for (const key of [
    "solutionLength", "initialLegalMoves", "initialSafeMoves", "hiddenCardDepth",
    "sameSuitConnectivity", "crossSuitFragmentation", "emptyColumnDepth",
    "temporaryBreakCount", "branchingFactor", "solverBacktracks", "solverNodes",
    "criticalMoveCount", "recoveryOptions",
  ]) assert.ok(Object.hasOwn(result.metrics, key), key);
  assert.ok(result.difficultyScore >= 0 && result.difficultyScore <= 100);
});
