import { generateDeal } from "../../src/core/generator.js";

export function nearWinState() {
  const state = generateDeal("u64:000000000000002a", 1);
  const byId = new Map([...state.tableau.flat(), ...state.stock.flat()].map((card) => [card.id, card]));
  const tableau = Array.from({ length: 10 }, () => []);
  for (let copy = 0; copy < 8; copy += 1) {
    for (let rank = 13; rank >= 1; rank -= 1) {
      tableau[copy].push({ ...byId.get(`spades:${rank}:${copy}`), faceUp: true });
    }
  }
  state.tableau = tableau;
  state.stock = [];
  state.completed = [];
  return state;
}

export const NEAR_WIN_MOVES = Object.freeze([
  Object.freeze({ type: "move", from: 0, to: 8, count: 1 }),
  Object.freeze({ type: "move", from: 8, to: 0, count: 1 }),
]);
