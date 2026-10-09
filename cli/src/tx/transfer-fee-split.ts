// The 'transfer' fee split -- the three quantities a confidential transfer
// with fee must compute BEFORE any proof exists, in the arithmetic Token-2022
// itself applies. Pure:
// no network, no keys, whole-number arithmetic only, on the amount.ts rule
// against floating point. Nothing here is importable from the pinned
// @solana-program/token-2022 0.15.0: its 'calculateTransferWithFeeAmounts'
// and 'getEpochTransferFee' are module-private helpers of the '/confidential'
// entry and appear in no '.d.ts', so this build carries the arithmetic and
// pins it by test vectors (the sibling test names the lines of record).
//
// WHAT THE CHAIN RECOMPUTES. The program does not trust any of these figures;
// it re-derives them from the mint at EXECUTION time and rejects a mismatch:
//   - the schedule: 'Clock.epoch >= newer.epoch ? newer : older', read off
//     the mint's TransferFeeConfig when the transaction runs, not when it is
//     built -- which schedule a command may build against is the headroom
//     rule of tx/schedule-headroom.ts;
//   - the cap: the percentage-with-cap proof carries 'maximumFee' and the
//     program compares it to the schedule's (FeeParametersMismatch);
//   - the delta: 'fee * 10000 - amount * basisPoints', recomputed as a
//     commitment from the schedule's basis points (CurveArithmetic on
//     mismatch) and range-proven in [0, 9999] through two 16-bit slots,
//     'claimed' and '9999 - claimed'.
// The only figure the chain cannot see and cannot recompute is the fee
// itself; the proof is what binds it to the arithmetic above.
//
// THE FEE. 'fee = ceil(amount * basisPoints / 10000)'; the rounding is UP, so
// 'delta' is the shortfall of 'amount * basisPoints' below 'fee * 10000', a
// value in 0..9999 by construction. When 'fee' would exceed the schedule's
// 'maximumFee', the fee IS the maximum and the claimed delta is stated as 0:
// the proof then attests the cap branch and the delta branch is not
// exercised. At the cap EXACTLY (raw fee equal to the maximum) the raw
// figures stand, including their delta -- the cap branch is entered only on a
// strict excess, matching both the Rust reference and upstream TypeScript.
//
// THE 48-BIT BOUND is this build's own guard, absent upstream: a transfer
// amount is proven as a 16-bit low half and a 32-bit high half, so anything
// above 2^48 - 1 base units produces a range proof the program rejects at
// verification. Upstream asserts only u64 and lets the doomed transaction be
// built; here the bound is refused by name at the shape stage. In DDC that
// is 281,474,976.710655 -- the figure amount.test.ts already round-trips.
//
// THE CORE AND ITS WRAPPERS. 'computeTransferFee' is the fee arithmetic alone
// -- Token-2022's calculate_fee, which the program applies to
// TransferCheckedWithFee and to the confidential path alike -- and it carries
// NO amount bound and NO claimed delta. 'splitTransferFee' is the
// CONFIDENTIAL wrapper: it adds the 48-bit refusal above and the claimed
// delta the with-fee proofs are built over, and remains the only entry point
// the proof path uses. A PUBLIC transfer proves nothing, so it calls the core
// and bounds its own amount by the chain's u64; a refusal on that path must
// never name a proof it does not build.

/** One basis point is one ten-thousandth; a whole is 10,000 of them. */
export const MAX_FEE_BASIS_POINTS = 10_000n;

/** The largest claimed delta: 'fee * 10000 - amount * bps' never reaches 10000. */
export const MAX_CLAIMED_DELTA_FEE = MAX_FEE_BASIS_POINTS - 1n;

/** Bit widths of the two halves a transfer amount (and a fee) is proven in. */
export const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;
export const TRANSFER_AMOUNT_HI_BIT_LENGTH = 32n;

/** The largest amount one confidential transfer can carry: 2^48 - 1 base units. */
export const TRANSFER_AMOUNT_MAX_BASE_UNITS =
  (1n << (TRANSFER_AMOUNT_LO_BIT_LENGTH + TRANSFER_AMOUNT_HI_BIT_LENGTH)) - 1n;

