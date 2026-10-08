export const TIMER_STATUS = Object.freeze({
  WAITING: "WAITING",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  FINISHED: "FINISHED",
});

export const SCORE_REWARDS = Object.freeze({
  "1s": Object.freeze({ easy: 100, medium: 150, hard: 200, demon: 300 }),
  "2s": Object.freeze({ easy: 200, medium: 300, hard: 400, demon: 600 }),
  "4s": Object.freeze({ easy: 400, medium: 600, hard: 800, demon: 1200 }),
});

function validNow(now) {
  if (!Number.isFinite(now) || now < 0) throw new RangeError("timer time must be a non-negative finite number");
  return now;
}

export function createTimerState({ status = TIMER_STATUS.WAITING, elapsedMs = 0, startedAt = null } = {}) {
  if (!Object.values(TIMER_STATUS).includes(status)) throw new RangeError("unknown timer status");
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("elapsedMs must be non-negative");
  if (status === TIMER_STATUS.RUNNING && (!Number.isFinite(startedAt) || startedAt < 0)) {
    throw new RangeError("a running timer requires startedAt");
  }
  if (status !== TIMER_STATUS.RUNNING) startedAt = null;
  return Object.freeze({ status, elapsedMs, startedAt });
}

export function timerElapsedMs(timer, now = 0) {
  const state = createTimerState(timer);
  if (state.status !== TIMER_STATUS.RUNNING) return state.elapsedMs;
  return state.elapsedMs + Math.max(0, validNow(now) - state.startedAt);
}

/** Pure Timer transition function. Only SUCCESS starts a waiting timer. */
export function transitionTimer(timer, event, now = 0) {
  const state = createTimerState(timer);
  const type = typeof event === "string" ? event : event?.type;
  validNow(now);
  switch (type) {
    case "SUCCESS":
      if (state.status === TIMER_STATUS.WAITING || state.status === TIMER_STATUS.PAUSED) {
        return createTimerState({ status: TIMER_STATUS.RUNNING, elapsedMs: state.elapsedMs, startedAt: now });
      }
      return state;
    case "PAUSE":
      if (state.status !== TIMER_STATUS.RUNNING) return state;
      return createTimerState({ status: TIMER_STATUS.PAUSED, elapsedMs: timerElapsedMs(state, now) });
    case "RESUME":
      if (state.status !== TIMER_STATUS.PAUSED) return state;
      return createTimerState({ status: TIMER_STATUS.RUNNING, elapsedMs: state.elapsedMs, startedAt: now });
    case "FINISH":
      if (state.status === TIMER_STATUS.FINISHED) return state;
      return createTimerState({ status: TIMER_STATUS.FINISHED, elapsedMs: timerElapsedMs(state, now) });
    case "RESET":
      return createTimerState();
    default:
      throw new TypeError(`unknown timer event: ${String(type)}`);
  }
}

export function calculateScore({ suitMode, difficulty, completedSets, scoringMoves }) {
  const suit = typeof suitMode === "number" ? `${suitMode}s` : suitMode;
  const reward = SCORE_REWARDS[suit]?.[difficulty];
  if (reward === undefined) throw new RangeError("unknown score bucket");
  if (!Number.isSafeInteger(completedSets) || completedSets < 0 || completedSets > 8) {
    throw new RangeError("completedSets must be an integer from 0 to 8");
  }
  if (!Number.isSafeInteger(scoringMoves) || scoringMoves < 0) {
    throw new RangeError("scoringMoves must be a non-negative integer");
  }
  return completedSets * reward - scoringMoves;
}

export function createScoreState({ completedSets = 0, scoringMoves = 0 } = {}) {
  calculateScore({ suitMode: "1s", difficulty: "easy", completedSets, scoringMoves });
  return Object.freeze({ completedSets, scoringMoves });
}

/** MOVE, DEAL, UNDO and future REDO each count once; automatic effects do not. */
export function transitionScore(score, event) {
  const state = createScoreState(score);
  const type = typeof event === "string" ? event : event?.type;
  if (["MOVE", "DEAL", "UNDO", "REDO"].includes(type)) {
    return createScoreState({ ...state, scoringMoves: state.scoringMoves + 1 });
  }
  if (type === "COMPLETE") {
    const count = event?.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("completion count must be positive");
    return createScoreState({ ...state, completedSets: state.completedSets + count });
  }
  if (["HINT", "SELECT", "AUTO_FLIP"].includes(type)) return state;
  if (type === "RESET") return createScoreState();
  throw new TypeError(`unknown score event: ${String(type)}`);
}

export function shouldAnimate(preferences = {}, matchMedia = (query) => globalThis.matchMedia?.(query) ?? { matches: false }) {
  if (preferences.animation === false || preferences.reduceMotion === true) return false;
  return !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}
