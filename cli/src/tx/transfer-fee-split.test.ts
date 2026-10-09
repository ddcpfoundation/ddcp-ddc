// Tests for the transfer fee split. The vectors are the ARITHMETIC OF RECORD:
// each expected triple was derived from the two references the chain and the
// upstream client apply, read at their pins --
//   Token-2022 interface crate, extension/transfer_fee/mod.rs: calculate_fee
//   (ceil_div of amount * bps by 10000, then min with maximum_fee; 0 when
//   bps or amount is 0) and TransferFeeConfig::get_epoch_fee (newer from its
//   epoch onward, asserted through decideScheduleHeadroom in
//   schedule-headroom.test.ts);
//   @solana-program/token-2022 0.15.0, src/confidentialTransferHelpers.ts
//   lines 500-525: getEpochTransferFee, calculateFee, and
//   calculateTransferWithFeeAmounts, which zeroes the claimed delta only on a
//   STRICT excess over maximumFee.
// Neither function is importable (the TypeScript pair is module-private and
// in no .d.ts), so the table stands in for an oracle. A vector that fails
// here means this module and the chain disagree; do not adjust the table to
// the module.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CLAIMED_DELTA_FEE,
  MAX_FEE_BASIS_POINTS,
  PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS,
  TRANSFER_AMOUNT_MAX_BASE_UNITS,
  computeTransferFee,
  splitTransferFee,
  type TransferFeeSchedule,
} from "./transfer-fee-split.js";

function schedule(basisPoints: number, maximumFee: bigint, epoch = 0n): TransferFeeSchedule {
  return { epoch, maximumFee, basisPoints };
}

test("the constants: 10000 basis points to the whole, delta below 10000, 2^48 - 1 base units per transfer", () => {
  assert.equal(MAX_FEE_BASIS_POINTS, 10_000n);
  assert.equal(MAX_CLAIMED_DELTA_FEE, 9_999n);
  assert.equal(TRANSFER_AMOUNT_MAX_BASE_UNITS, 281_474_976_710_655n);
});

// [amount, bps, maximumFee, feeAmount, claimedDeltaFee, netTransferAmount, capped]
const VECTORS: readonly [bigint, number, bigint, bigint, bigint, bigint, boolean][] = [
  // zero rate, zero cap: the launch configuration; nothing withheld
  [1_000_000n, 0, 0n, 0n, 0n, 1_000_000n, false],
  [1n, 0, 0n, 0n, 0n, 1n, false],
  // zero amount at a real rate: fee 0, delta 0 (the Rust special case and the formula agree)
  [0n, 25, 1_000n, 0n, 0n, 0n, false],
  // the smallest amount at the smallest rate: fee rounds UP to 1, delta at its maximum
  [1n, 1, 1_000n, 1n, 9_999n, 0n, false],
  // just below and exactly at one whole fee unit
  [9_999n, 1, 1_000n, 1n, 1n, 9_998n, false],
  [10_000n, 1, 1_000n, 1n, 0n, 9_999n, false],
  // 0.25% of 1 DDC is 2500 base units: capped at 1000, exactly at the cap, and capped by one
  [1_000_000n, 25, 1_000n, 1_000n, 0n, 999_000n, true],
  [1_000_000n, 25, 2_500n, 2_500n, 0n, 997_500n, false],
  [1_000_000n, 25, 2_499n, 2_499n, 0n, 997_501n, true],
  // a fee that rounds, then is capped away
  [123_456_789n, 37, 5_000n, 5_000n, 0n, 123_451_789n, true],
  // an uncapped fee that rounds: 123456789 * 37 = 4567901193; ceil / 10000 = 456791; delta 8807
  [123_456_789n, 37, 1_000_000n, 456_791n, 8_807n, 122_999_998n, false],
  // the whole amount as fee, at the 48-bit bound
  [281_474_976_710_655n, 10_000, 18_446_744_073_709_551_615n, 281_474_976_710_655n, 0n, 0n, false],
];

test("splitTransferFee: the vector table of record", () => {
  for (const [amount, bps, maximumFee, feeAmount, claimedDeltaFee, netTransferAmount, capped] of VECTORS) {
    const split = splitTransferFee(amount, schedule(bps, maximumFee));
    assert.deepEqual(split, { feeAmount, claimedDeltaFee, netTransferAmount, capped }, "vector " + amount + "/" + bps + "/" + maximumFee);
    // the identities the chain enforces: delta in range, fee never above amount, amount conserved
    assert.ok(split.claimedDeltaFee >= 0n && split.claimedDeltaFee <= MAX_CLAIMED_DELTA_FEE);
    assert.ok(split.feeAmount <= amount);
    assert.equal(split.feeAmount + split.netTransferAmount, amount);
    if (!split.capped) {
      assert.equal(split.feeAmount * MAX_FEE_BASIS_POINTS - amount * BigInt(bps), split.claimedDeltaFee);
    }
  }
});

