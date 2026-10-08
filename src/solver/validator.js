import { computeDealId, computeInitialDealHash, createDeck, normalizeSuitMode } from "../core/generator.js";
import { CERTIFICATE_SCHEMA_VERSION, VALIDATOR_VERSION } from "./constants.js";
import { clone, sha256, stableStringify } from "./canonical.js";

export const VALIDATION_ERRORS = Object.freeze({
  BAD_CERTIFICATE: "BAD_CERTIFICATE",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  INITIAL_HASH_MISMATCH: "INITIAL_HASH_MISMATCH",
  INVALID_INITIAL_STATE: "INVALID_INITIAL_STATE",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  ILLEGAL_MOVE: "ILLEGAL_MOVE",
  ILLEGAL_DEAL: "ILLEGAL_DEAL",
  EFFECT_MISMATCH: "EFFECT_MISMATCH",
  CARD_INVENTORY: "CARD_INVENTORY",
  NOT_SOLVED: "NOT_SOLVED",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
});

export class ValidationError extends Error {
  constructor(code, message, stepIndex = null) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.stepIndex = stepIndex;
  }
}

function fail(code, message, stepIndex = null) {
  throw new ValidationError(code, message, stepIndex);
}

function normalizeCard(card) {
  if (!card || typeof card !== "object") fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "card must be an object");
  if (typeof card.id !== "string" || !card.id) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "card id must be a non-empty string");
  if (!Number.isInteger(card.rank) || card.rank < 1 || card.rank > 13) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, `invalid rank for ${card.id}`);
  if (!["spades", "hearts", "diamonds", "clubs"].includes(card.suit)) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, `invalid suit for ${card.id}`);
  if (typeof card.faceUp !== "boolean") fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, `invalid faceUp for ${card.id}`);
  return { id: card.id, rank: card.rank, suit: card.suit, faceUp: card.faceUp };
}

function completedCards(completed) {
  const cards = [];
  for (const set of completed ?? []) {
    const values = Array.isArray(set) ? set : set.cards;
    if (!Array.isArray(values) || values.length !== 13) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "completed set must contain 13 cards");
    cards.push(...values.map(normalizeCard));
  }
  return cards;
}

export function parseInitialState(input) {
  if (!input || typeof input !== "object") fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "state must be an object");
  let suitMode;
  try { suitMode = normalizeSuitMode(input.suitMode); }
  catch { fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "state has an invalid suitMode"); }
  if (!Array.isArray(input.tableau) || input.tableau.length !== 10) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "tableau must contain ten columns");
  if (!Array.isArray(input.stock)) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "stock must be an array of rounds");
  const tableau = input.tableau.map((column) => {
    if (!Array.isArray(column)) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "tableau column must be an array");
    return column.map(normalizeCard);
  });
  const stock = input.stock.map((round) => {
    if (!Array.isArray(round) || round.length !== 10) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "each stock round must contain ten cards");
    return round.map(normalizeCard);
  });
  const removed = completedCards(input.completed);
  const all = [...tableau.flat(), ...stock.flat(), ...removed];
  if (all.length !== 104) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, `expected 104 cards, got ${all.length}`);
  const ids = new Set(all.map((card) => card.id));
  if (ids.size !== 104) fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "duplicate card id in initial state");
  const expectedCards = new Map(createDeck(suitMode).map((card) => [card.id, card]));
  for (const card of all) {
    const expected = expectedCards.get(card.id);
    if (!expected || expected.rank !== card.rank || expected.suit !== card.suit) {
      fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, `card ${card.id} does not belong to the declared physical deck`);
    }
  }
  if ([...expectedCards.keys()].some((id) => !ids.has(id))) {
    fail(VALIDATION_ERRORS.INVALID_INITIAL_STATE, "initial state is missing a physical card");
  }
  return {
    tableau,
    stock,
    completedRuns: (input.completed ?? []).length,
    removedCardIds: removed.map((card) => card.id),
    allCardIds: [...ids].sort(),
    suitMode,
    canonicalSeed: input.canonicalSeed,
    ruleVersion: input.ruleVersion ?? "1.0",
    generatorVersion: input.generatorVersion ?? "1",
  };
}

