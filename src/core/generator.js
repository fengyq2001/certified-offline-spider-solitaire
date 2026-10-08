const UINT64_MASK = (1n << 64n) - 1n;
const UINT64_RANGE = 1n << 64n;

export const RULE_VERSION = "1.0";
export const GENERATOR_VERSION = "1";
const TORANPU_MARKER_BY_SUIT = Object.freeze({
  1: 0x10000000n,
  2: 0x20000000n,
  4: 0x40000000n,
});
export const SUITS = Object.freeze(["spades", "hearts", "diamonds", "clubs"]);

function u64(value) {
  return value & UINT64_MASK;
}

function rotl64(value, bits) {
  const shift = BigInt(bits);
  return u64((value << shift) | (value >> (64n - shift)));
}

/** Normalize an unsigned 64-bit seed without ever routing it through Number. */
export function canonicalizeSeed(seed) {
  let value;
  if (typeof seed === "bigint") {
    value = seed;
  } else if (typeof seed === "string" && /^u64:[0-9a-f]{16}$/.test(seed)) {
    value = BigInt(`0x${seed.slice(4)}`);
  } else {
    throw new TypeError("seed must be a bigint or u64: followed by 16 lowercase hexadecimal digits");
  }

  if (value < 0n || value > UINT64_MASK) {
    throw new RangeError("seed must be an unsigned 64-bit integer");
  }
  return `u64:${value.toString(16).padStart(16, "0")}`;
}

export function normalizeSuitMode(suitMode) {
  const aliases = new Map([
    [1, 1], [2, 2], [4, 4],
    ["1", 1], ["2", 2], ["4", 4],
    ["1s", 1], ["2s", 2], ["4s", 4],
  ]);
  const normalized = aliases.get(suitMode);
  if (!normalized) throw new RangeError("suitMode must be 1, 2, or 4");
  return normalized;
}

/**
 * Frozen V1 deck order: copy-major, then suit-major, then rank A..K.
 * 1 suit uses 8 copies of spades; 2 suits use 4 copies of spades/hearts;
 * 4 suits use 2 copies of each suit.
 */
export function createDeck(suitMode) {
  const mode = normalizeSuitMode(suitMode);
  const suits = SUITS.slice(0, mode);
  const copies = 8 / mode;
  const deck = [];
  for (let copy = 0; copy < copies; copy += 1) {
    for (const suit of suits) {
      for (let rank = 1; rank <= 13; rank += 1) {
        deck.push({
          id: `${suit}:${rank}:${copy}`,
          rank,
          suit,
          faceUp: false,
        });
      }
    }
  }
  return deck;
}

