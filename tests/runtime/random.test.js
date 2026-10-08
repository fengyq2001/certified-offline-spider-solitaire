import test from "node:test";
import assert from "node:assert/strict";
import { randomUintBelow } from "../../src/runtime/random.js";

test("randomUintBelow rejects the biased tail", () => {
  const values = [0xffff_ffff, 25];
  const crypto = { getRandomValues(target) { target[0] = values.shift(); return target; } };
  assert.equal(randomUintBelow(10, crypto), 5);
  assert.equal(values.length, 0);
});

test("randomUintBelow rejects invalid ranges", () => {
  assert.throws(() => randomUintBelow(0, {}), RangeError);
  assert.throws(() => randomUintBelow(0x1_0000_0001, {}), RangeError);
});

