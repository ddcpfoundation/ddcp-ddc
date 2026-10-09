// The schedule-headroom rule for a confidential transfer with fee. Pure: no network, no
// keys; the epoch position arrives as a parameter read by the caller from
// getEpochInfo, and the mint's two schedules arrive from mint-transfer-fee.ts.
//
// WHY. The with-fee proofs bind ONE schedule's parameters, and the program
// applies whichever schedule is in force when the transaction EXECUTES:
// 'Clock.epoch >= newer.epoch ? newer: older'. A transaction built under one
// schedule and landing after the boundary is rejected atomically, with the
// network fee spent and nothing moved. The race exists only while a change is
// still AHEAD of the current epoch; once 'newer.epoch' is at or below it,
// 'newer' is simply in force and the two schedules cannot switch under the
// transaction. 'parametersAgree' false alone says nothing about pendency:
// 'older' is overwritten only at the NEXT change, so after any change the two
// schedules differ for ever.
//
// THE MARGIN. A blockhash-signed transaction can execute at most ~150 slots
// after its blockhash; 1,000 slots (~0.2% of an epoch) covers that landing
// window several times over. The margin is denominated in SLOTS; its wall
// time follows the cluster's slot time, which is measured, never assumed
// (~164 ms on devnet, so about 2.7 minutes there). The load-bearing
// check runs AFTER the human confirm and BEFORE the blockhash is fetched; a
// courtesy check may run before proof generation so a refusal already known
// does not cost the wait. Both call this same function.
import type { TransferFeeConfig, TransferFeeSchedule } from "./transfer-fee-split.js";
/** The margin of record: refuse when FEWER than this many slots remain and a change lands at the next epoch. */
export const SCHEDULE_HEADROOM_MARGIN_SLOTS = 1_000n;
/**
 * Fallback slot time, used ONLY when the measured figure is unavailable. The
 * historical 400 ms; devnet measured ~164 ms, so on such a cluster
 * the fallback OVERSTATES a wait, which is the safe direction.
 */
export const NOMINAL_SLOT_MILLIS = 400;
/** The three getEpochInfo fields the rule reads. */
export interface EpochPosition {
  epoch: bigint;
  slotIndex: bigint;
  slotsInEpoch: bigint;
}
export type ScheduleHeadroom =
  | {
      /** No race exists: the schedule to prove under is fixed. */
      kind: "in-force";
      schedule: TransferFeeSchedule;
      /** Why: both schedules carry the same parameters, or the newer one already applies. */
      reason: "parameters-agree" | "newer-applies";
    }
  | {
      /** A change is ahead but outside the margin: prove under 'older'. */
      kind: "clear";
      schedule: TransferFeeSchedule;
      slotsRemaining: bigint;
      changeAtEpoch: bigint;
    }
  | {
      /** The change lands at the next epoch and fewer than the margin remain. */
      kind: "refuse";
      slotsRemaining: bigint;
      changeAtEpoch: bigint;
    };
/** Slots left in the current epoch; throws by name on a position outside its epoch. */
export function slotsRemainingInEpoch(position: EpochPosition): bigint {
  if (position.slotIndex < 0n || position.slotsInEpoch <= 0n || position.slotIndex >= position.slotsInEpoch) {
    throw new Error(
      "epoch position out of range: slotIndex " + position.slotIndex + " must lie below slotsInEpoch " + position.slotsInEpoch,
    );
  }
  return position.slotsInEpoch - position.slotIndex;
}
/** The headroom rule. */
export function decideScheduleHeadroom(
  config: TransferFeeConfig,
  position: EpochPosition,
  marginSlots: bigint = SCHEDULE_HEADROOM_MARGIN_SLOTS,
): ScheduleHeadroom {
  const slotsRemaining = slotsRemainingInEpoch(position);
  if (marginSlots < 0n) {
    throw new Error("a headroom margin must be non-negative, got " + marginSlots);
  }
  const parametersAgree = sameScheduleParameters(config.older, config.newer);
  if (parametersAgree) {
    return { kind: "in-force", schedule: config.newer, reason: "parameters-agree" };
  }
  if (config.newer.epoch <= position.epoch) {
    return { kind: "in-force", schedule: config.newer, reason: "newer-applies" };
  }
  const changeAtEpoch = config.newer.epoch;
  if (changeAtEpoch === position.epoch + 1n && slotsRemaining < marginSlots) {
    return { kind: "refuse", slotsRemaining, changeAtEpoch };
  }
  return { kind: "clear", schedule: config.older, slotsRemaining, changeAtEpoch };
}
/**
 * Two schedules are the same for a transaction bound to one iff rate AND cap
 * agree. MOVED here from commands/confidential-transfer.ts unchanged when
 * the public transfer became its second consumer: a public transfer states
 * the fee on the wire, so it is bound to a schedule's parameters exactly as
 * a proof is.
 */
export function sameScheduleParameters(a: TransferFeeSchedule, b: TransferFeeSchedule): boolean {
  return a.basisPoints === b.basisPoints && a.maximumFee === b.maximumFee;
}
/** After a failed send: is the schedule the transaction was bound to still on the mint? */
export function scheduleStillOnMint(proven: TransferFeeSchedule, config: TransferFeeConfig): boolean {
  return sameScheduleParameters(proven, config.older) || sameScheduleParameters(proven, config.newer);
}
/** Whole minutes, rounded up, never below one. */
export function slotsToMinutes(slots: bigint, slotMillis: number): number {
  if (slots < 0n) {
    throw new Error("a slot count must be non-negative, got " + slots);
  }
  if (!Number.isFinite(slotMillis) || slotMillis <= 0) {
    throw new Error("a slot time must be a positive number of milliseconds, got " + slotMillis);
  }
  const minutes = Math.ceil((Number(slots) * slotMillis) / 60_000);
  return minutes < 1 ? 1 : minutes;
}
const EM_DASH = String.fromCharCode(0x2014);
/** Copy of record: the refusal before any send. */
export function formatScheduleHeadroomRefusal(input: { slotsRemaining: bigint; slotMillis: number }): string {
  const minutes = slotsToMinutes(input.slotsRemaining, input.slotMillis);
  return (
    "REFUSED " + EM_DASH + " This transfer can't be processed right now as a fee change is taking effect. " +
    "Try again in about " + minutes + (minutes === 1 ? " minute" : " minutes") + " (" + input.slotsRemaining + " slots). " +
    "Nothing was sent and no fee was paid."
  );
}
/** Copy of record: after a send the program rejected on the fee schedule. */
export const SCHEDULE_CHANGED_IN_FLIGHT =
  "The fee changed while this transfer was in flight. Nothing was moved. Try again.";
