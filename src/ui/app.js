import {
  applyMove,
  dealStock,
  deserializeState,
  getLegalMoves,
  isWin,
  restart,
  serializeState,
  undo,
} from "../core/engine.js";
import { computeDealId, generateDeal } from "../core/generator.js";
import { LocalSoundFeedback, showVictoryCelebration } from "./audio.js";
import { calculateScore, timerElapsedMs, transitionTimer } from "./game-session.js";

const SUIT_SYMBOL = Object.freeze({ spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" });
const RANK_LABEL = Object.freeze({ 1: "A", 11: "J", 12: "Q", 13: "K" });
export const PIP_LAYOUT = Object.freeze({
  1: ["c"], 2: ["t", "b"], 3: ["t", "c", "b"],
  4: ["tl", "tr", "bl", "br"], 5: ["tl", "tr", "c", "bl", "br"],
  6: ["tl", "tr", "ml", "mr", "bl", "br"],
  7: ["tl", "tr", "mtl", "mtr", "c", "bl", "br"],
  8: ["tl", "tr", "mtl", "mtr", "mbl", "mbr", "bl", "br"],
  9: ["tl", "tr", "mtl", "c", "mtr", "mbl", "bl", "br", "mbr"],
  10: ["tl", "tr", "mtl", "mtr", "ml", "mr", "mbl", "mbr", "bl", "br"],
});
const SUIT_LABEL = Object.freeze({ "1s": "单花色", "2s": "双花色", "4s": "四花色" });
const DIFFICULTY_LABEL = Object.freeze({ easy: "简单", medium: "中等", hard: "困难", demon: "恶魔" });
const DEFAULT_PREFERENCES = Object.freeze({ theme: "dark", reduceMotion: false, animation: true, sound: false });
const EMPTY_STATS = Object.freeze({ gamesStarted: 0, gamesWon: 0, totalScore: 0, bestScore: null, fastestMs: null, minimumMoves: null, undoCount: 0, hintCount: 0, recentGames: [] });

function byId(root, id) {
  const node = root.getElementById(id);
  if (!node) throw new Error(`Missing UI element #${id}`);
  return node;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatSeed(seed) {
  if (!seed) return "等待选择";
  const suffix = seed.replace(/^u64:/, "");
  return `…${suffix.slice(-8)}`;
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 500);
}

function safeText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function firstLegalDestinationForSelection(game, selection) {
  if (!game || !selection) return null;
  const source = game.tableau[selection.from];
  const movingBottom = source?.at(-selection.count);
  if (!movingBottom) return null;
  return getLegalMoves(game)
    .filter((move) => move.type === "move" && move.from === selection.from && move.count === selection.count)
    .sort((a, b) => {
      return legalDestinationPriority(game, movingBottom, a) - legalDestinationPriority(game, movingBottom, b)
        || a.to - b.to || a.count - b.count;
    })
    .at(0) ?? null;
}

export function legalDestinationPriority(game, movingBottom, move) {
  const destinationTop = game.tableau[move.to].at(-1);
  if (!destinationTop) return 1;
  return destinationTop.suit === movingBottom.suit ? 0 : 2;
}

function movableTailStart(column) {
  if (!column.length || !column.at(-1).faceUp) return column.length - 1;
  let count = 1;
  for (let index = column.length - 1; index > 0; index -= 1) {
    const upper = column[index];
    const lower = column[index - 1];
    if (!lower.faceUp || lower.suit !== upper.suit || lower.rank !== upper.rank + 1) break;
    count += 1;
  }
  return column.length - count;
}

export function computeCardStackOffsets(column, cardIndex, viewportHeight = 900, viewportWidth = 1280) {
  const faceUpBefore = column.slice(0, cardIndex).filter((item) => item.faceUp).length;
  const faceDownBefore = cardIndex - faceUpBefore;
  const faceDownCount = column.filter((item) => !item.faceUp).length;
  const faceUpCount = column.length - faceDownCount;
  const cardHeight = Math.min(112, Math.max(62, viewportWidth * 0.081)) * 1.38;
  const availableHeight = Math.max(180, viewportHeight - 285);
  const normalDownGap = 8;
  const normalUpGap = 23;
  const normalHeight = cardHeight + Math.max(0, faceDownCount - 1) * normalDownGap + Math.max(0, faceUpCount - 1) * normalUpGap;
  const needsCompression = normalHeight > availableHeight;
  const compactDownGap = needsCompression
    ? Math.max(3, Math.min(normalDownGap, Math.floor((availableHeight - cardHeight) / Math.max(column.length - 1, 1))))
    : normalDownGap;
  const compactUpGap = needsCompression
    ? Math.max(3, Math.min(normalUpGap, Math.floor((availableHeight - cardHeight - Math.max(0, faceDownCount - 1) * compactDownGap) / Math.max(faceUpCount - 1, 1))))
    : normalUpGap;
  const compactY = faceDownBefore * compactDownGap + faceUpBefore * compactUpGap;
  const tailStart = movableTailStart(column);
  const tailStartFaceUpBefore = column.slice(0, tailStart).filter((item) => item.faceUp).length;
  const tailStartFaceDownBefore = tailStart - tailStartFaceUpBefore;
  const expandedY = cardIndex >= tailStart
    ? tailStartFaceDownBefore * compactDownGap + tailStartFaceUpBefore * compactUpGap + (cardIndex - tailStart) * normalUpGap
    : compactY;
  return { compactY, expandedY, needsCompression, compactDownGap, compactUpGap, tailStart };
}

function normalizeSuitValue(value) {
  return `${Number.parseInt(value, 10)}s`;
}

function resolveRuntimeRecord(result, fallback = null) {
  if (result == null) return fallback;
  return result.value ?? result.record ?? result.profile ?? result;
}

function readCalibrationRequest() {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const dealId = params.get("calibrationDealId")?.trim();
  if (!/^[0-9a-f]{64}$/.test(dealId ?? "")) return null;
  const requestedBlindId = params.get("blindId")?.trim() ?? "BLIND";
  const blindId = /^[A-Za-z0-9_-]{1,16}$/.test(requestedBlindId) ? requestedBlindId : "BLIND";
  return Object.freeze({ dealId, blindId });
}

/**
 * Browser presentation/controller. All rule decisions are delegated to core;
 * certified selection and persistence are delegated to runtime when available.
 */
export class SpiderApp {
  constructor(root = document) {
    this.root = root;
    this.el = {};
    this.runtime = null;
    this.repository = null;
    this.library = null;
    this.manifest = null;
    this.profile = { profileId: "guest", name: "访客" };
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.stats = { ...EMPTY_STATS };
    this.completedDealIds = new Set();
    this.game = null;
    this.deal = null;
    this.difficulty = "easy";
    this.suit = "1s";
    this.selected = null;
    this.hintMove = null;
    this.hintStock = false;
    this.hintStock = false;
    this.elapsedBeforeRun = 0;
    this.startedAt = null;
    this.timerState = "WAITING";
    this.timerHandle = null;
    this.pendingConfirmation = null;
    this.lastMove = null;
    this.motion = null;
    this.invalidColumns = new Set();
    this.storageCapability = { persistent: false, mode: "memory" };
    this.calibration = readCalibrationRequest();
    this.audio = new LocalSoundFeedback();
  }

  async start() {
    this.cacheElements();
    if (this.calibration) document.documentElement.classList.add("calibration-mode");
    this.renderCompleted();
    this.bindEvents();
    this.applyPreferences();
    this.startTicker();
    document.addEventListener("visibilitychange", () => this.handleVisibility());

    try {
      this.runtime = await import("../runtime/index.js");
      await this.initializePersistence();
      await this.initializeSeedLibrary();
      await this.restoreOrStart();
    } catch (error) {
      this.showMessage(`认证牌库暂不可用：${safeText(error)}`, "error");
      this.setBucketControls(false);
      this.toast("未载入通过校验的认证牌局，已禁止开始随机牌局。", "error", 8000);
      console.error(error);
    } finally {
      byId(this.root, "app").setAttribute("aria-busy", "false");
      this.render();
    }
  }

  cacheElements() {
    for (const id of [
      "suit-select", "difficulty-select", "timer", "moves", "score", "profile-button", "profile-name",
      "menu-button", "storage-banner", "storage-message", "difficulty-badge", "seed-button", "seed-display",
      "game-message", "completed-area", "tableau", "stock", "stock-status", "toast-region", "confirm-dialog",
      "confirm-message", "confirm-accept", "panel-dialog", "panel-title", "panel-content", "resume-dialog", "import-input",
    ]) this.el[id] = byId(this.root, id);
  }

  bindEvents() {
    this.root.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => this.action(button.dataset.action)));
    this.root.querySelector("[data-dismiss-banner]")?.addEventListener("click", () => { this.el["storage-banner"].hidden = true; });
    this.el["suit-select"].addEventListener("change", () => this.changeBucket());
    this.el["difficulty-select"].addEventListener("change", () => this.changeBucket());
    this.el.stock.addEventListener("click", () => this.performDeal());
    this.el.tableau.addEventListener("click", (event) => this.onBoardClick(event));
    this.el.tableau.addEventListener("dblclick", (event) => this.onBoardDoubleClick(event));
    this.el.tableau.addEventListener("dragstart", (event) => this.onDragStart(event));
    this.el.tableau.addEventListener("dragover", (event) => this.onDragOver(event));
    this.el.tableau.addEventListener("dragleave", (event) => event.target.closest(".column")?.classList.remove("is-target"));
    this.el.tableau.addEventListener("drop", (event) => this.onDrop(event));
    this.el["seed-button"].addEventListener("click", () => this.copyDealIdentity());
    this.el["profile-button"].addEventListener("click", () => this.openProfiles());
    this.el["menu-button"].addEventListener("click", () => this.openSettings());
    this.el["import-input"].addEventListener("change", (event) => this.importFile(event));
    this.el["confirm-dialog"].addEventListener("close", () => this.resolveConfirmation());
    this.el["resume-dialog"].addEventListener("close", () => this.resolveResume());
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  async initializePersistence() {
    if (!this.runtime?.openRuntimeStorage) return;
    const opened = await this.runtime.openRuntimeStorage();
    this.repository = this.runtime.RuntimeRepository ? new this.runtime.RuntimeRepository(opened.storage) : null;
    this.storageCapability = opened.capability ?? { persistent: false, mode: "memory" };
    await this.repository?.initialize();
    if (!this.storageCapability.persistent) {
      this.el["storage-banner"].hidden = false;
      this.el["storage-message"].textContent = "无法确认持久存储，当前使用临时模式。请定期导出 JSON 备份。";
    }
    await this.loadProfileState();
  }

  async initializeSeedLibrary() {
    if (!this.runtime?.SeedLibrary) throw new Error("SeedLibrary 接口缺失");
    const embedded = globalThis.__SPIDER_SEED_ARTIFACTS__;
    let manifest = embedded?.manifest;
    let payload = embedded?.payload;
    if (!manifest || !payload) {
      const manifestScript = this.root.getElementById("spider-resolved-manifest");
      const payloadScript = this.root.getElementById("spider-certified-seeds");
      if (manifestScript?.textContent && payloadScript?.textContent) {
        manifest = JSON.parse(manifestScript.textContent);
        payload = JSON.parse(payloadScript.textContent);
      } else {
        const [manifestResponse, payloadResponse] = await Promise.all([
          fetch("./data/resolved-seed-manifest.json"),
          fetch("./data/certified-seeds.json"),
        ]);
        if (!manifestResponse.ok || !payloadResponse.ok) throw new Error("无法读取认证 Seed Manifest/Payload");
        [manifest, payload] = await Promise.all([manifestResponse.json(), payloadResponse.json()]);
      }
    }
    this.library = await this.runtime.SeedLibrary.fromArtifacts(manifest, payload, {
      runtimeVersion: "0.1.0",
      ruleVersion: "1.0",
      generatorVersion: "1",
    });
    this.manifest = this.library.manifest;
    this.applyBucketAvailability();
  }

  async loadProfileState() {
    if (!this.repository) return;
    try {
      const current = await this.callRepository(["getCurrentProfile", "currentProfile"], [], null);
      if (current) this.profile = resolveRuntimeRecord(current, this.profile);
      const preferences = await this.callRepository(["getPreferences", "loadPreferences"], [this.profile.profileId], null);
      if (preferences) this.preferences = { ...DEFAULT_PREFERENCES, ...resolveRuntimeRecord(preferences, {}) };
      const completed = await this.callRepository(["listCompleted", "getCompletedDealIds"], [this.profile.profileId], []);
      this.completedDealIds = new Set((resolveRuntimeRecord(completed, []) ?? []).map((item) => typeof item === "string" ? item : item.dealId));
      const stats = await this.callRepository(["getStats"], [this.profile.profileId, this.suit, this.difficulty], null);
      if (stats) {
        const value = resolveRuntimeRecord(stats, {});
        this.stats = { ...EMPTY_STATS, ...value, bestScore: value.highestScore, fastestMs: value.fastestTimeMs };
      }
      this.applyPreferences();
      this.renderProfile();
    } catch (error) {
      this.showStorageFallback(error);
    }
  }

  async restoreOrStart() {
    if (this.calibration) return this.startCalibrationDeal();
    const saved = await this.callRepository(["getLatestSave", "getCurrentGame", "loadCurrentGame", "loadSave"], [this.profile.profileId], null);
    if (saved) {
      this.pendingSave = resolveRuntimeRecord(saved);
      this.el["resume-dialog"].showModal();
      return;
    }
    await this.newGame({ confirm: false });
  }

  async startCalibrationDeal() {
    const deal = this.library?.getDeal(this.calibration.dealId);
    if (!deal) throw new Error(`盲测牌局 ${this.calibration.blindId} 不在当前认证库中`);
    this.suit = `${deal.suitMode}s`;
    this.difficulty = deal.difficulty;
    this.game = generateDeal(deal.canonicalSeed, deal.suitMode);
    this.deal = deal;
    this.selected = null;
    this.hintMove = null;
    this.elapsedBeforeRun = 0;
    this.startedAt = null;
    this.timerState = "WAITING";
    this.syncSelectors();
    this.el["suit-select"].disabled = true;
    this.el["difficulty-select"].disabled = true;
    this.setActionEnabled("new", false);
    this.showMessage(`盲测牌局 ${this.calibration.blindId}。请独立完成并填写评测表。`, "normal");
    this.render();
  }

  async resolveResume() {
    if (!this.pendingSave) return;
    const save = this.pendingSave;
    this.pendingSave = null;
    if (this.el["resume-dialog"].returnValue === "resume") {
      try {
        this.game = deserializeState(save.gameState ?? save.state ?? save.board);
        this.deal = { dealId: save.dealId, canonicalSeed: save.canonicalSeed, suitMode: save.suitMode, difficulty: save.difficulty };
        this.suit = normalizeSuitValue(save.suitMode ?? this.game.suitMode);
        this.difficulty = save.difficulty ?? "easy";
        this.elapsedBeforeRun = save.elapsedMs ?? 0;
        this.timerState = save.timerState === "FINISHED" ? "FINISHED" : "PAUSED";
        this.syncSelectors();
        this.showMessage("已恢复上次牌局。", "success");
        this.render();
      } catch (error) {
        this.toast(`存档无法恢复：${safeText(error)}`, "error");
        await this.newGame({ confirm: false });
      }
    } else await this.newGame({ confirm: false });
  }

  async callRepository(names, args, fallback) {
    if (!this.repository) return fallback;
    const name = names.find((candidate) => typeof this.repository[candidate] === "function");
    return name ? this.repository[name](...args) : fallback;
  }

  applyBucketAvailability() {
    if (!this.library) return;
    for (const option of this.el["suit-select"].options) {
      option.disabled = !["easy", "medium", "hard", "demon"].some((difficulty) => this.bucketStatus(`${option.value}.${difficulty}`).status !== "disabled");
    }
    this.refreshDifficultyOptions();
  }

  refreshDifficultyOptions() {
    for (const option of this.el["difficulty-select"].options) {
      const status = this.bucketStatus(`${this.el["suit-select"].value}.${option.value}`);
      option.disabled = status.status === "disabled";
      option.textContent = `${DIFFICULTY_LABEL[option.value]}${status.status === "empty" ? "（暂无牌局）" : ""}`;
    }
  }

  bucketStatus(bucketId = `${this.suit}.${this.difficulty}`) {
    return this.library?.getBucketStatus(bucketId, this.completedDealIds) ?? { bucketId, status: "disabled", total: 0, remaining: 0 };
  }

  setBucketControls(enabled) {
    this.el["suit-select"].disabled = !enabled;
    this.el["difficulty-select"].disabled = !enabled;
    this.setActionEnabled("new", enabled);
  }

  async changeBucket() {
    const nextSuit = this.el["suit-select"].value;
    const nextDifficulty = this.el["difficulty-select"].value;
    if (nextSuit === this.suit && nextDifficulty === this.difficulty) return;
    const accepted = !this.game || await this.confirm("切换牌局类型？", "当前未完成进度会保留为存档，但牌桌将切换到新牌局。", "切换");
    if (!accepted) { this.syncSelectors(); return; }
    this.suit = nextSuit;
    this.difficulty = nextDifficulty;
    this.refreshDifficultyOptions();
    await this.newGame({ confirm: false });
  }

  async newGame({ confirm = true, replayCompleted = false } = {}) {
    if (!this.library) return this.toast("认证牌库尚未就绪。", "error");
    if (confirm && this.game && this.timerState !== "FINISHED") {
      if (!await this.confirm("开始新一局？", "当前牌局的进度将保留在本机记录中。", "开始新局")) return;
    }
    const status = this.bucketStatus();
    if (status.status === "disabled") return this.showMessage("当前版本未提供这个花色与难度。", "error");
    if (status.status === "empty") return this.showMessage("当前认证牌池为空，请选择其他难度。", "error");
    if (status.status === "exhausted" && !replayCompleted) return this.openExhausted();
    try {
      const deal = this.library.select(`${this.suit}.${this.difficulty}`, { completedDealIds: this.completedDealIds, replayCompleted });
      const mode = Number.parseInt(deal.suitMode, 10);
      this.game = generateDeal(deal.canonicalSeed, mode);
      this.deal = deal;
      this.selected = null;
      this.hintMove = null;
      this.hintStock = false;
      this.elapsedBeforeRun = 0;
      this.startedAt = null;
      this.timerState = "WAITING";
      this.stats.gamesStarted += 1;
      await this.callRepository(["gameStarted"], [this.profile.profileId, this.suit, this.difficulty], null);
      this.showMessage("", "normal");
      await this.persistGame();
      await this.persistStats();
      this.render();
    } catch (error) {
      const copy = { BUCKET_DISABLED: "当前版本未提供这个分类。", BUCKET_EMPTY: "当前认证牌池为空。", BUCKET_EXHAUSTED: "你已完成当前分类的全部认证牌局。" };
      this.showMessage(copy[error.code] ?? `无法开始牌局：${safeText(error)}`, "error");
    }
  }

  openExhausted() {
    this.openPanel("已完成当前牌池", `
      <div class="empty-state"><p>你已经完成当前模式的全部认证牌局。</p></div>
      <div class="button-row"><button type="button" data-panel-action="replay">重玩已完成牌局</button><button type="button" class="secondary" data-panel-action="reset-completed">重置此分类记录</button></div>
    `);
  }

  selectCard(columnIndex, cardIndex) {
    if (!this.game) return;
    const column = this.game.tableau[columnIndex];
    const count = column.length - cardIndex;
    if (!column[cardIndex]?.faceUp) return this.toast("只能选择正面朝上的牌。", "error");
    const legal = getLegalMoves(this.game).some((move) => move.type === "move" && move.from === columnIndex && move.count === count);
    if (!legal) return this.toast("只有同花色连续降序的牌组可以整体移动。", "error");
    this.selected = { from: columnIndex, count, cardIndex };
    this.hintMove = null;
    this.hintStock = false;
    this.renderBoard();
  }

  onBoardClick(event) {
    const card = event.target.closest(".card");
    const column = event.target.closest(".column");
    if (!column || !this.game) return;
    const columnIndex = Number(column.dataset.column);
    const cardIndex = card ? Number(card.dataset.cardIndex) : null;
    if (this.selected && card && columnIndex === this.selected.from) {
      if (cardIndex >= this.selected.cardIndex) return;
      this.selectCard(columnIndex, cardIndex);
      return;
    }
    if (this.selected && (!card || Number(card.dataset.cardIndex) !== this.selected.cardIndex || columnIndex !== this.selected.from)) {
      this.tryMove({ type: "move", from: this.selected.from, to: columnIndex, count: this.selected.count });
      return;
    }
    if (card) this.selectCard(columnIndex, Number(card.dataset.cardIndex));
    else this.selected = null;
  }

  onBoardDoubleClick(event) {
    const card = event.target.closest(".card");
    if (!card || !this.game) return;
    const from = Number(card.dataset.column);
    const cardIndex = Number(card.dataset.cardIndex);
    const selectedGroup = this.selected?.from === from && cardIndex >= this.selected.cardIndex
      ? this.selected
      : { from, cardIndex, count: this.game.tableau[from].length - cardIndex };
    if (this.selected?.from !== from || cardIndex < this.selected.cardIndex) this.selectCard(from, cardIndex);
    const activeSelection = this.selected?.from === from && cardIndex >= this.selected.cardIndex ? this.selected : selectedGroup;
    const move = firstLegalDestinationForSelection(this.game, activeSelection);
    if (move) this.tryMove(move);
  }

  onDragStart(event) {
    const card = event.target.closest(".card");
    if (!card || card.classList.contains("face-down")) return event.preventDefault();
    const from = Number(card.dataset.column);
    const cardIndex = Number(card.dataset.cardIndex);
    this.selectCard(from, cardIndex);
    if (!this.selected) return event.preventDefault();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", JSON.stringify({ from, count: this.selected.count }));
  }

  onDragOver(event) {
    if (!this.selected) return;
    const column = event.target.closest(".column");
    if (!column) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    column.classList.add("is-target");
  }

  onDrop(event) {
    event.preventDefault();
    const column = event.target.closest(".column");
    this.el.tableau.querySelectorAll(".is-target").forEach((node) => node.classList.remove("is-target"));
    if (!column || !this.selected) return;
    this.tryMove({ type: "move", from: this.selected.from, to: Number(column.dataset.column), count: this.selected.count });
  }

  tryMove(move) {
    if (!this.game) return false;
    try {
      const completedBefore = this.game.completed.length;
      this.game = applyMove(this.game, move);
      this.lastMove = move;
      this.selected = null;
      this.hintMove = null;
      this.hintStock = false;
      const collecting = this.game.completed.length > completedBefore;
      this.setMotion(collecting
        ? { type: "collect", completedFrom: completedBefore, from: move.from, to: move.to }
        : { type: "move", from: move.from, to: move.to, cardIds: this.game.lastEvent?.movedCardIds ?? [] }, collecting ? 900 : 620);
      this.onSuccessfulAction();
      return true;
    } catch (error) {
      this.selected = null;
      this.invalidColumns = new Set([move.from, move.to].filter((value) => Number.isInteger(value)));
      this.renderBoard();
      window.setTimeout(() => {
        this.invalidColumns.clear();
        this.renderBoard();
      }, 220);
      return false;
    }
  }

  performDeal() {
    if (!this.game) return;
    try {
      this.game = dealStock(this.game);
      this.lastMove = { type: "deal" };
      this.selected = null;
      this.hintMove = null;
      this.hintStock = false;
      this.setMotion({ type: "deal", cardIds: this.game.lastEvent?.dealtCardIds ?? [] }, 920);
      this.onSuccessfulAction();
    } catch (error) { this.toast(safeText(error) === "stock is empty" ? "库存牌已经发完。" : "有空列时不能发牌。", "error"); }
  }

  async onSuccessfulAction() {
    if (this.timerState === "WAITING" || this.timerState === "PAUSED") this.resumeTimer();
    const won = isWin(this.game);
    const cue = won ? "win" : this.game.lastEvent?.completed?.length ? "complete" : this.game.lastEvent?.type;
    this.audio.play(cue);
    if (won) await this.completeGame();
    else await this.persistGame();
    this.render();
  }

  performUndo() {
    if (!this.game || this.game.history.length === 0) return this.toast("没有可撤销的动作。");
    this.game = undo(this.game);
    this.stats.undoCount += 1;
    this.selected = null;
    this.hintMove = null;
    this.hintStock = false;
    this.audio.play("undo");
    this.persistGame();
    this.persistStats();
    this.render();
  }

  async performRestart() {
    if (!this.game || !await this.confirm("重开当前牌局？", "将恢复到当前认证 Seed 的初始牌面，并清零时间与步数。", "重开")) return;
    this.game = restart(this.game);
    this.selected = null;
    this.elapsedBeforeRun = 0;
    this.startedAt = null;
    this.timerState = "WAITING";
    await this.persistGame();
    this.showMessage("已按同一 Seed 重开牌局。", "success");
    this.render();
  }

  performHint() {
    if (!this.game) return;
    this.hintStock = false;
    const moves = getLegalMoves(this.game).filter((move) => move.type === "move");
    if (!moves.length) {
      this.hintMove = null;
      if (this.game.stock.length) {
        this.hintStock = true;
        this.render();
        window.setTimeout(() => {
          this.hintStock = false;
          this.render();
        }, 1800);
      } else {
        this.showMessage("失败", "error");
        this.renderBoard();
      }
      return;
    }
    const scored = moves.map((move) => ({ move, score: this.scoreHint(move) })).sort((a, b) => b.score - a.score);
    const move = scored[0].move;
    this.hintMove = { ...move, cardIndex: this.game.tableau[move.from].length - move.count };
    this.stats.hintCount += 1;
    this.persistStats();
    this.renderBoard();
  }

  scoreHint(move) {
    const source = this.game.tableau[move.from];
    const destination = this.game.tableau[move.to];
    const moving = source[source.length - move.count];
    const destinationTop = destination.at(-1);
    let score = 0;
    if (source.length === move.count || !source[source.length - move.count - 1]?.faceUp) score += 100;
    if (destinationTop?.suit === moving.suit) score += 45;
    if (destination.length === 0) score += 25;
    if (moving.rank === 13) score += 8;
    if (this.lastMove?.from === move.to && this.lastMove?.to === move.from) score -= 120;
    return score;
  }

  currentElapsed() {
    return timerElapsedMs({ status: this.timerState, elapsedMs: this.elapsedBeforeRun, startedAt: this.startedAt }, performance.now());
  }

  applyTimer(next) {
    this.timerState = next.status;
    this.elapsedBeforeRun = next.elapsedMs;
    this.startedAt = next.startedAt;
  }

  resumeTimer() {
    if (this.timerState === "FINISHED") return;
    this.applyTimer(transitionTimer(
      { status: this.timerState, elapsedMs: this.elapsedBeforeRun, startedAt: this.startedAt },
      this.timerState === "PAUSED" ? "RESUME" : "SUCCESS",
      performance.now(),
    ));
  }

  pauseTimer() {
    if (this.timerState !== "RUNNING") return;
    this.applyTimer(transitionTimer(
      { status: this.timerState, elapsedMs: this.elapsedBeforeRun, startedAt: this.startedAt },
      "PAUSE",
      performance.now(),
    ));
  }

  handleVisibility() {
    if (document.hidden) { this.pauseTimer(); this.persistGame(); }
    else if (this.timerState === "PAUSED" && this.game && !isWin(this.game)) this.resumeTimer();
    this.renderHud();
  }

  startTicker() {
    this.timerHandle = window.setInterval(() => {
      if (this.timerState === "RUNNING") this.el.timer.textContent = formatTime(this.currentElapsed());
    }, 250);
  }

  currentScore() {
    if (!this.game) return 0;
    return calculateScore({
      suitMode: this.suit,
      difficulty: this.difficulty,
      completedSets: this.game.completed.length,
      scoringMoves: this.game.moveCount,
    });
  }

  async completeGame() {
    this.applyTimer(transitionTimer(
      { status: this.timerState, elapsedMs: this.elapsedBeforeRun, startedAt: this.startedAt },
      "FINISH",
      performance.now(),
    ));
    if (this.deal?.dealId) this.completedDealIds.add(this.deal.dealId);
    const score = this.currentScore();
    this.stats.gamesWon += 1;
    this.stats.totalScore += score;
    this.stats.bestScore = this.stats.bestScore == null ? score : Math.max(this.stats.bestScore, score);
    this.stats.fastestMs = this.stats.fastestMs == null ? this.elapsedBeforeRun : Math.min(this.stats.fastestMs, this.elapsedBeforeRun);
    this.stats.minimumMoves = this.stats.minimumMoves == null ? this.game.moveCount : Math.min(this.stats.minimumMoves, this.game.moveCount);
    this.stats.recentGames = [{ dealId: this.deal?.dealId, suit: this.suit, difficulty: this.difficulty, score, elapsedMs: this.elapsedBeforeRun, wonAt: new Date().toISOString() }, ...this.stats.recentGames].slice(0, 20);
    await this.callRepository(["gameFinished"], [{ profileId: this.profile.profileId, dealId: this.deal?.dealId, suitMode: this.suit, difficulty: this.difficulty, won: true, score, elapsedMs: Math.floor(this.elapsedBeforeRun), moves: this.game.moveCount, undoCount: this.game.undoCount, hintCount: this.stats.hintCount }], null);
    await this.persistStats();
    await this.callRepository(["deleteSave"], [this.profile.profileId, this.deal?.dealId], null);
    this.showMessage("恭喜，你完成了这局认证牌局！", "success");
    this.toast(`完成！得分 ${score}，用时 ${formatTime(this.elapsedBeforeRun)}。`, "success", 8000);
    showVictoryCelebration(this.root, this.preferences);
  }

  async persistGame() {
    if (!this.game || this.calibration) return;
    const save = {
      profileId: this.profile.profileId,
      dealId: this.deal?.dealId ?? await computeDealId(this.game.canonicalSeed, this.game.suitMode),
      canonicalSeed: this.game.canonicalSeed,
      suitMode: this.game.suitMode,
      difficulty: this.difficulty,
      elapsedMs: this.currentElapsed(),
      timerState: this.timerState,
      gameState: serializeState(this.game),
      ruleVersion: this.game.ruleVersion,
      generatorVersion: this.game.generatorVersion,
      seedLibraryVersion: this.manifest?.seedLibraryVersion ?? "1",
      savedAt: new Date().toISOString(),
    };
    try { await this.callRepository(["saveCurrentGame", "saveGame", "save"], [save], null); }
    catch (error) { this.showStorageFallback(error); }
  }

  async persistStats() {
    if (this.calibration) return;
    try { await this.callRepository(["saveStats", "putStats"], [this.profile.profileId, this.stats], null); }
    catch (error) { this.showStorageFallback(error); }
  }

  showStorageFallback(error) {
    this.storageCapability = { persistent: false, mode: "memory", error: safeText(error) };
    this.el["storage-banner"].hidden = false;
    this.el["storage-message"].textContent = "保存失败，当前改用临时模式。关闭页面前请导出 JSON 备份。";
  }

  render() {
    this.syncSelectors();
    this.renderProfile();
    this.renderHud();
    this.renderBoard();
    this.renderCompleted();
    const stockRounds = this.game?.stock?.length ?? 0;
    this.el["stock-status"].textContent = `剩余 ${stockRounds} 轮`;
    this.el.stock.disabled = !this.game || stockRounds === 0;
    this.el.stock.classList.toggle("is-hint", this.hintStock);
    this.el["seed-display"].textContent = this.calibration ? this.calibration.blindId : formatSeed(this.deal?.canonicalSeed ?? this.game?.canonicalSeed);
    this.el["seed-button"].disabled = !this.game;
    this.el["difficulty-badge"].textContent = this.calibration
      ? `盲测牌局 · ${this.calibration.blindId}`
      : `${SUIT_LABEL[this.suit]} · ${DIFFICULTY_LABEL[this.difficulty]}`;
    this.setActionEnabled("undo", Boolean(this.game?.history?.length));
    this.setActionEnabled("restart", Boolean(this.game));
    this.setActionEnabled("hint", Boolean(this.game));
  }

  renderHud() {
    this.el.timer.textContent = formatTime(this.currentElapsed());
    this.el.moves.textContent = String(this.game?.moveCount ?? 0);
    this.el.score.textContent = String(this.currentScore());
  }

  renderProfile() {
    const name = this.profile?.name ?? this.profile?.displayName ?? "访客";
    this.el["profile-name"].textContent = name;
    this.el["profile-button"].querySelector(".avatar").textContent = name.slice(0, 1).toUpperCase();
  }

  renderCompleted() {
    const completed = this.game?.completed ?? [];
    this.el["completed-area"].innerHTML = Array.from({ length: 8 }, (_, index) => {
      const item = completed[index];
      const collecting = this.motion?.type === "collect" && item && index >= this.motion.completedFrom;
      return `<span class="completed-slot${item ? " done" : ""}${collecting ? " is-collecting" : ""}" title="${item ? `已完成 ${escapeHtml(item.suit)}` : "待完成"}">${item ? SUIT_SYMBOL[item.suit] : "♠"}</span>`;
    }).join("");
  }

  renderBoard() {
    this.el.stock?.classList.toggle("is-hint", this.hintStock);
    if (!this.game) {
      this.el.tableau.innerHTML = Array.from({ length: 10 }, (_, index) => `<div class="column" data-column="${index}" data-column-label="${index + 1}" aria-label="第 ${index + 1} 列"></div>`).join("");
      return;
    }
    this.el.tableau.innerHTML = this.game.tableau.map((column, columnIndex) => {
      const cards = column.map((card, cardIndex) => this.renderCard(card, columnIndex, cardIndex, column.length)).join("");
      const invalid = this.invalidColumns.has(columnIndex) ? " is-invalid" : "";
      const moving = this.motion?.type === "move" && (this.motion.from === columnIndex || this.motion.to === columnIndex) ? " is-moving" : "";
      const collecting = this.motion?.type === "collect" && (this.motion.from === columnIndex || this.motion.to === columnIndex) ? " is-collecting" : "";
      return `<div class="column${invalid}${moving}${collecting}" data-column="${columnIndex}" data-column-label="${columnIndex + 1}" role="list" aria-label="第 ${columnIndex + 1} 列，${column.length} 张牌">${cards}</div>`;
    }).join("");
  }

  renderCard(card, columnIndex, cardIndex, columnLength) {
    const column = this.game.tableau[columnIndex];
    const viewportHeight = globalThis.window?.innerHeight || 900;
    const viewportWidth = globalThis.window?.innerWidth || 1280;
    const { compactY, expandedY, tailStart } = computeCardStackOffsets(column, cardIndex, viewportHeight, viewportWidth);
    const selected = this.selected?.from === columnIndex && cardIndex >= this.selected.cardIndex;
    const red = card.suit === "hearts" || card.suit === "diamonds";
    const label = card.faceUp ? `${RANK_LABEL[card.rank] ?? card.rank}${SUIT_SYMBOL[card.suit]}` : "背面朝上的牌";
    const tabIndex = cardIndex === columnLength - 1 ? 0 : -1;
    const dealt = this.motion?.type === "deal" && this.motion.cardIds.includes(card.id);
    const moved = this.motion?.type === "move" && this.motion.cardIds.includes(card.id);
    const hinted = this.hintMove?.from === columnIndex && cardIndex >= this.hintMove.cardIndex;
    const dealDelay = dealt ? `${Math.min(cardIndex, 9) * 28}ms` : "0ms";
    const movableTail = cardIndex >= tailStart;
    return `<button type="button" class="card${card.faceUp ? "" : " face-down"}${red ? " red" : ""}${selected ? " is-selected" : ""}${hinted ? " is-hint" : ""}${movableTail ? " is-movable-tail" : ""}${dealt ? " is-dealt" : ""}${moved ? " is-moved" : ""}" style="--y:${compactY}px;--y-expanded:${expandedY}px;--deal-delay:${dealDelay};z-index:${cardIndex + 1}" data-column="${columnIndex}" data-card-index="${cardIndex}" aria-label="${label}，第 ${columnIndex + 1} 列" aria-grabbed="${selected ? "true" : "false"}" draggable="${card.faceUp}" tabindex="${tabIndex}">${card.faceUp ? this.renderCardFace(card) : ""}</button>`;
  }

  renderCardFace(card) {
    const suit = SUIT_SYMBOL[card.suit];
    const rank = RANK_LABEL[card.rank] ?? card.rank;
    if (card.rank >= 11) {
      return `<span class="card-corner"><span>${rank}</span><span class="card-suit">${suit}</span></span><span class="court-card court-${rank.toLowerCase()}" aria-hidden="true"><span class="court-crown">${rank}</span><span class="court-head"></span><span class="court-eye court-eye-left"></span><span class="court-eye court-eye-right"></span><span class="court-body">${suit}</span></span><span class="card-corner card-corner-bottom" aria-hidden="true"><span>${rank}</span><span class="card-suit">${suit}</span></span>`;
    }
    const pips = (PIP_LAYOUT[card.rank] ?? []).map((position) => `<span class="pip pip-${position}">${suit}</span>`).join("");
    return `<span class="card-corner"><span>${rank}</span><span class="card-suit">${suit}</span></span><span class="pip-grid" aria-hidden="true">${pips}</span><span class="card-corner card-corner-bottom" aria-hidden="true"><span>${rank}</span><span class="card-suit">${suit}</span></span>`;
  }

  setMotion(motion, duration = 620) {
    this.motion = motion;
    this.render();
    window.setTimeout(() => {
      if (this.motion !== motion) return;
      this.motion = null;
      this.render();
    }, duration);
  }

  setActionEnabled(action, enabled) {
    this.root.querySelectorAll(`[data-action="${action}"]`).forEach((button) => { button.disabled = !enabled; });
  }

  syncSelectors() {
    this.el["suit-select"].value = this.suit;
    this.el["difficulty-select"].value = this.difficulty;
    this.refreshDifficultyOptions();
  }

  showMessage(message, kind = "normal") {
    this.el["game-message"].textContent = message;
    this.el["game-message"].dataset.kind = kind;
  }

  toast(message, kind = "normal", duration = 3500) {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    this.el["toast-region"].append(node);
    setTimeout(() => node.remove(), duration);
  }

  async confirm(title, message, accept = "确认") {
    this.el["confirm-dialog"].querySelector("h2").textContent = title;
    this.el["confirm-message"].textContent = message;
    this.el["confirm-accept"].textContent = accept;
    return new Promise((resolve) => {
      this.pendingConfirmation = resolve;
      this.el["confirm-dialog"].showModal();
    });
  }

  resolveConfirmation() {
    this.pendingConfirmation?.(this.el["confirm-dialog"].returnValue === "confirm");
    this.pendingConfirmation = null;
  }

  action(name) {
    const actions = {
      new: () => this.newGame(), undo: () => this.performUndo(), restart: () => this.performRestart(), hint: () => this.performHint(),
      stats: () => this.openStats(), settings: () => this.openSettings(), export: () => this.exportData(), import: () => this.el["import-input"].click(),
    };
    actions[name]?.();
  }

  openPanel(title, html) {
    this.el["panel-title"].textContent = title;
    this.el["panel-content"].innerHTML = html;
    this.el["panel-content"].onclick = (event) => this.onPanelAction(event);
    this.el["panel-content"].onchange = (event) => this.onPanelChange(event);
    if (!this.el["panel-dialog"].open) this.el["panel-dialog"].showModal();
  }

  openSettings() {
    this.openPanel("设置", `<div class="setting-grid">
      <label class="setting-row"><span class="setting-copy"><strong>主题</strong><small>选择牌桌和界面配色</small></span><select data-setting="theme"><option value="dark"${this.preferences.theme === "dark" ? " selected" : ""}>深色</option><option value="light"${this.preferences.theme === "light" ? " selected" : ""}>浅色</option><option value="contrast"${this.preferences.theme === "contrast" ? " selected" : ""}>高对比</option></select></label>
      <label class="setting-row"><span class="setting-copy"><strong>减弱动画</strong><small>减少非必要移动效果</small></span><input type="checkbox" data-setting="reduceMotion"${this.preferences.reduceMotion ? " checked" : ""}></label>
      <label class="setting-row"><span class="setting-copy"><strong>牌面动画</strong><small>移动与完成时的过渡效果</small></span><input type="checkbox" data-setting="animation"${this.preferences.animation ? " checked" : ""}></label>
      <label class="setting-row"><span class="setting-copy"><strong>声音</strong><small>本机生成的轻量操作音</small></span><input type="checkbox" data-setting="sound"${this.preferences.sound ? " checked" : ""}></label>
    </div><div class="button-row"><button type="button" data-panel-action="export">导出备份</button><button type="button" class="secondary" data-panel-action="import">导入备份</button></div>`);
  }

  openStats() {
    const winRate = this.stats.gamesStarted ? Math.round(this.stats.gamesWon / this.stats.gamesStarted * 100) : 0;
    this.openPanel("本地统计", `<div class="stats-grid">
      ${this.statCard("开始牌局", this.stats.gamesStarted)}${this.statCard("完成牌局", this.stats.gamesWon)}${this.statCard("胜率", `${winRate}%`)}
      ${this.statCard("最高得分", this.stats.bestScore ?? "—")}${this.statCard("最快完成", this.stats.fastestMs == null ? "—" : formatTime(this.stats.fastestMs))}${this.statCard("最少步数", this.stats.minimumMoves ?? "—")}
      ${this.statCard("已认证完成", this.completedDealIds.size)}${this.statCard("撤销", this.stats.undoCount)}${this.statCard("提示", this.stats.hintCount)}
    </div>`);
  }

  statCard(label, value) { return `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`; }

  async openProfiles() {
    const profilesRaw = await this.callRepository(["listProfiles", "getProfiles"], [], [this.profile]);
    const profiles = resolveRuntimeRecord(profilesRaw, [this.profile]);
    this.openPanel("本地用户", `<div class="profile-list">${profiles.map((profile) => `<div class="profile-item"><span><strong>${escapeHtml(profile.name ?? profile.displayName ?? "未命名")}</strong>${profile.profileId === this.profile.profileId ? " · 当前" : ""}</span><div><button type="button" class="secondary" data-panel-action="switch-profile" data-profile-id="${escapeHtml(profile.profileId)}">切换</button></div></div>`).join("")}</div><div class="button-row"><button type="button" data-panel-action="create-profile">创建用户</button><button type="button" class="secondary" data-panel-action="rename-profile">重命名当前用户</button><button type="button" class="danger" data-panel-action="delete-profile">删除当前用户</button></div>`);
  }

  async onPanelAction(event) {
    const button = event.target.closest("[data-panel-action]");
    if (!button) return;
    const action = button.dataset.panelAction;
    if (action === "export") return this.exportData();
    if (action === "import") return this.el["import-input"].click();
    if (action === "replay") { this.el["panel-dialog"].close(); return this.newGame({ confirm: false, replayCompleted: true }); }
    if (action === "reset-completed") return this.resetBucketCompleted();
    if (action === "create-profile") return this.createProfile();
    if (action === "rename-profile") return this.renameProfile();
    if (action === "delete-profile") return this.deleteProfile();
    if (action === "switch-profile") return this.switchProfile(button.dataset.profileId);
  }

  async onPanelChange(event) {
    const control = event.target.closest("[data-setting]");
    if (!control) return;
    this.preferences[control.dataset.setting] = control.type === "checkbox" ? control.checked : control.value;
    this.applyPreferences();
    await this.callRepository(["setPreferences", "savePreferences", "putPreferences"], [this.profile.profileId, this.preferences], null);
  }

  applyPreferences() {
    document.documentElement.dataset.theme = this.preferences.theme;
    document.documentElement.classList.toggle("reduce-motion", this.preferences.reduceMotion || !this.preferences.animation);
    this.audio.setPreferences(this.preferences);
  }

  async createProfile() {
    const name = window.prompt("新用户名称（仅保存在本机）", "新用户")?.trim();
    if (!name) return;
    try {
      const created = await this.callRepository(["createProfile"], [name], null);
      if (!created) throw new Error("当前存储接口不支持创建用户");
      await this.switchProfile(resolveRuntimeRecord(created).profileId);
    } catch (error) { this.toast(safeText(error), "error"); }
  }

  async renameProfile() {
    const name = window.prompt("新的用户名称", this.profile.name ?? this.profile.displayName ?? "")?.trim();
    if (!name) return;
    try {
      const updated = await this.callRepository(["renameProfile"], [this.profile.profileId, name], null);
      this.profile = { ...this.profile, ...(resolveRuntimeRecord(updated, {})), name };
      this.renderProfile();
      await this.openProfiles();
    } catch (error) { this.toast(safeText(error), "error"); }
  }

  async deleteProfile() {
    if (this.profile.profileId === "guest") return this.toast("访客用户不能删除。", "error");
    if (!await this.confirm("删除本地用户？", "该用户的牌局、完成记录与统计将从当前电脑删除。", "删除")) return;
    try {
      await this.callRepository(["deleteProfile"], [this.profile.profileId], null);
      this.profile = { profileId: "guest", name: "访客" };
      await this.loadProfileState();
      this.el["panel-dialog"].close();
      await this.newGame({ confirm: false });
    } catch (error) { this.toast(safeText(error), "error"); }
  }

  async switchProfile(profileId) {
    if (!profileId || profileId === this.profile.profileId) return;
    try {
      const selected = await this.callRepository(["setCurrentProfile", "switchProfile"], [profileId], null);
      this.profile = resolveRuntimeRecord(selected, { profileId, name: "本地用户" });
      await this.loadProfileState();
      this.el["panel-dialog"].close();
      await this.restoreOrStart();
    } catch (error) { this.toast(safeText(error), "error"); }
  }

  async resetBucketCompleted() {
    if (!await this.confirm("重置当前分类记录？", "只会重新开放当前花色与难度的已完成牌局，其他统计保持不变。", "重置")) return;
    const ids = (this.library.byBucket?.get(`${this.suit}.${this.difficulty}`) ?? []).map((deal) => deal.dealId);
    ids.forEach((id) => this.completedDealIds.delete(id));
    await this.callRepository(["resetCompleted"], [this.profile.profileId, { suitMode: this.suit, difficulty: this.difficulty }], null);
    this.el["panel-dialog"].close();
    await this.newGame({ confirm: false });
  }

  async exportData() {
    try {
      let backup = null;
      if (this.runtime?.exportBackup && this.repository) backup = await this.runtime.exportBackup(this.repository);
      if (!backup) backup = { saveVersion: 1, exportedAt: new Date().toISOString(), profiles: [this.profile], preferences: this.preferences, stats: this.stats, completedDealIds: [...this.completedDealIds], currentGame: this.game ? { profileId: this.profile.profileId, dealId: this.deal?.dealId, canonicalSeed: this.game.canonicalSeed, suitMode: this.game.suitMode, difficulty: this.difficulty, elapsedMs: this.currentElapsed(), timerState: this.timerState, state: serializeState(this.game) } : null };
      downloadJson("spider-backup.json", backup);
      this.toast("备份已导出。", "success");
    } catch (error) { this.toast(`导出失败：${safeText(error)}`, "error"); }
  }

  async importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (this.runtime?.importBackup && this.repository) await this.runtime.importBackup(this.repository, parsed);
      else {
        if (parsed.saveVersion !== 1) throw new Error("不支持的备份版本");
        if (parsed.preferences) this.preferences = { ...DEFAULT_PREFERENCES, ...parsed.preferences };
        if (parsed.stats) this.stats = { ...EMPTY_STATS, ...parsed.stats };
        if (Array.isArray(parsed.completedDealIds)) this.completedDealIds = new Set(parsed.completedDealIds);
      }
      await this.loadProfileState();
      this.applyPreferences();
      this.toast("备份导入成功。", "success");
      this.el["panel-dialog"].close();
      await this.restoreOrStart();
    } catch (error) { this.toast(`导入失败，原数据未更改：${safeText(error)}`, "error", 7000); }
  }

  async copyDealIdentity() {
    if (!this.game) return;
    const identity = `${this.deal?.dealId ?? ""}\n${this.game.canonicalSeed}`.trim();
    try { await navigator.clipboard.writeText(identity); this.toast("牌局编号已复制。", "success"); }
    catch { this.toast(identity); }
  }

  onKeyDown(event) {
    if (event.target.matches("input, select, textarea") || this.root.querySelector("dialog[open]")) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "z") { event.preventDefault(); this.performUndo(); return; }
    if (key === "h") { event.preventDefault(); this.performHint(); return; }
    if (key === "r") { event.preventDefault(); this.performRestart(); return; }
    if (key === "n") { event.preventDefault(); this.newGame(); return; }
    if (key === "escape") { this.selected = null; this.renderBoard(); return; }
    if (event.code === "Space") { event.preventDefault(); this.performDeal(); return; }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) this.handleBoardKeyboard(event);
  }

  handleBoardKeyboard(event) {
    const active = document.activeElement?.closest(".card, .column");
    if (!active) return;
    event.preventDefault();
    const columnIndex = Number(active.dataset.column);
    if (event.key === "Enter") {
      const card = active.closest(".card");
      if (this.selected) this.tryMove({ type: "move", from: this.selected.from, to: columnIndex, count: this.selected.count });
      else if (card) this.selectCard(columnIndex, Number(card.dataset.cardIndex));
      return;
    }
    let nextColumn = columnIndex;
    if (event.key === "ArrowLeft") nextColumn = Math.max(0, columnIndex - 1);
    if (event.key === "ArrowRight") nextColumn = Math.min(9, columnIndex + 1);
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const cards = [...this.el.tableau.querySelectorAll(`.card[data-column="${columnIndex}"]`)];
      const current = Number(active.dataset.cardIndex);
      const next = event.key === "ArrowUp" ? Math.max(0, current - 1) : Math.min(cards.length - 1, current + 1);
      cards[next]?.focus();
      return;
    }
    const target = this.el.tableau.querySelector(`.card[data-column="${nextColumn}"]:last-child`) ?? this.el.tableau.querySelector(`.column[data-column="${nextColumn}"]`);
    target?.focus();
  }

  showFatal(error) {
    try {
      this.cacheElements();
      this.showMessage(`应用无法启动：${safeText(error)}`, "error");
      byId(this.root, "app").setAttribute("aria-busy", "false");
    } catch { document.body.textContent = `应用无法启动：${safeText(error)}`; }
  }
}