test("splitTransferFee: refusals -- negative amount, above the 48-bit bound, rate outside 0..10000, negative cap", () => {
  assert.throws(() => splitTransferFee(-1n, schedule(0, 0n)), /must be non-negative/);
  assert.throws(() => splitTransferFee(TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n, schedule(0, 0n)), /at most 281474976710655 base units/);
  assert.equal(splitTransferFee(TRANSFER_AMOUNT_MAX_BASE_UNITS, schedule(0, 0n)).netTransferAmount, TRANSFER_AMOUNT_MAX_BASE_UNITS);
  assert.throws(() => splitTransferFee(1n, schedule(10_001, 0n)), /basis points in 0..10000/);
  assert.throws(() => splitTransferFee(1n, schedule(-1, 0n)), /basis points in 0..10000/);
  assert.throws(() => splitTransferFee(1n, schedule(1.5, 0n)), /basis points in 0..10000/);
  assert.throws(() => splitTransferFee(1n, schedule(1, -1n)), /maximum fee must be non-negative/);
});

// The core and the confidential wrapper. The vectors above are the
// oracle for BOTH: the core must reproduce every fee, net and cap branch in
// the table, and the wrapper must add the delta and the 48-bit bound and
// nothing else. A core that drifted from the table would be caught here
// before any public caller existed.

test("computeTransferFee: the vector table of record, fee, net and cap branch, with no claimed delta", () => {
  for (const [amount, bps, maximumFee, feeAmount, , netTransferAmount, capped] of VECTORS) {
    const amounts = computeTransferFee(amount, schedule(bps, maximumFee));
    assert.deepEqual(amounts, { feeAmount, netTransferAmount, capped }, "vector " + amount + "/" + bps + "/" + maximumFee);
    assert.equal(Object.hasOwn(amounts, "claimedDeltaFee"), false);
    assert.equal(amounts.feeAmount + amounts.netTransferAmount, amount);
  }
});

test("computeTransferFee: the three schedule refusals of the split, word for word, and NO amount bound", () => {
  assert.throws(() => computeTransferFee(-1n, schedule(0, 0n)), /must be non-negative/);
  assert.throws(() => computeTransferFee(1n, schedule(10_001, 0n)), /basis points in 0..10000/);
  assert.throws(() => computeTransferFee(1n, schedule(-1, 0n)), /basis points in 0..10000/);
  assert.throws(() => computeTransferFee(1n, schedule(1.5, 0n)), /basis points in 0..10000/);
  assert.throws(() => computeTransferFee(1n, schedule(1, -1n)), /maximum fee must be non-negative/);
  // The bound belongs to the caller, not the arithmetic: the core carries none.
  const above = TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n;
  assert.equal(computeTransferFee(above, schedule(0, 0n)).netTransferAmount, above);
  assert.equal(computeTransferFee(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, schedule(0, 0n)).netTransferAmount, PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS);
  assert.throws(() => splitTransferFee(above, schedule(0, 0n)), /proven in 48 bits/);
});

test("the public bound: 2^64 - 1 base units, above the confidential bound, and never named by the confidential refusal", () => {
  assert.equal(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, 18_446_744_073_709_551_615n);
  assert.equal(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, (1n << 64n) - 1n);
  assert.ok(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS > TRANSFER_AMOUNT_MAX_BASE_UNITS);
  assert.throws(() => splitTransferFee(TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n, schedule(0, 0n)), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.doesNotMatch(err.message, new RegExp(String(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS)));
    return true;
  });
});

test("splitTransferFee: the claimed delta is derived from the core's own fee on every uncapped vector", () => {
  for (const [amount, bps, maximumFee] of VECTORS) {
    const sched = schedule(bps, maximumFee);
    const core = computeTransferFee(amount, sched);
    const split = splitTransferFee(amount, sched);
    assert.equal(split.feeAmount, core.feeAmount);
    assert.equal(split.netTransferAmount, core.netTransferAmount);
    assert.equal(split.capped, core.capped);
    assert.equal(split.claimedDeltaFee, core.capped ? 0n : core.feeAmount * MAX_FEE_BASIS_POINTS - amount * BigInt(bps));
  }
});
