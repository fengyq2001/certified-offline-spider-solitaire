import test from "node:test";
import assert from "node:assert/strict";
import { createSolutionCertificate, replayForTesting, validateSolutionCertificate, VALIDATION_ERRORS } from "../../src/solver/validator.js";
import { createCertificateMutations } from "../../src/solver/mutations.js";
import { nearWinState, NEAR_WIN_MOVES } from "./fixtures.js";
import { generateDeal } from "../../src/core/generator.js";

test("independent validator replays a complete solution certificate", async () => {
  const state = nearWinState();
  const certificate = await createSolutionCertificate(state, NEAR_WIN_MOVES, { solverVersion: "test" });
  const result = await validateSolutionCertificate(state, certificate);
  assert.equal(result.pass, true);
  assert.equal(result.solutionLength, 2);
  assert.equal(certificate.steps[0].effects.completed.length, 7);
  assert.equal(certificate.steps[1].effects.completed.length, 1);
});

test("all standard certificate mutations are rejected", async () => {
  const state = nearWinState();
  const certificate = await createSolutionCertificate(state, NEAR_WIN_MOVES);
  for (const mutation of createCertificateMutations(certificate)) {
    const result = await validateSolutionCertificate(state, mutation.certificate);
    assert.equal(result.pass, false, mutation.name);
  }
  assert.deepEqual(
    new Set(createCertificateMutations(certificate).map(({ name }) => name)),
    new Set([
      "deleted-step", "duplicated-step", "swapped-steps", "illegal-move",
      "illegal-multi-card-move", "unknown-operation", "out-of-range-values",
      "wrong-flip-effect", "wrong-completion-effect", "truncated-solution",
      "forged-win", "identity-mismatch", "initial-hash-mismatch", "bad-version",
    ]),
  );
});

test("validator rejects duplicate cards before replay", () => {
  const state = nearWinState();
  state.tableau[0][0].id = state.tableau[0][1].id;
  assert.throws(
    () => replayForTesting(state, []),
    (error) => error.code === VALIDATION_ERRORS.INVALID_INITIAL_STATE,
  );
});

test("validator rejects a missing physical card before replay", () => {
  const state = nearWinState();
  state.tableau[0].pop();
  assert.throws(
    () => replayForTesting(state, []),
    (error) => error.code === VALIDATION_ERRORS.INVALID_INITIAL_STATE && /expected 104/.test(error.message),
  );
});

test("validator rejects dealing while a tableau column is empty", () => {
  const state = generateDeal("u64:0000000000000011", 1);
  state.tableau[0].push(...state.tableau[9]);
  state.tableau[9] = [];
  assert.throws(
    () => replayForTesting(state, [{ type: "deal" }]),
    (error) => error.code === VALIDATION_ERRORS.ILLEGAL_DEAL,
  );
});

test("validator rejects a mixed-suit multi-card move", () => {
  const state = generateDeal("u64:0000000000000012", 2);
  const cards = [...state.tableau.flat(), ...state.stock.flat()].map((card) => ({ ...card, faceUp: false }));
  const spadeNine = cards.find((card) => card.suit === "spades" && card.rank === 9);
  const heartEight = cards.find((card) => card.suit === "hearts" && card.rank === 8);
  const remaining = cards.filter((card) => card.id !== spadeNine.id && card.id !== heartEight.id);
  spadeNine.faceUp = true;
  heartEight.faceUp = true;
  state.tableau = [[...remaining, spadeNine, heartEight], [], [], [], [], [], [], [], [], []];
  state.stock = [];
  state.completed = [];
  assert.throws(
    () => replayForTesting(state, [{ type: "move", from: 0, to: 1, count: 2 }]),
    (error) => error.code === VALIDATION_ERRORS.ILLEGAL_MOVE && /same-suit/.test(error.message),
  );
});

test("identity and initial hash mismatches have stable error codes", async () => {
  const state = nearWinState();
  const certificate = await createSolutionCertificate(state, NEAR_WIN_MOVES);
  const mutations = new Map(createCertificateMutations(certificate).map((mutation) => [mutation.name, mutation.certificate]));
  assert.equal((await validateSolutionCertificate(state, mutations.get("identity-mismatch"))).errorCode, VALIDATION_ERRORS.IDENTITY_MISMATCH);
  assert.equal((await validateSolutionCertificate(state, mutations.get("initial-hash-mismatch"))).errorCode, VALIDATION_ERRORS.INITIAL_HASH_MISMATCH);
});

test("validator rejects a unique-id deck whose physical rank inventory is forged", () => {
  const state = nearWinState();
  const card = state.tableau[0][0];
  card.rank = card.rank === 1 ? 2 : 1;
  assert.throws(
    () => replayForTesting(state, []),
    (error) => error.code === VALIDATION_ERRORS.INVALID_INITIAL_STATE
      && /declared physical deck/.test(error.message),
  );
});

test("validator rejects an unknown unique identity that replaces a physical card", () => {
  const state = nearWinState();
  state.tableau[0][0].id = "forged-unique-card-id";
  assert.throws(
    () => replayForTesting(state, []),
    (error) => error.code === VALIDATION_ERRORS.INVALID_INITIAL_STATE
      && /declared physical deck|missing a physical card/.test(error.message),
  );
});
