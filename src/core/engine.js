import {
  GENERATOR_VERSION,
  RULE_VERSION,
  canonicalizeSeed,
  computeDealIdSync,
  computeInitialDealHashSync,
  createDeck,
  generateDeal,
  normalizeSuitMode,
} from "./generator.js";

const VALID_SUITS = new Set(["spades", "hearts", "diamonds", "clubs"]);

function cloneCard(card) {
  return { id: card.id, rank: card.rank, suit: card.suit, faceUp: card.faceUp };
}

function cloneCompletedSet(set) {
  return { suit: set.suit, cards: set.cards.map(cloneCard) };
}

function cloneSnapshot(snapshot) {
  return {
    tableau: snapshot.tableau.map((column) => column.map(cloneCard)),
    stock: snapshot.stock.map((round) => round.map(cloneCard)),
    completed: snapshot.completed.map(cloneCompletedSet),
    moveCount: snapshot.moveCount,
  };
}

function snapshotOf(state) {
  return cloneSnapshot({
    tableau: state.tableau,
    stock: state.stock,
    completed: state.completed,
    moveCount: state.moveCount,
  });
}

function cloneHistoryEntry(entry) {
  return {
    event: structuredClone(entry.event),
    snapshot: cloneSnapshot(entry.snapshot),
  };
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    ruleVersion: state.ruleVersion,
    generatorVersion: state.generatorVersion,
    canonicalSeed: state.canonicalSeed,
    suitMode: state.suitMode,
    dealId: state.dealId,
    initialDealHash: state.initialDealHash,
    tableau: state.tableau.map((column) => column.map(cloneCard)),
    stock: state.stock.map((round) => round.map(cloneCard)),
    completed: state.completed.map(cloneCompletedSet),
    moveCount: state.moveCount,
    undoCount: state.undoCount,
    history: state.history.map(cloneHistoryEntry),
    lastEvent: state.lastEvent === null ? null : structuredClone(state.lastEvent),
    initialSnapshot: cloneSnapshot(state.initialSnapshot),
  };
}

function isDescendingSameSuit(cards) {
  if (cards.length === 0) return false;
  return cards.every((card, index) => (
    card.faceUp
    && (index === 0 || (cards[index - 1].suit === card.suit && cards[index - 1].rank === card.rank + 1))
  ));
}

function canPlace(movingBottom, destinationTop) {
  return destinationTop === undefined || destinationTop.rank === movingBottom.rank + 1;
}

function movableRunLength(column) {
  if (column.length === 0 || !column[column.length - 1].faceUp) return 0;
  let count = 1;
  for (let index = column.length - 1; index > 0; index -= 1) {
    const upper = column[index];
    const lower = column[index - 1];
    if (!lower.faceUp || lower.suit !== upper.suit || lower.rank !== upper.rank + 1) break;
    count += 1;
  }
  return count;
}

function normalizeMove(move) {
  if (!move || typeof move !== "object" || Array.isArray(move)) throw new TypeError("move must be an object");
  if (move.type === "deal") {
    if (Object.keys(move).some((key) => key !== "type")) throw new TypeError("deal move has unknown fields");
    return { type: "deal" };
  }
  if (move.type !== "move") throw new TypeError("unknown move type");
  const keys = Object.keys(move).sort().join(",");
  if (keys !== "count,from,to,type") throw new TypeError("move has missing or unknown fields");
  for (const key of ["from", "to", "count"]) {
    if (!Number.isSafeInteger(move[key])) throw new TypeError(`${key} must be an integer`);
  }
  return { type: "move", from: move.from, to: move.to, count: move.count };
}

