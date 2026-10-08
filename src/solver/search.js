import { applyMove, getLegalMoves, isWin, serializeState } from "../core/engine.js";
import { DEFAULT_SOLVER_OPTIONS, SOLVER_VERSION } from "./constants.js";
import { stableStringify } from "./canonical.js";

function stateKey(state) {
  const plain = serializeState(state);
  return stableStringify({
    tableau: plain.tableau.map((column) => column.map((card) => [card.id, card.faceUp])),
    stock: plain.stock.map((round) => round.map((card) => card.id)),
    completed: plain.completed.map((set) => set.suit ?? set),
  });
}

function faceDownCount(state) {
  return state.tableau.reduce((sum, column) => sum + column.filter((card) => !card.faceUp).length, 0);
}

function sameSuitTailLength(column) {
  if (!column.length || !column.at(-1).faceUp) return 0;
  let length = 1;
  for (let index = column.length - 1; index > 0; index -= 1) {
    const upper = column[index];
    const lower = column[index - 1];
    if (!lower.faceUp || lower.suit !== upper.suit || lower.rank !== upper.rank + 1) break;
    length += 1;
  }
  return length;
}

function progressScore(state) {
  const completed = state.completed?.length ?? 0;
  const hidden = faceDownCount(state);
  const empty = state.tableau.filter((column) => column.length === 0).length;
  const suited = state.tableau.reduce((sum, column) => sum + sameSuitTailLength(column), 0);
  const stockCards = state.stock.reduce((sum, round) => sum + round.length, 0);
  return completed * 1_000 - hidden * 30 + empty * 20 + suited * 3 - stockCards;
}

function movePriority(state, move) {
  if (move.type === "deal") return -10_000 + (state.stock?.length ?? 0);
  const source = state.tableau[move.from];
  const destination = state.tableau[move.to];
  const segment = source.slice(-move.count);
  const first = segment[0];
  let score = move.count * 6;
  if (source.length === move.count || !source[source.length - move.count - 1]?.faceUp) score += 80;
  if (destination.length === 0) score += source.length === move.count ? -25 : 10;
  else if (destination.at(-1).suit === first.suit) score += 50;
  else score -= 12;
  if (first.rank === 13 && destination.length === 0) score += 20;
  return score;
}

function orderedMoves(state) {
  return getLegalMoves(state)
    .map((move) => ({ move, priority: movePriority(state, move) }))
    .sort((a, b) => b.priority - a.priority)
    .map(({ move }) => move);
}

/**
 * Deterministic, bounded depth-first search. A non-SOLVED result is never a
 * proof of unsolvability; callers must preserve the stop reason.
 */
export function solve(initialState, options = {}) {
  const config = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  if (!Number.isSafeInteger(config.nodeBudget) || config.nodeBudget < 1) throw new RangeError("nodeBudget must be a positive safe integer");
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1) throw new RangeError("timeoutMs must be positive");

  const startedAt = performance.now();
  const deadline = startedAt + config.timeoutMs;
  const bestDepthByState = new Map();
  const path = [];
  const metrics = {
    nodesExpanded: 0,
    backtracks: 0,
    maxDepth: 0,
    transpositionHits: 0,
    initialLegalMoves: getLegalMoves(initialState).length,
    peakTranspositionEntries: 0,
  };
  let stopReason = "EXHAUSTED";

  function visit(state, depth) {
    if (isWin(state)) return true;
    if (metrics.nodesExpanded >= config.nodeBudget) {
      stopReason = "NODE_BUDGET";
      return false;
    }
    if (performance.now() >= deadline) {
      stopReason = "TIMEOUT";
      return false;
    }
    metrics.nodesExpanded += 1;
    metrics.maxDepth = Math.max(metrics.maxDepth, depth);

    const key = stateKey(state);
    const priorDepth = bestDepthByState.get(key);
    if (priorDepth !== undefined && priorDepth <= depth) {
      metrics.transpositionHits += 1;
      return false;
    }
    if (bestDepthByState.size >= config.transpositionLimit) {
      stopReason = "TRANSPOSITION_LIMIT";
      return false;
    }
    bestDepthByState.set(key, depth);
    metrics.peakTranspositionEntries = Math.max(metrics.peakTranspositionEntries, bestDepthByState.size);

    const candidates = orderedMoves(state).map((move) => {
      const next = applyMove(state, move);
      // Search never uses undo. Dropping accumulated snapshots prevents the
      // engine's user-facing history from growing quadratically with depth.
      next.history = [];
      next.lastEvent = null;
      return { move, next, progress: progressScore(next) };
    }).sort((a, b) => b.progress - a.progress);

    for (const candidate of candidates) {
      path.push(candidate.move);
      if (visit(candidate.next, depth + 1)) return true;
      path.pop();
      metrics.backtracks += 1;
      if (stopReason !== "EXHAUSTED") return false;
    }
    return false;
  }

  const solved = visit(initialState, 0);
  const elapsedMs = performance.now() - startedAt;
  return {
    status: solved ? "SOLVED" : stopReason === "EXHAUSTED" ? "UNSOLVED" : "RESOURCE_LIMIT",
    stopReason: solved ? "SOLVED" : stopReason,
    solverVersion: SOLVER_VERSION,
    moves: solved ? path.map((move) => ({ ...move })) : [],
    solutionLength: solved ? path.length : null,
    elapsedMs,
    metrics,
  };
}