function assertInventory(state, stepIndex) {
  const active = [...state.tableau.flat(), ...state.stock.flat()].map((card) => card.id);
  const ids = [...active, ...state.removedCardIds];
  if (ids.length !== state.allCardIds.length || new Set(ids).size !== ids.length) {
    fail(VALIDATION_ERRORS.CARD_INVENTORY, "card inventory contains a duplicate or missing card", stepIndex);
  }
  ids.sort();
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== state.allCardIds[index]) fail(VALIDATION_ERRORS.CARD_INVENTORY, "card inventory changed", stepIndex);
  }
}

function isMovableRun(cards) {
  if (!cards.length || cards.some((card) => !card.faceUp)) return false;
  for (let index = 0; index < cards.length - 1; index += 1) {
    if (cards[index].suit !== cards[index + 1].suit || cards[index].rank !== cards[index + 1].rank + 1) return false;
  }
  return true;
}

function completeRuns(state, effects) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let columnIndex = 0; columnIndex < state.tableau.length; columnIndex += 1) {
      const column = state.tableau[columnIndex];
      if (column.length < 13) continue;
      const run = column.slice(-13);
      if (run[0].rank !== 13 || run[12].rank !== 1 || !isMovableRun(run)) continue;
      column.splice(-13);
      state.completedRuns += 1;
      state.removedCardIds.push(...run.map((card) => card.id));
      effects.completed.push({ column: columnIndex, suit: run[0].suit, cardIds: run.map((card) => card.id) });
      const exposed = column.at(-1);
      if (exposed && !exposed.faceUp) {
        exposed.faceUp = true;
        effects.flipped.push(exposed.id);
      }
      changed = true;
    }
  }
}

function applyMoveIndependent(state, move, stepIndex) {
  const effects = { flipped: [], completed: [] };
  if (!move || typeof move !== "object" || typeof move.type !== "string") fail(VALIDATION_ERRORS.UNKNOWN_OPERATION, "operation must have a type", stepIndex);
  if (move.type === "deal") {
    if (state.stock.length === 0) fail(VALIDATION_ERRORS.ILLEGAL_DEAL, "stock is empty", stepIndex);
    if (state.tableau.some((column) => column.length === 0)) fail(VALIDATION_ERRORS.ILLEGAL_DEAL, "cannot deal with an empty column", stepIndex);
    const round = state.stock.shift();
    for (let column = 0; column < 10; column += 1) state.tableau[column].push({ ...round[column], faceUp: true });
    completeRuns(state, effects);
    assertInventory(state, stepIndex);
    return effects;
  }
  if (move.type !== "move") fail(VALIDATION_ERRORS.UNKNOWN_OPERATION, `unknown operation ${move.type}`, stepIndex);
  const { from, to, count } = move;
  if (![from, to, count].every(Number.isSafeInteger) || from < 0 || from >= 10 || to < 0 || to >= 10 || from === to || count < 1) {
    fail(VALIDATION_ERRORS.ILLEGAL_MOVE, "invalid move coordinates", stepIndex);
  }
  const source = state.tableau[from];
  const destination = state.tableau[to];
  if (source.length < count) fail(VALIDATION_ERRORS.ILLEGAL_MOVE, "source has too few cards", stepIndex);
  const cards = source.slice(-count);
  if (!isMovableRun(cards)) fail(VALIDATION_ERRORS.ILLEGAL_MOVE, "moved cards are not a same-suit descending run", stepIndex);
  const destinationTop = destination.at(-1);
  if (destinationTop && destinationTop.rank !== cards[0].rank + 1) fail(VALIDATION_ERRORS.ILLEGAL_MOVE, "destination rank does not accept the run", stepIndex);
  source.splice(-count);
  destination.push(...cards);
  const exposed = source.at(-1);
  if (exposed && !exposed.faceUp) {
    exposed.faceUp = true;
    effects.flipped.push(exposed.id);
  }
  completeRuns(state, effects);
  assertInventory(state, stepIndex);
  return effects;
}

function normalizedEffects(effects) {
  return {
    flipped: [...effects.flipped],
    completed: effects.completed.map((run) => ({ column: run.column, suit: run.suit, cardIds: [...run.cardIds] })),
  };
}