function ensureMoveLegal(state, move) {
  if (move.from < 0 || move.from >= 10 || move.to < 0 || move.to >= 10 || move.from === move.to) {
    throw new RangeError("move columns are invalid");
  }
  if (move.count <= 0) throw new RangeError("move count must be positive");
  const source = state.tableau[move.from];
  if (move.count > source.length) throw new RangeError("move count exceeds source column");
  const cards = source.slice(-move.count);
  if (!isDescendingSameSuit(cards)) throw new Error("only a face-up, descending same-suit run may move together");
  const destination = state.tableau[move.to];
  if (!canPlace(cards[0], destination[destination.length - 1])) {
    throw new Error("destination must be empty or one rank higher");
  }
}

function flipExposed(column, event) {
  const top = column[column.length - 1];
  if (top && !top.faceUp) {
    top.faceUp = true;
    event.flippedCardIds.push(top.id);
  }
}

function isCompleteRun(cards) {
  if (cards.length !== 13 || !cards.every((card) => card.faceUp)) return false;
  const suit = cards[0].suit;
  return cards.every((card, index) => card.suit === suit && card.rank === 13 - index);
}

function autoCompleteAll(next, event) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let columnIndex = 0; columnIndex < next.tableau.length; columnIndex += 1) {
      const column = next.tableau[columnIndex];
      if (column.length < 13) continue;
      const candidate = column.slice(-13);
      if (!isCompleteRun(candidate)) continue;
      column.splice(-13, 13);
      const completedSet = { suit: candidate[0].suit, cards: candidate };
      next.completed.push(completedSet);
      event.completed.push({
        column: columnIndex,
        suit: completedSet.suit,
        cardIds: candidate.map((card) => card.id),
      });
      flipExposed(column, event);
      changed = true;
    }
  }
}

export function getLegalMoves(state) {
  assertState(state);
  const moves = [];
  for (let from = 0; from < state.tableau.length; from += 1) {
    const maxCount = movableRunLength(state.tableau[from]);
    for (let count = 1; count <= maxCount; count += 1) {
      const movingBottom = state.tableau[from][state.tableau[from].length - count];
      for (let to = 0; to < state.tableau.length; to += 1) {
        if (from === to) continue;
        const destination = state.tableau[to];
        if (canPlace(movingBottom, destination[destination.length - 1])) {
          moves.push({ type: "move", from, to, count });
        }
      }
    }
  }
  if (state.stock.length > 0 && state.tableau.every((column) => column.length > 0)) {
    moves.push({ type: "deal" });
  }
  return moves;
}

export function applyMove(state, rawMove) {
  assertState(state);
  const move = normalizeMove(rawMove);
  if (move.type === "deal") return dealStock(state);
  ensureMoveLegal(state, move);

  const next = cloneState(state);
  const previous = snapshotOf(state);
  const event = {
    type: "move",
    from: move.from,
    to: move.to,
    count: move.count,
    movedCardIds: next.tableau[move.from].slice(-move.count).map((card) => card.id),
    flippedCardIds: [],
    completed: [],
  };
  const moved = next.tableau[move.from].splice(-move.count, move.count);
  next.tableau[move.to].push(...moved);
  flipExposed(next.tableau[move.from], event);
  autoCompleteAll(next, event);
  next.moveCount += 1;
  next.history.push({ event: structuredClone(event), snapshot: previous });
  next.lastEvent = event;
  assertState(next);
  return next;
}

export function dealStock(state) {
  assertState(state);
  if (state.stock.length === 0) throw new Error("stock is empty");
  if (state.tableau.some((column) => column.length === 0)) {
    throw new Error("cannot deal stock while any tableau column is empty");
  }

  const next = cloneState(state);
  const previous = snapshotOf(state);
  const round = next.stock.shift();
  if (round.length !== 10) throw new Error("stock round must contain ten cards");
  const event = { type: "deal", dealtCardIds: [], flippedCardIds: [], completed: [] };
  for (let column = 0; column < 10; column += 1) {
    const card = round[column];
    card.faceUp = true;
    next.tableau[column].push(card);
    event.dealtCardIds.push(card.id);
  }
  autoCompleteAll(next, event);
  next.moveCount += 1;
  next.history.push({ event: structuredClone(event), snapshot: previous });
  next.lastEvent = event;
  assertState(next);
  return next;
}

