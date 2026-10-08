import assert from "node:assert/strict";
import test from "node:test";

import { applyMove, getLegalMoves, undo } from "../../src/core/engine.js";
import { generateDeal } from "../../src/core/generator.js";
import {
  calculateScore,
  createScoreState,
  createTimerState,
  shouldAnimate,
  timerElapsedMs,
  transitionScore,
  transitionTimer,
} from "../../src/ui/game-session.js";

test("timer starts only after a successful action and preserves millisecond elapsed time", () => {
  const waiting = createTimerState();
  assert.equal(waiting.status, "WAITING");
  assert.equal(timerElapsedMs(waiting, 900), 0);

  const running = transitionTimer(waiting, "SUCCESS", 1_000);
  assert.deepEqual(running, { status: "RUNNING", elapsedMs: 0, startedAt: 1_000 });
  assert.equal(timerElapsedMs(running, 2_550), 1_550);

  const paused = transitionTimer(running, "PAUSE", 3_000);
  assert.deepEqual(paused, { status: "PAUSED", elapsedMs: 2_000, startedAt: null });
  assert.equal(timerElapsedMs(paused, 50_000), 2_000);

  const resumed = transitionTimer(paused, "RESUME", 4_000);
  const finished = transitionTimer(resumed, "FINISH", 5_250);
  assert.deepEqual(finished, { status: "FINISHED", elapsedMs: 3_250, startedAt: null });
  assert.deepEqual(transitionTimer(finished, "RESET", 6_000), createTimerState());
});

test("pause, resume and finish are idempotent outside their valid transition", () => {
  const waiting = createTimerState();
  assert.deepEqual(transitionTimer(waiting, "PAUSE", 1), waiting);
  assert.deepEqual(transitionTimer(waiting, "RESUME", 1), waiting);
  const finished = transitionTimer(waiting, "FINISH", 1);
  assert.deepEqual(transitionTimer(finished, "FINISH", 2), finished);
  assert.throws(() => transitionTimer(waiting, "HINT", 0), /unknown timer event/);
});

test("score rewards follow the full 3 x 4 matrix and charge every scoring move", () => {
  const base = { completedSets: 2, scoringMoves: 17 };
  assert.equal(calculateScore({ ...base, suitMode: "1s", difficulty: "easy" }), 183);
  assert.equal(calculateScore({ ...base, suitMode: 2, difficulty: "hard" }), 783);
  assert.equal(calculateScore({ ...base, suitMode: "4s", difficulty: "demon" }), 2_383);
  assert.throws(() => calculateScore({ ...base, suitMode: "3s", difficulty: "easy" }), /unknown score bucket/);
});

test("score transitions count consecutive Undo actions while ignoring hints and automatic effects", () => {
  let score = createScoreState();
  for (const event of ["MOVE", "DEAL", "UNDO", "UNDO", "HINT", "SELECT", "AUTO_FLIP"]) {
    score = transitionScore(score, event);
  }
  score = transitionScore(score, { type: "COMPLETE", count: 2 });
  assert.deepEqual(score, { completedSets: 2, scoringMoves: 4 });
  assert.equal(calculateScore({ suitMode: "1s", difficulty: "easy", ...score }), 196);
});

test("core supports consecutive Undo round-trips and charges each Undo as a step", () => {
  const initial = generateDeal("u64:0000000000000042", 1);
  const firstMove = getLegalMoves(initial)[0];
  const first = applyMove(initial, firstMove);
  const secondMove = getLegalMoves(first)[0];
  const second = applyMove(first, secondMove);
  const once = undo(second);
  const twice = undo(once);
  assert.deepEqual(once.tableau, first.tableau);
  assert.deepEqual(twice.tableau, initial.tableau);
  assert.deepEqual(twice.stock, initial.stock);
  assert.equal(twice.history.length, 0);
  assert.equal(twice.moveCount, 4);
  assert.equal(twice.undoCount, 2);
});

test("animation preference respects both explicit and operating-system reduced motion", () => {
  assert.equal(shouldAnimate({ animation: true, reduceMotion: false }, () => ({ matches: false })), true);
  assert.equal(shouldAnimate({ animation: false, reduceMotion: false }, () => ({ matches: false })), false);
  assert.equal(shouldAnimate({ animation: true, reduceMotion: true }, () => ({ matches: false })), false);
  assert.equal(shouldAnimate({ animation: true, reduceMotion: false }, () => ({ matches: true })), false);
});