/** The largest amount a PUBLIC transfer can carry: the chain's u64, the only bound TransferCheckedWithFee imposes. */
export const PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS = (1n << 64n) - 1n;

/** One fee schedule as the mint carries it: in force from 'epoch' onward. */
export interface TransferFeeSchedule {
  /** First epoch at which this schedule applies. */
  epoch: bigint;
  /** Fee ceiling in base units. */
  maximumFee: bigint;
  /** Fee rate in basis points, 0..10000. */
  basisPoints: number;
}

/** The mint's two schedules; 'newer' applies from its epoch, 'older' before it. */
export interface TransferFeeConfig {
  older: TransferFeeSchedule;
  newer: TransferFeeSchedule;
}

/** The fee arithmetic alone, shared by both paths: no claimed delta, no amount bound. */
export interface TransferFeeAmounts {
  /** Base units withheld as fee. */
  feeAmount: bigint;
  /** Base units the destination receives: 'amount - fee'. */
  netTransferAmount: bigint;
  /** True when the raw percentage fee exceeded 'maximumFee' and was replaced by it. */
  capped: boolean;
}

/** The three quantities the with-fee proofs are built over: the core's, plus the delta. */
export interface TransferFeeSplit extends TransferFeeAmounts {
  /** 'fee * 10000 - amount * bps' when uncapped; 0 when capped. */
  claimedDeltaFee: bigint;
}

/**
 * The fee, the net and the cap branch under one schedule -- the arithmetic
 * Token-2022 applies to ANY transfer with a fee, public or confidential.
 * Throws on a negative amount, a rate outside 0..10000, or a negative cap.
 * Carries NO upper bound on the amount: each path states the bound its own
 * instruction imposes, and neither bound belongs to the arithmetic.
 */
export function computeTransferFee(amountBaseUnits: bigint, schedule: TransferFeeSchedule): TransferFeeAmounts {
  if (amountBaseUnits < 0n) {
    throw new Error('a transfer amount must be non-negative, got ' + amountBaseUnits);
  }
  if (!Number.isInteger(schedule.basisPoints) || schedule.basisPoints < 0 || schedule.basisPoints > Number(MAX_FEE_BASIS_POINTS)) {
    throw new Error('a fee rate must be a whole number of basis points in 0..' + MAX_FEE_BASIS_POINTS + ', got ' + schedule.basisPoints);
  }
  if (schedule.maximumFee < 0n) {
    throw new Error('a maximum fee must be non-negative, got ' + schedule.maximumFee);
  }
  const rawFee = (amountBaseUnits * BigInt(schedule.basisPoints) + MAX_FEE_BASIS_POINTS - 1n) / MAX_FEE_BASIS_POINTS;
  const capped = schedule.maximumFee < rawFee;
  const feeAmount = capped ? schedule.maximumFee : rawFee;
  return { feeAmount, netTransferAmount: amountBaseUnits - feeAmount, capped };
}

/**
 * The CONFIDENTIAL split of 'amountBaseUnits' under one schedule: the core
 * above, plus the 48-bit bound and the claimed delta the with-fee proofs are
 * built over. Throws on a negative amount, an amount above the 48-bit bound,
 * or a rate outside 0..10000; never rounds anything but the fee, and that
 * only upward.
 */
export function splitTransferFee(amountBaseUnits: bigint, schedule: TransferFeeSchedule): TransferFeeSplit {
  if (amountBaseUnits > TRANSFER_AMOUNT_MAX_BASE_UNITS) {
    throw new Error(
      'refusing to transfer ' + amountBaseUnits + ' base units: one confidential transfer carries at most ' +
        TRANSFER_AMOUNT_MAX_BASE_UNITS + ' base units (the amount is proven in 48 bits)',
    );
  }
  const { feeAmount, netTransferAmount, capped } = computeTransferFee(amountBaseUnits, schedule);
  // The delta is the shortfall the proof commits to, recomputed from the fee
  // the core returned rather than carried out of it -- the identity the
  // sibling test asserts on every uncapped vector.
  const claimedDeltaFee = capped ? 0n : feeAmount * MAX_FEE_BASIS_POINTS - amountBaseUnits * BigInt(schedule.basisPoints);
  return { feeAmount, claimedDeltaFee, netTransferAmount, capped };
}
