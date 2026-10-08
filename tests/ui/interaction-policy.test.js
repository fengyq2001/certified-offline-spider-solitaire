import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getLegalMoves } from "../../src/core/engine.js";
import {
  computeCardStackOffsets,
  firstLegalDestinationForSelection,
  legalDestinationPriority,
  PIP_LAYOUT,
} from "../../src/ui/app.js";
import { nearWinState } from "../solver/fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("board interaction policy clears invalid selection and double-clicks first legal destination", async () => {
  const source = await readFile(path.join(ROOT, "src/ui/app.js"), "utf8");
  const invalidBranch = source.slice(source.indexOf("  tryMove(move) {"), source.indexOf("  performDeal()"));
  assert.match(invalidBranch, /catch \(error\) \{[\s\S]*this\.selected = null;/);
  assert.match(invalidBranch, /this\.invalidColumns = new Set/);
  assert.doesNotMatch(invalidBranch, /this\.toast\(/);
  assert.match(source, /addEventListener\("dblclick"/);
  assert.match(source, /a\.to - b\.to/);
  assert.match(source, /selectedGroup/);
  assert.match(source, /firstLegalDestinationForSelection/);
  assert.match(source, /cardIndex >= this\.selected\.cardIndex/);
  assert.match(source, /const hinted = this\.hintMove\?\.from === columnIndex/);
});

test("double-click resolves the already selected group, then chooses the leftmost legal column", () => {
  const game = nearWinState();
  const moves = getLegalMoves(game).filter((move) => move.type === "move" && move.count > 1);
  assert.ok(moves.length > 0, "fixture must expose a movable selected group");
  const grouped = moves
    .sort((a, b) => a.from - b.from || a.count - b.count || a.to - b.to)
    .at(0);
  const selected = {
    from: grouped.from,
    count: grouped.count,
    cardIndex: game.tableau[grouped.from].length - grouped.count,
  };
  const expected = moves
    .filter((move) => move.from === selected.from && move.count === selected.count)
    .sort((a, b) => a.to - b.to)[0];
  assert.deepEqual(firstLegalDestinationForSelection(game, selected), expected);
});

test("double-click destination priority is same-suit, empty, then mixed-suit", () => {
  const movingBottom = { suit: "spades", rank: 7 };
  const game = { tableau: [[{ suit: "spades", rank: 8 }], [], [{ suit: "hearts", rank: 8 }]] };
  assert.equal(legalDestinationPriority(game, movingBottom, { to: 0 }), 0);
  assert.equal(legalDestinationPriority(game, movingBottom, { to: 1 }), 1);
  assert.equal(legalDestinationPriority(game, movingBottom, { to: 2 }), 2);

  const nearWin = nearWinState();
  const oldTargetColumn = nearWin.tableau[1];
  const sameSuitTarget = oldTargetColumn[0];
  nearWin.tableau[1] = [sameSuitTarget];
  nearWin.tableau[9].push(...oldTargetColumn.slice(1));
  const selection = { from: 0, count: 12, cardIndex: 1 };
  assert.equal(firstLegalDestinationForSelection(nearWin, selection).to, 1, "same-suit column wins over later empty columns");
});

test("long columns compress while hover offsets restore the movable tail spacing", () => {
  const column = nearWinState().tableau[0];
  const compressed = computeCardStackOffsets(column, column.length - 1, 420, 1000);
  assert.equal(compressed.needsCompression, true);
  assert.ok(compressed.compactUpGap < 23);
  assert.ok(compressed.expandedY > compressed.compactY);
  const roomy = computeCardStackOffsets(column, column.length - 1, 1000, 1400);
  assert.equal(roomy.needsCompression, false);
  assert.equal(roomy.compactUpGap, 23);
});

test("board motion and card-face policy are represented in source", async () => {
  const source = await readFile(path.join(ROOT, "src/ui/app.js"), "utf8");
  const css = await readFile(path.join(ROOT, "src/ui/styles.css"), "utf8");
  assert.match(source, /type: "deal"/);
  assert.match(source, /type: "collect"/);
  assert.match(source, /--deal-delay/);
  assert.match(source, /PIP_LAYOUT/);
  assert.match(source, /court-card/);
  const hintBranch = source.slice(source.indexOf("  performHint()"), source.indexOf("  scoreHint(move)"));
  assert.doesNotMatch(hintBranch, /提示：将第/);
  assert.match(hintBranch, /showMessage\("失败", "error"\)/);
  assert.match(css, /\.card\.is-dealt\s*\{[^}]*--deal-delay/);
  assert.match(css, /\.completed-slot\.is-collecting/);
  assert.match(css, /\.card\.is-hint/);
  assert.match(css, /\.stock\.is-hint/);
  assert.match(css, /overflow: hidden/);
  assert.match(css, /--toolbar-reserve/);
  assert.match(css, /\.stock-row[^}]*position: relative/);
  assert.match(css, /\.column:hover \.card\.is-movable-tail/);
  assert.match(css, /invalid-shake \.18s/);
});

test("numeric card faces use one non-overlapping pip position per rank", () => {
  for (let rank = 1; rank <= 10; rank += 1) {
    const positions = PIP_LAYOUT[rank];
    assert.equal(positions.length, rank);
    assert.equal(new Set(positions).size, rank);
  }
  assert.deepEqual(PIP_LAYOUT[7], ["tl", "tr", "mtl", "mtr", "c", "bl", "br"]);
  assert.deepEqual(PIP_LAYOUT[10], ["tl", "tr", "mtl", "mtr", "ml", "mr", "mbl", "mbr", "bl", "br"]);
});