export function undo(state) {
  assertState(state);
  if (state.history.length === 0) return state;
  const entry = state.history[state.history.length - 1];
  const next = cloneState(state);
  const restored = cloneSnapshot(entry.snapshot);
  next.tableau = restored.tableau;
  next.stock = restored.stock;
  next.completed = restored.completed;
  next.moveCount = state.moveCount + 1;
  next.undoCount = state.undoCount + 1;
  next.history.pop();
  next.lastEvent = { type: "undo", reverted: structuredClone(entry.event) };
  assertState(next);
  return next;
}

export function restart(state) {
  assertState(state);
  const next = cloneState(state);
  const initial = cloneSnapshot(state.initialSnapshot);
  next.tableau = initial.tableau;
  next.stock = initial.stock;
  next.completed = initial.completed;
  next.moveCount = 0;
  next.undoCount = 0;
  next.history = [];
  next.lastEvent = { type: "restart" };
  assertState(next);
  return next;
}

export function isWin(state) {
  assertState(state);
  return state.completed.length === 8
    && state.stock.length === 0
    && state.tableau.every((column) => column.length === 0);
}

export function serializeState(state) {
  assertState(state);
  return JSON.parse(JSON.stringify(state));
}

export function deserializeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("serialized state must be an object");
  const state = structuredClone(value);
  assertState(state);
  return state;
}

function assertCard(card, location, ids, expectedCards) {
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new TypeError(`${location} is not a card`);
  const keys = Object.keys(card).sort().join(",");
  if (keys !== "faceUp,id,rank,suit") throw new TypeError(`${location} has invalid card fields`);
  if (typeof card.id !== "string" || card.id.length === 0) throw new TypeError(`${location}.id is invalid`);
  if (!Number.isInteger(card.rank) || card.rank < 1 || card.rank > 13) throw new RangeError(`${location}.rank is invalid`);
  if (!VALID_SUITS.has(card.suit)) throw new RangeError(`${location}.suit is invalid`);
  if (typeof card.faceUp !== "boolean") throw new TypeError(`${location}.faceUp is invalid`);
  const expected = expectedCards.get(card.id);
  if (!expected || expected.rank !== card.rank || expected.suit !== card.suit) {
    throw new Error(`${location} does not belong to the declared suit mode deck`);
  }
  if (ids.has(card.id)) throw new Error(`duplicate card id: ${card.id}`);
  ids.add(card.id);
}

function assertSnapshot(snapshot, location, suitMode, expectedIds = null) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError(`${location} is invalid`);
  if (!Array.isArray(snapshot.tableau) || snapshot.tableau.length !== 10) throw new Error(`${location}.tableau must have ten columns`);
  if (!Array.isArray(snapshot.stock) || snapshot.stock.length > 5) throw new Error(`${location}.stock is invalid`);
  if (!Array.isArray(snapshot.completed) || snapshot.completed.length > 8) throw new Error(`${location}.completed is invalid`);
  if (!Number.isSafeInteger(snapshot.moveCount) || snapshot.moveCount < 0) throw new Error(`${location}.moveCount is invalid`);

  const ids = new Set();
  const expectedCards = new Map(createDeck(suitMode).map((card) => [card.id, card]));
  snapshot.tableau.forEach((column, columnIndex) => {
    if (!Array.isArray(column)) throw new TypeError(`${location}.tableau[${columnIndex}] is invalid`);
    let sawFaceUp = false;
    column.forEach((card, cardIndex) => {
      assertCard(card, `${location}.tableau[${columnIndex}][${cardIndex}]`, ids, expectedCards);
      if (card.faceUp) sawFaceUp = true;
      else if (sawFaceUp) throw new Error("a face-down tableau card cannot be above a face-up card");
    });
  });
  snapshot.stock.forEach((round, roundIndex) => {
    if (!Array.isArray(round) || round.length !== 10) throw new Error(`${location}.stock[${roundIndex}] must contain ten cards`);
    round.forEach((card, cardIndex) => {
      assertCard(card, `${location}.stock[${roundIndex}][${cardIndex}]`, ids, expectedCards);
      if (card.faceUp) throw new Error("stock cards must be face-down");
    });
  });
  snapshot.completed.forEach((set, setIndex) => {
    if (!set || typeof set !== "object" || !VALID_SUITS.has(set.suit) || !Array.isArray(set.cards)) {
      throw new Error(`${location}.completed[${setIndex}] is invalid`);
    }
    if (set.cards.length !== 13 || !isCompleteRun(set.cards) || set.cards[0].suit !== set.suit) {
      throw new Error(`${location}.completed[${setIndex}] is not a complete K-A run`);
    }
    set.cards.forEach((card, cardIndex) => assertCard(card, `${location}.completed[${setIndex}].cards[${cardIndex}]`, ids, expectedCards));
  });
  if (ids.size !== 104) throw new Error(`${location} must contain exactly 104 unique cards`);
  if (expectedIds && (ids.size !== expectedIds.size || [...ids].some((id) => !expectedIds.has(id)))) {
    throw new Error(`${location} card identity set differs from current state`);
  }
  return ids;
}

