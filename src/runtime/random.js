import { RuntimeDataError } from "./errors.js";

const UINT32_RANGE = 0x1_0000_0000;

export function requireCrypto(cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider || typeof cryptoProvider.getRandomValues !== "function") {
    throw new RuntimeDataError("CRYPTO_UNAVAILABLE", "A cryptographic random source is required");
  }
  return cryptoProvider;
}

export function randomUintBelow(maxExclusive, cryptoProvider = globalThis.crypto) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError("maxExclusive must be an integer from 1 through 2^32");
  }
  const crypto = requireCrypto(cryptoProvider);
  const sample = new Uint32Array(1);
  if (maxExclusive === UINT32_RANGE) {
    crypto.getRandomValues(sample);
    return sample[0];
  }
  const acceptanceLimit = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive;
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= acceptanceLimit);
  return sample[0] % maxExclusive;
}

export function chooseCrypto(items, cryptoProvider = globalThis.crypto) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError("Cannot choose from an empty collection");
  }
  return items[randomUintBelow(items.length, cryptoProvider)];
}

export function createRuntimeId(prefix = "id", cryptoProvider = globalThis.crypto) {
  const crypto = requireCrypto(cryptoProvider);
  if (typeof crypto.randomUUID === "function") return `${prefix}:${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${prefix}:${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