/** Standard SplitMix64 expansion followed by xoshiro256**. */
export function createXoshiro256StarStar(seed) {
  const canonicalSeed = canonicalizeSeed(seed);
  let splitMixState = BigInt(`0x${canonicalSeed.slice(4)}`);

  function splitMix64() {
    splitMixState = u64(splitMixState + 0x9e3779b97f4a7c15n);
    let z = splitMixState;
    z = u64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = u64((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return u64(z ^ (z >> 31n));
  }

  const state = [splitMix64(), splitMix64(), splitMix64(), splitMix64()];

  function nextUint64() {
    const result = u64(rotl64(u64(state[1] * 5n), 7) * 9n);
    const t = u64(state[1] << 17n);
    state[2] = u64(state[2] ^ state[0]);
    state[3] = u64(state[3] ^ state[1]);
    state[1] = u64(state[1] ^ state[2]);
    state[0] = u64(state[0] ^ state[3]);
    state[2] = u64(state[2] ^ t);
    state[3] = rotl64(state[3], 45);
    return result;
  }

  function uniformIndex(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive safe integer");
    }
    const bound = BigInt(maxExclusive);
    const limit = UINT64_RANGE - (UINT64_RANGE % bound);
    let value;
    do value = nextUint64(); while (value >= limit);
    return Number(value % bound);
  }

  return Object.freeze({ nextUint64, uniformIndex });
}

/** Frozen V1 Fisher-Yates traversal: i = length-1..1 with unbiased indexes. */
export function shuffleDeck(seed, suitMode) {
  const deck = createDeck(suitMode);
  const random = createXoshiro256StarStar(seed);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = random.uniformIndex(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// The expanded factory uses a compact, MIT-licensed Toranpu-compatible
// candidate stream. Dedicated high-word markers keep existing V1 seeds
// byte-for-byte stable while selecting the correct 1/2/4-suit stream.
function createMulberry32(seed) {
  let state = Number(BigInt(`0x${canonicalizeSeed(seed).slice(4)}`) & 0xffffffffn) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isToranpuSeed(seed, suitMode) {
  const value = BigInt(`0x${canonicalizeSeed(seed).slice(4)}`);
  return (value >> 32n) === TORANPU_MARKER_BY_SUIT[suitMode];
}

function shuffleToranpuDeck(seed, suitMode) {
  const deck = createDeck(suitMode);
  const random = createMulberry32(seed);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

function cloneCard(card, faceUp = card.faceUp) {
  return { id: card.id, rank: card.rank, suit: card.suit, faceUp };
}

function makeSnapshot(tableau, stock, completed = []) {
  return {
    tableau: tableau.map((column) => column.map((card) => cloneCard(card))),
    stock: stock.map((round) => round.map((card) => cloneCard(card))),
    completed: completed.map((set) => ({
      suit: set.suit,
      cards: set.cards.map((card) => cloneCard(card, true)),
    })),
    moveCount: 0,
  };
}

/**
 * Frozen V1 deal traversal: consume the shuffled order from index 0; deal six
 * rounds to columns 0..9, skipping columns 4..9 on round six. Stock is then
 * split into five rounds in consumption order, each round column 0..9.
 */
export function generateDeal(seed, suitMode) {
  const canonicalSeed = canonicalizeSeed(seed);
  const mode = normalizeSuitMode(suitMode);
  const shuffled = isToranpuSeed(canonicalSeed, mode)
    ? shuffleToranpuDeck(canonicalSeed, mode)
    : shuffleDeck(canonicalSeed, mode);
  const tableau = Array.from({ length: 10 }, () => []);
  let cursor = 0;

  for (let round = 0; round < 6; round += 1) {
    const columnCount = round < 5 ? 10 : 4;
    for (let column = 0; column < columnCount; column += 1) {
      tableau[column].push(cloneCard(shuffled[cursor++]));
    }
  }
  for (const column of tableau) {
    column[column.length - 1] = cloneCard(column[column.length - 1], true);
  }

  const stock = [];
  for (let round = 0; round < 5; round += 1) {
    stock.push(shuffled.slice(cursor, cursor + 10).map((card) => cloneCard(card)));
    cursor += 10;
  }

  const initialSnapshot = makeSnapshot(tableau, stock);
  const state = {
    schemaVersion: 1,
    ruleVersion: RULE_VERSION,
    generatorVersion: GENERATOR_VERSION,
    canonicalSeed,
    suitMode: mode,
    tableau,
    stock,
    completed: [],
    moveCount: 0,
    undoCount: 0,
    history: [],
    lastEvent: null,
    initialSnapshot,
  };
  state.dealId = computeDealIdSync(canonicalSeed, mode, state.ruleVersion, state.generatorVersion);
  state.initialDealHash = computeInitialDealHashSync(state);
  return state;
}

function canonicalIdentity(ruleVersion, generatorVersion, suitMode, canonicalSeed) {
  return [
    `ruleVersion=${ruleVersion}`,
    `generatorVersion=${generatorVersion}`,
    `suitMode=${normalizeSuitMode(suitMode)}`,
    `canonicalSeed=${canonicalizeSeed(canonicalSeed)}`,
  ].join("\n");
}

function rightRotate32(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

// A compact, dependency-free SHA-256 keeps generateDeal synchronous and gives
// browsers and Node the same byte-level identity without a Promise in state.
function sha256Sync(value) {
  const bytes = new TextEncoder().encode(value);
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = (
        (padded[start] << 24)
        | (padded[start + 1] << 16)
        | (padded[start + 2] << 8)
        | padded[start + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = rightRotate32(x, 7) ^ rightRotate32(x, 18) ^ (x >>> 3);
      const s1 = rightRotate32(y, 17) ^ rightRotate32(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate32(e, 6) ^ rightRotate32(e, 11) ^ rightRotate32(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rightRotate32(a, 2) ^ rightRotate32(a, 13) ^ rightRotate32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function computeDealIdSync(
  seed,
  suitMode,
  ruleVersion = RULE_VERSION,
  generatorVersion = GENERATOR_VERSION,
) {
  if (typeof ruleVersion !== "string" || ruleVersion.length === 0) throw new TypeError("invalid ruleVersion");
  if (typeof generatorVersion !== "string" || generatorVersion.length === 0) throw new TypeError("invalid generatorVersion");
  return sha256Sync(canonicalIdentity(ruleVersion, generatorVersion, suitMode, canonicalizeSeed(seed)));
}

export async function computeDealId(
  seed,
  suitMode,
  ruleVersion = RULE_VERSION,
  generatorVersion = GENERATOR_VERSION,
) {
  return computeDealIdSync(seed, suitMode, ruleVersion, generatorVersion);
}

function initialDealCanonicalValue(state) {
  const allCards = [
    ...state.tableau.flat(),
    ...state.stock.flat(),
    ...state.completed.flatMap((set) => set.cards),
  ];
  const cardOrder = allCards.map(({ id, rank, suit }) => `${id},${rank},${suit}`).join(";");
  const faceUpMask = allCards.map((card) => (card.faceUp ? "1" : "0")).join("");
  const tableauBoundaries = state.tableau.map((column) => column.length).join(",");
  const stockBoundaries = state.stock.map((round) => round.length).join(",");
  return [
    "initialDealSchema=1",
    `cardOrder=${cardOrder}`,
    `faceUpMask=${faceUpMask}`,
    `tableauBoundaries=${tableauBoundaries}`,
    `stockBoundaries=${stockBoundaries}`,
  ].join("\n");
}

export async function computeInitialDealHash(state) {
  return computeInitialDealHashSync(state);
}

export function computeInitialDealHashSync(state) {
  if (!state || !Array.isArray(state.tableau) || !Array.isArray(state.stock) || !Array.isArray(state.completed)) {
    throw new TypeError("invalid game state");
  }
  const initial = state.initialSnapshot ?? state;
  return sha256Sync(initialDealCanonicalValue(initial));
}