export function assertState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("state must be an object");
  if (state.schemaVersion !== 1) throw new Error("unsupported state schemaVersion");
  if (state.ruleVersion !== RULE_VERSION) throw new Error("unsupported ruleVersion");
  if (state.generatorVersion !== GENERATOR_VERSION) throw new Error("unsupported generatorVersion");
  if (canonicalizeSeed(state.canonicalSeed) !== state.canonicalSeed) throw new Error("canonicalSeed is not canonical");
  if (normalizeSuitMode(state.suitMode) !== state.suitMode) throw new Error("suitMode is not normalized");
  if (state.dealId !== computeDealIdSync(state.canonicalSeed, state.suitMode, state.ruleVersion, state.generatorVersion)) {
    throw new Error("dealId does not match the state identity");
  }
  if (state.initialDealHash !== computeInitialDealHashSync(state)) {
    throw new Error("initialDealHash does not match the initial snapshot");
  }
  if (!Number.isSafeInteger(state.undoCount) || state.undoCount < 0) throw new Error("undoCount is invalid");
  if (!Array.isArray(state.history)) throw new TypeError("history is invalid");
  if (state.lastEvent !== null && (!state.lastEvent || typeof state.lastEvent !== "object" || Array.isArray(state.lastEvent))) {
    throw new TypeError("lastEvent is invalid");
  }

  const currentIds = assertSnapshot(state, "state", state.suitMode);
  const initialIds = assertSnapshot(state.initialSnapshot, "initialSnapshot", state.suitMode, currentIds);
  const initialColumnLengths = state.initialSnapshot.tableau.map((column) => column.length);
  if (initialColumnLengths.join(",") !== "6,6,6,6,5,5,5,5,5,5"
      || state.initialSnapshot.stock.length !== 5
      || state.initialSnapshot.completed.length !== 0
      || state.initialSnapshot.moveCount !== 0) {
    throw new Error("initialSnapshot does not describe the frozen V1 initial layout");
  }
  for (const column of state.initialSnapshot.tableau) {
    if (column.some((card, index) => card.faceUp !== (index === column.length - 1))) {
      throw new Error("initialSnapshot tableau face-up mask is invalid");
    }
  }
  for (let index = 0; index < state.history.length; index += 1) {
    const entry = state.history[index];
    if (!entry || typeof entry !== "object" || !entry.event || typeof entry.event !== "object") {
      throw new TypeError(`history[${index}] is invalid`);
    }
    assertSnapshot(entry.snapshot, `history[${index}].snapshot`, state.suitMode, initialIds);
  }
  return true;
}

export { generateDeal };
