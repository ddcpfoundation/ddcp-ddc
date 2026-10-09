// Vectors of record for grossForNet -- each derived by hand from the forward
// split's own rule (fee = ceil(gross * bps / 10000), capped on a strict
// excess) and checked back through it here. The live devnet schedule
// (100 bps, cap 1,000,000 base units) is the one the first devnet transfer
// proves under.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grossForNet, grossForNetPublic } from "./transfer-fee-gross.js";
import {
  PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS,
  TRANSFER_AMOUNT_MAX_BASE_UNITS,
  computeTransferFee,
  splitTransferFee,
  type TransferFeeSchedule,
} from "./transfer-fee-split.js";

const ZERO: TransferFeeSchedule = { epoch: 0n, maximumFee: 0n, basisPoints: 0 };
const DEVNET: TransferFeeSchedule = { epoch: 1108n, maximumFee: 1_000_000n, basisPoints: 100 };
const FULL_RATE: TransferFeeSchedule = { epoch: 0n, maximumFee: 5n, basisPoints: 10_000 };

function check(net: bigint, schedule: TransferFeeSchedule, expectedGross: bigint, expectedFee: bigint, capped: boolean) {
  const result = grossForNet(net, schedule);
  assert.equal(result.grossBaseUnits, expectedGross);
  assert.equal(result.split.feeAmount, expectedFee);
  assert.equal(result.split.netTransferAmount, net);
  assert.equal(result.split.capped, capped);
  // The forward split at the returned gross is the split returned.
  assert.deepEqual(result.split, splitTransferFee(expectedGross, schedule));
}

test("grossForNet: zero schedule, gross equals net", () => {
  check(1n, ZERO, 1n, 0n, false);
  check(100_000_000n, ZERO, 100_000_000n, 0n, false);
});

test("grossForNet: devnet schedule, 1 base unit nets from a gross of 2", () => {
  // net(1) = 1 - ceil(0.01) = 0; net(2) = 2 - 1 = 1.
  check(1n, DEVNET, 2n, 1n, false);
});

test("grossForNet: devnet schedule, the SMALLEST of two grosses sharing a net", () => {
  // net(100) = 100 - 1 = 99 and net(101) = 101 - 2 = 99; 100 is returned.
  check(99n, DEVNET, 100n, 1n, false);
  assert.equal(splitTransferFee(101n, DEVNET).netTransferAmount, 99n);
});

test("grossForNet: devnet schedule, 99 DDC nets exactly at the cap boundary, uncapped", () => {
  // gross 100,000,000: fee ceil(1,000,000.00) = 1,000,000, not above the cap.
  check(99_000_000n, DEVNET, 100_000_000n, 1_000_000n, false);
});

test("grossForNet: devnet schedule, one base unit past the boundary is capped", () => {
  // gross 100,000,001: raw fee 1,000,001 exceeds the cap; fee is the cap.
  check(99_000_001n, DEVNET, 100_000_001n, 1_000_000n, true);
});

test("grossForNet: devnet schedule, 100 DDC to the recipient debits 101 DDC", () => {
  check(100_000_000n, DEVNET, 101_000_000n, 1_000_000n, true);
});

test("grossForNet: full rate with a cap, gross is net plus the cap", () => {
  // 10,000 bps: the uncapped net is always 0, so only the cap branch nets.
  check(7n, FULL_RATE, 12n, 5n, true);
});

test("grossForNet: a non-positive net is refused by name", () => {
  assert.throws(() => grossForNet(0n, DEVNET), /at least 1 base unit/);
  assert.throws(() => grossForNet(-1n, DEVNET), /at least 1 base unit/);
});

test("grossForNet: a net whose gross would exceed the 48-bit bound is refused by name", () => {
  assert.throws(() => grossForNet(TRANSFER_AMOUNT_MAX_BASE_UNITS, DEVNET), /proven in 48 bits/);
  // The bound itself is reachable under the zero schedule.
  check(TRANSFER_AMOUNT_MAX_BASE_UNITS, ZERO, TRANSFER_AMOUNT_MAX_BASE_UNITS, 0n, false);
});

test("grossForNet: exhaustive agreement with the forward split on the devnet schedule", () => {
  // For every gross in 1..20,000 the forward net, fed back, returns a gross
  // at or below the original with the same net -- the smallest-gross rule.
  for (let gross = 1n; gross <= 20_000n; gross += 1n) {
    const net = splitTransferFee(gross, DEVNET).netTransferAmount;
    if (net === 0n) continue;
    const back = grossForNet(net, DEVNET);
    assert.ok(back.grossBaseUnits <= gross);
    assert.equal(back.split.netTransferAmount, net);
  }
});

// The PUBLIC inverse. Same search, same arithmetic, different bound
// and different shape. These tests pin what makes it a separate entry point
// rather than a flag: the bound it carries, the words its refusal uses, and
// the absence of the claimed delta from what it returns.

test("grossForNetPublic: the same gross and fee as the confidential inverse below the 48-bit bound, with no claimed delta", () => {
  for (const sched of [ZERO, DEVNET, FULL_RATE]) {
    for (const net of [1n, 7n, 99n, 99_000_000n, 100_000_000n]) {
      const pub = grossForNetPublic(net, sched);
      const conf = grossForNet(net, sched);
      assert.equal(pub.grossBaseUnits, conf.grossBaseUnits);
      assert.equal(pub.amounts.feeAmount, conf.split.feeAmount);
      assert.equal(pub.amounts.netTransferAmount, net);
      assert.equal(pub.amounts.capped, conf.split.capped);
      assert.equal(Object.hasOwn(pub.amounts, "claimedDeltaFee"), false);
    }
  }
});

test("grossForNetPublic: reaches past the 48-bit bound where the confidential inverse refuses", () => {
  const beyond = TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n;
  assert.equal(grossForNetPublic(beyond, ZERO).grossBaseUnits, beyond);
  assert.equal(grossForNetPublic(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, ZERO).grossBaseUnits, PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS);
  assert.throws(() => grossForNet(beyond, ZERO), /proven in 48 bits/);
});

test("grossForNetPublic: above the public bound it refuses by name, naming no proof and no confidential path", () => {
  assert.throws(() => grossForNetPublic(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n, ZERO), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^refusing to transfer /);
    assert.match(err.message, /one transfer carries at most 18446744073709551615 base units$/);
    assert.doesNotMatch(err.message, /proof|proven|48|confidential/i);
    return true;
  });
  assert.throws(() => grossForNetPublic(0n, DEVNET), /at least 1 base unit/);
  assert.throws(() => grossForNetPublic(-1n, DEVNET), /at least 1 base unit/);
});

test("grossForNetPublic: exhaustive agreement with the shared fee arithmetic on the devnet schedule", () => {
  for (let gross = 1n; gross <= 20_000n; gross += 1n) {
    const net = computeTransferFee(gross, DEVNET).netTransferAmount;
    if (net === 0n) continue;
    const back = grossForNetPublic(net, DEVNET);
    assert.ok(back.grossBaseUnits <= gross);
    assert.equal(back.amounts.netTransferAmount, net);
  }
});
