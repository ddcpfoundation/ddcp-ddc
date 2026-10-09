// Pins formatSolAmount: trailing zeros trimmed, never fixed places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSolAmount } from "./sol-amount.js";

test("sol-amount: the rent figure of record, 1,574,800 lamports, renders as 0.0015748, and the superseded 1,554,480 as 0.00155448", () => {
  assert.equal(formatSolAmount(1_574_800n), "0.0015748");
  assert.equal(formatSolAmount(1_554_480n), "0.00155448");
});

test("sol-amount: trailing zeros are trimmed, whole SOL carries no point, one lamport keeps nine places, and a negative is refused", () => {
  assert.equal(formatSolAmount(0n), "0");
  assert.equal(formatSolAmount(1n), "0.000000001");
  assert.equal(formatSolAmount(1_000_000_000n), "1");
  assert.equal(formatSolAmount(1_500_000_000n), "1.5");
  assert.equal(formatSolAmount(3_439_160n), "0.00343916");
  assert.throws(() => formatSolAmount(-1n), /non-negative/);
});
