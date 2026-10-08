import { CLASSIFIER_VERSION } from "./constants.js";

export const DEFAULT_THRESHOLDS = Object.freeze({
  easy: [0, 25],
  medium: [25, 55],
  hard: [55, 80],
  demon: [80, 101],
});


function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function countInitialSafeMoves(state) {
  let count = 0;
  for (let from = 0; from < 10; from += 1) {
    const source = state.tableau[from];
    if (!source.length || !source.at(-1).faceUp) continue;
    for (let to = 0; to < 10; to += 1) {
      if (from === to) continue;
      const target = state.tableau[to].at(-1);
      if (!target || (target.rank === source.at(-1).rank + 1 && target.suit === source.at(-1).suit)) count += 1;
    }
  }
  return count;
}

export function collectDifficultyMetrics(initialState, solveResult) {
  const visibleAdjacent = { total: 0, suited: 0, crossSuit: 0 };
  let hiddenCardDepth = 0;
  let emptyColumnDepth = Infinity;
  for (const column of initialState.tableau) {
    const hidden = column.filter((card) => !card.faceUp).length;
    hiddenCardDepth = Math.max(hiddenCardDepth, hidden);
    emptyColumnDepth = Math.min(emptyColumnDepth, column.length);
    for (let index = 1; index < column.length; index += 1) {
      const below = column[index - 1];
      const above = column[index];
      if (!below.faceUp || !above.faceUp || below.rank !== above.rank + 1) continue;
      visibleAdjacent.total += 1;
      if (below.suit === above.suit) visibleAdjacent.suited += 1;
      else visibleAdjacent.crossSuit += 1;
    }
  }
  const solutionLength = solveResult.solutionLength ?? 0;
  const nodes = solveResult.metrics?.nodesExpanded ?? 0;
  const backtracks = solveResult.metrics?.backtracks ?? 0;
  const maxDepth = solveResult.metrics?.maxDepth ?? solutionLength;
  return {
    solutionLength,
    initialLegalMoves: solveResult.metrics?.initialLegalMoves ?? 0,
    initialSafeMoves: countInitialSafeMoves(initialState),
    hiddenCardDepth,
    sameSuitConnectivity: visibleAdjacent.total ? visibleAdjacent.suited / visibleAdjacent.total : 0,
    crossSuitFragmentation: visibleAdjacent.total ? visibleAdjacent.crossSuit / visibleAdjacent.total : 0,
    emptyColumnDepth: Number.isFinite(emptyColumnDepth) ? emptyColumnDepth : 0,
    temporaryBreakCount: 0,
    branchingFactor: maxDepth > 0 ? nodes / maxDepth : nodes,
    solverBacktracks: backtracks,
    solverNodes: nodes,
    criticalMoveCount: Math.max(0, hiddenCardDepth - countInitialSafeMoves(initialState)),
    recoveryOptions: countInitialSafeMoves(initialState),
  };
}

export function scoreDifficulty(metrics, suitMode) {
  const normalizedSuitMode = typeof suitMode === "string" ? Number.parseInt(suitMode, 10) : suitMode;
  const suitWeight = normalizedSuitMode === 4 ? 14 : normalizedSuitMode === 2 ? 7 : 0;
  const score =
    suitWeight +
    Math.min(22, metrics.solutionLength / 8) +
    Math.min(18, Math.log2(metrics.solverNodes + 1) * 2) +
    Math.min(12, Math.log2(metrics.solverBacktracks + 1) * 1.8) +
    metrics.hiddenCardDepth * 2.2 +
    metrics.crossSuitFragmentation * 12 +
    Math.min(8, metrics.branchingFactor / 2) -
    Math.min(10, metrics.initialSafeMoves * 1.2) -
    metrics.sameSuitConnectivity * 8;
  return Math.round(clamp(score, 0, 100) * 100) / 100;
}

export function classifyScore(score, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError("difficulty score must be between 0 and 100");
  for (const [name, [minimum, maximum]] of Object.entries(thresholds)) {
    if (score >= minimum && score < maximum) return name;
  }
  throw new RangeError("thresholds do not cover the score");
}

export function analyzeDifficulty(initialState, solveResult, options = {}) {
  if (solveResult.status !== "SOLVED") throw new Error("only solved deals can be classified");
  const metrics = collectDifficultyMetrics(initialState, solveResult);
  const difficultyScore = scoreDifficulty(metrics, initialState.suitMode);
  return {
    classifierVersion: CLASSIFIER_VERSION,
    calibrationDatasetHash: options.calibrationDatasetHash ?? null,
    classificationStatus: options.classificationStatus ?? "provisional",
    suitMode: initialState.suitMode,
    difficultyScore,
    classifiedDifficulty: classifyScore(difficultyScore, options.thresholds),
    metrics,
  };
}
