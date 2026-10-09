import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideScheduleHeadroom,
  formatScheduleHeadroomRefusal,
  NOMINAL_SLOT_MILLIS,
  SCHEDULE_HEADROOM_MARGIN_SLOTS,
  SCHEDULE_CHANGED_IN_FLIGHT,
  sameScheduleParameters,
  slotsRemainingInEpoch,
  slotsToMinutes,
  type EpochPosition,
} from "./schedule-headroom.js";
import type { TransferFeeConfig } from "./transfer-fee-split.js";
const SLOTS_IN_EPOCH = 432_000n;
const EM_DASH = String.fromCharCode(0x2014);
function at(epoch: bigint, slotsRemaining: bigint): EpochPosition {
  return { epoch, slotIndex: SLOTS_IN_EPOCH - slotsRemaining, slotsInEpoch: SLOTS_IN_EPOCH };
}
function config(older: [bigint, bigint, number], newer: [bigint, bigint, number]): TransferFeeConfig {
  return {
    older: { epoch: older[0], maximumFee: older[1], basisPoints: older[2] },
    newer: { epoch: newer[0], maximumFee: newer[1], basisPoints: newer[2] },
  };
}
// The frozen devnet fixture's schedules: older 1102 / 0 / 0, newer 1105 /
// 1_000_000 / 100.
const FIXTURE = config([1102n, 0n, 0], [1105n, 1_000_000n, 100]);
test("schedule headroom: two schedules are the same only when rate AND cap agree, whatever their epochs or this amount's fee", () => {
  const older = { epoch: 0n, maximumFee: 1_000_000n, basisPoints: 100 };
  const newer = { epoch: 1_200n, maximumFee: 500_000n, basisPoints: 25 };
  // zero amount, zero fee under both, still not the same: the proof carries the
  // parameters
  assert.equal(sameScheduleParameters(older, newer), false);
  assert.equal(sameScheduleParameters(older, { ...older, basisPoints: 25 }), false);
  assert.equal(sameScheduleParameters(older, { ...older, maximumFee: 500_000n }), false);
  assert.equal(sameScheduleParameters(newer, { ...newer, epoch: 0n }), true);
});

test("schedule headroom: the margin of record is 1,000 slots", () => {
  assert.equal(SCHEDULE_HEADROOM_MARGIN_SLOTS, 1_000n);
  assert.equal(NOMINAL_SLOT_MILLIS, 400);
});
test("schedule headroom: equal parameters are in force whatever the epoch, even with one slot left", () => {
  const zero = config([1102n, 0n, 0], [1105n, 0n, 0]);
  assert.deepEqual(decideScheduleHeadroom(zero, at(1104n, 1n)), {
    kind: "in-force",
    schedule: zero.newer,
    reason: "parameters-agree",
  });
});
test("schedule headroom: the fixture at epoch 1152 is in force under newer; differing parameters alone raise no race", () => {
  assert.deepEqual(decideScheduleHeadroom(FIXTURE, at(1152n, 1n)), {
    kind: "in-force",
    schedule: FIXTURE.newer,
    reason: "newer-applies",
  });
});
test("schedule headroom: newer at the current epoch exactly is in force under newer", () => {
  assert.equal(decideScheduleHeadroom(FIXTURE, at(1105n, 1n)).kind, "in-force");
});
test("schedule headroom: a change at the next epoch with 5,000 slots left is clear under older", () => {
  assert.deepEqual(decideScheduleHeadroom(FIXTURE, at(1104n, 5_000n)), {
    kind: "clear",
    schedule: FIXTURE.older,
    slotsRemaining: 5_000n,
    changeAtEpoch: 1105n,
  });
});
test("schedule headroom: a change at the next epoch with 999 slots left is refused", () => {
  assert.deepEqual(decideScheduleHeadroom(FIXTURE, at(1104n, 999n)), {
    kind: "refuse",
    slotsRemaining: 999n,
    changeAtEpoch: 1105n,
  });
});
test("schedule headroom: exactly 1,000 slots left is clear, the margin is FEWER than", () => {
  assert.equal(decideScheduleHeadroom(FIXTURE, at(1104n, 1_000n)).kind, "clear");
});
test("schedule headroom: a change two epochs ahead is clear under older even with 10 slots left", () => {
  const result = decideScheduleHeadroom(FIXTURE, at(1103n, 10n));
  assert.equal(result.kind, "clear");
  assert.equal(result.kind === "clear" && result.schedule, FIXTURE.older);
});
test("schedule headroom: a stated margin overrides the default", () => {
  assert.equal(decideScheduleHeadroom(FIXTURE, at(1104n, 999n), 500n).kind, "clear");
  assert.equal(decideScheduleHeadroom(FIXTURE, at(1104n, 499n), 500n).kind, "refuse");
  assert.throws(() => decideScheduleHeadroom(FIXTURE, at(1104n, 999n), -1n), /must be non-negative/);
});
test("schedule headroom: a position outside its epoch is refused by name", () => {
  assert.equal(slotsRemainingInEpoch({ epoch: 1n, slotIndex: 0n, slotsInEpoch: 432_000n }), 432_000n);
  assert.throws(
    () => slotsRemainingInEpoch({ epoch: 1n, slotIndex: 432_000n, slotsInEpoch: 432_000n }),
    /slotIndex 432000 must lie below slotsInEpoch 432000/,
  );
  assert.throws(() => slotsRemainingInEpoch({ epoch: 1n, slotIndex: 5n, slotsInEpoch: 0n }), /out of range/);
});
test("schedule headroom: slots to minutes rounds up and never reads below one", () => {
  assert.equal(slotsToMinutes(999n, 400), 7);
  assert.equal(slotsToMinutes(150n, 400), 1);
  assert.equal(slotsToMinutes(1n, 400), 1);
  assert.equal(slotsToMinutes(0n, 400), 1);
  assert.equal(slotsToMinutes(1_000n, 400), 7);
  assert.equal(slotsToMinutes(900n, 400), 6);
  assert.throws(() => slotsToMinutes(-1n, 400), /non-negative/);
  assert.throws(() => slotsToMinutes(10n, 0), /positive number of milliseconds/);
});
test("schedule headroom: the refusal copy is the sentence of record", () => {
  assert.equal(
    formatScheduleHeadroomRefusal({ slotsRemaining: 999n, slotMillis: 400 }),
    "REFUSED " + EM_DASH + " This transfer can't be processed right now as a fee change is taking effect. Try again in about 7 minutes (999 slots). Nothing was sent and no fee was paid.",
  );
  assert.equal(
    formatScheduleHeadroomRefusal({ slotsRemaining: 60n, slotMillis: 400 }),
    "REFUSED " + EM_DASH + " This transfer can't be processed right now as a fee change is taking effect. Try again in about 1 minute (60 slots). Nothing was sent and no fee was paid.",
  );
});
test("schedule headroom: the after-miss copy is of record", () => {
  assert.equal(SCHEDULE_CHANGED_IN_FLIGHT, "The fee changed while this transfer was in flight. Nothing was moved. Try again.");
});
