import { RuntimeDataError } from "./errors.js";

export function createEmptyStats(profileId, bucketId) {
  return {
    schemaVersion: 1,
    profileId,
    dealId: `stats:${bucketId}`,
    bucketId,
    gamesStarted: 0,
    gamesWon: 0,
    totalScore: 0,
    highestScore: null,
    totalElapsedMs: 0,
    fastestTimeMs: null,
    minimumMoves: null,
    undoCount: 0,
    hintCount: 0,
    updatedAt: 0,
  };
}

function count(value, label) {
  const number = value ?? 0;
  if (!Number.isSafeInteger(number) || number < 0) throw new RuntimeDataError("INVALID_STAT_EVENT", `${label} must be a non-negative integer`);
  return number;
}

export function recordGameStarted(stats, now = Date.now()) {
  return { ...stats, gamesStarted: stats.gamesStarted + 1, updatedAt: now };
}

export function recordGameFinished(stats, result, now = Date.now()) {
  const score = count(result.score, "score");
  const elapsedMs = count(result.elapsedMs, "elapsedMs");
  const moves = count(result.moves, "moves");
  const undoCount = count(result.undoCount, "undoCount");
  const hintCount = count(result.hintCount, "hintCount");
  const won = result.won === true;
  return {
    ...stats,
    gamesWon: stats.gamesWon + (won ? 1 : 0),
    totalScore: stats.totalScore + score,
    highestScore: stats.highestScore == null ? score : Math.max(stats.highestScore, score),
    totalElapsedMs: stats.totalElapsedMs + elapsedMs,
    fastestTimeMs: won ? (stats.fastestTimeMs == null ? elapsedMs : Math.min(stats.fastestTimeMs, elapsedMs)) : stats.fastestTimeMs,
    minimumMoves: won ? (stats.minimumMoves == null ? moves : Math.min(stats.minimumMoves, moves)) : stats.minimumMoves,
    undoCount: stats.undoCount + undoCount,
    hintCount: stats.hintCount + hintCount,
    updatedAt: now,
  };
}

export function statsView(stats, completedSeedCount = 0, remainingSeedCount = null) {
  return {
    ...stats,
    winRate: stats.gamesStarted === 0 ? 0 : stats.gamesWon / stats.gamesStarted,
    averageScore: stats.gamesWon === 0 ? 0 : stats.totalScore / stats.gamesWon,
    averageTimeMs: stats.gamesWon === 0 ? 0 : stats.totalElapsedMs / stats.gamesWon,
    completedSeedCount,
    remainingSeedCount,
  };
}