function replay(initialState, steps, requireSolved) {
  const state = parseInitialState(initialState);
  const normalizedSteps = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const move = step?.move ?? step;
    const effects = applyMoveIndependent(state, move, index);
    if (step?.effects !== undefined && stableStringify(step.effects) !== stableStringify(normalizedEffects(effects))) {
      fail(VALIDATION_ERRORS.EFFECT_MISMATCH, "declared automatic effects do not match replay", index);
    }
    normalizedSteps.push({ move: clone(move), effects: normalizedEffects(effects) });
  }
  if (requireSolved && (state.completedRuns !== 8 || state.tableau.some((column) => column.length > 0) || state.stock.length > 0)) {
    fail(VALIDATION_ERRORS.NOT_SOLVED, "certificate does not end in a win", steps.length);
  }
  return { state, normalizedSteps };
}

function certificatePayload(certificate) {
  const { certificateHash: ignored, ...payload } = certificate;
  return payload;
}

export async function createSolutionCertificate(initialState, moves, metadata = {}) {
  if (!Array.isArray(moves)) throw new TypeError("moves must be an array");
  const { normalizedSteps } = replay(initialState, moves, true);
  const certificate = {
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    ruleVersion: initialState.ruleVersion ?? "1.0",
    generatorVersion: initialState.generatorVersion ?? "1",
    suitMode: initialState.suitMode,
    canonicalSeed: initialState.canonicalSeed,
    dealId: metadata.dealId ?? await computeDealId(initialState.canonicalSeed, initialState.suitMode, initialState.ruleVersion, initialState.generatorVersion),
    initialDealHash: metadata.initialDealHash ?? await computeInitialDealHash(initialState),
    steps: normalizedSteps,
    solutionLength: normalizedSteps.length,
    claimedFinalCompletedRuns: 8,
  };
  if (metadata.solverVersion !== undefined) certificate.solverVersion = metadata.solverVersion;
  if (metadata.solverConfigHash !== undefined) certificate.solverConfigHash = metadata.solverConfigHash;
  certificate.certificateHash = sha256(certificate);
  return certificate;
}

export async function validateSolutionCertificate(initialState, certificate) {
  try {
    if (!certificate || typeof certificate !== "object" || !Array.isArray(certificate.steps)) fail(VALIDATION_ERRORS.BAD_CERTIFICATE, "certificate must contain steps");
    if (certificate.schemaVersion !== CERTIFICATE_SCHEMA_VERSION || certificate.validatorVersion !== VALIDATOR_VERSION) fail(VALIDATION_ERRORS.VERSION_MISMATCH, "certificate schema or validator version mismatch");
    if (certificate.solutionLength !== certificate.steps.length || certificate.claimedFinalCompletedRuns !== 8) fail(VALIDATION_ERRORS.BAD_CERTIFICATE, "certificate summary is inconsistent");
    if (certificate.certificateHash !== sha256(certificatePayload(certificate))) fail(VALIDATION_ERRORS.CHECKSUM_MISMATCH, "certificate checksum mismatch");
    const expectedDealId = await computeDealId(initialState.canonicalSeed, initialState.suitMode, initialState.ruleVersion, initialState.generatorVersion);
    if (certificate.dealId !== expectedDealId || certificate.canonicalSeed !== initialState.canonicalSeed || certificate.suitMode !== initialState.suitMode) {
      fail(VALIDATION_ERRORS.IDENTITY_MISMATCH, "certificate identity does not match the deal");
    }
    const expectedInitialHash = await computeInitialDealHash(initialState);
    if (certificate.initialDealHash !== expectedInitialHash) fail(VALIDATION_ERRORS.INITIAL_HASH_MISMATCH, "initial deal hash mismatch");
    replay(initialState, certificate.steps, true);
    return { pass: true, validatorVersion: VALIDATOR_VERSION, solutionLength: certificate.steps.length };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { pass: false, validatorVersion: VALIDATOR_VERSION, errorCode: error.code, stepIndex: error.stepIndex, message: error.message };
    }
    return { pass: false, validatorVersion: VALIDATOR_VERSION, errorCode: VALIDATION_ERRORS.BAD_CERTIFICATE, stepIndex: null, message: error.message };
  }
}

export function replayForTesting(initialState, steps, { requireSolved = false } = {}) {
  return replay(initialState, steps, requireSolved);
}
