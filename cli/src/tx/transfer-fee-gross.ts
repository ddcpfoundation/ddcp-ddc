// The INVERSE of the transfer fee split -- the gross amount a stated NET
// implies (the figure a sender enters is what the recipient
// receives; the fee is added on top and the sender's confidential balance is
// debited by the sum). Pure: no network, no keys, whole-number arithmetic
// only, on the amount.ts rule against floating point. The forward split in
// transfer-fee-split.ts is unchanged and remains the arithmetic of record;
// this module only searches over it, so the figures the proofs are built
// over are always the forward split's own.
//
// WHY A SEARCH AND NOT A FORMULA. Under one schedule the net is
// 'net(g) = g - min(ceil(g * bps / 10000), maximumFee)'. Off the cap that is
// 'floor(g * (10000 - bps) / 10000)', which inverts in closed form; on the
// cap it is 'g - maximumFee'; and the two regions meet at a boundary where
// the closed form of one is wrong for the other. The three facts the search
// rests on, each following from the forward split as coded:
//   1. net(g) never decreases as g rises by one base unit, and rises by at
//      most one: off the cap the floor of a slope at most 1 steps by 0 or 1;
//      on the cap it steps by exactly 1; crossing INTO the cap it rises by
//      at most 1, because the uncapped fee just below the boundary is at
//      most maximumFee. So every net from 1 upward is reached EXACTLY, and
//      the smallest gross reaching it is well defined.
//   2. 'g = net + maximumFee' always satisfies 'net(g) >= net', because the
//      fee never exceeds the cap; so the answer lies in [net, net + cap].
//   3. Two grosses can share one net (100 bps: 100 and 101 both net 99, the
//      fee ceiling absorbing the extra unit). The SMALLEST is returned: the
//      sender pays no more than the schedule requires.
// A bisection over that interval, judged by the forward split itself, is
// exact, terminates in at most ~64 steps for any u64 cap, and cannot drift
// from the arithmetic the program recomputes. The result is re-split forward
// and the net is asserted equal to the stated net before returning.
//
// A ZERO NET IS REFUSED on both paths: the recipient would receive nothing.
//
// TWO INVERSES, ONE SEARCH. The bisection is the same either way, so it lives
// once in 'smallestGross' and is judged by 'computeTransferFee', the fee
// arithmetic both paths share. What differs is the BOUND on the gross and the
// shape returned. 'grossForNet' is the CONFIDENTIAL inverse: the gross is the
// amount proven, so the 48-bit bound applies to it and the result carries the
// forward SPLIT, delta and all, for the proofs to be built over.
// 'grossForNetPublic' is the public inverse: nothing is proven, the only
// bound is the one the chain's u64 imposes, and the result carries the fee
// AMOUNTS alone. The two refusals are worded apart on purpose -- a public
// refusal must never name a proof the path does not build -- and the two
// result fields are named apart so that handing one path's result to the
// other is a type error rather than a silent field.
import {
  computeTransferFee,
  PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS,
  splitTransferFee,
  TRANSFER_AMOUNT_MAX_BASE_UNITS,
  type TransferFeeAmounts,
  type TransferFeeSchedule,
  type TransferFeeSplit,
} from "./transfer-fee-split.js";

/** The gross the net implies, and the forward split at that gross (CONFIDENTIAL). */
export interface GrossForNet {
  /** Base units debited from the sender: the net plus the fee. */
  grossBaseUnits: bigint;
  /** The forward split at 'grossBaseUnits'; its 'netTransferAmount' equals the stated net. */
  split: TransferFeeSplit;
}

/** The gross the net implies, and the fee amounts at that gross (PUBLIC). */
export interface GrossForNetPublic {
  /** Base units debited from the sender: the net plus the fee. */
  grossBaseUnits: bigint;
  /** The fee arithmetic at 'grossBaseUnits'; its 'netTransferAmount' equals the stated net. */
  amounts: TransferFeeAmounts;
}

/** The refusal both inverses share: a net of zero or less leaves the recipient nothing. */
function requirePositiveNet(netBaseUnits: bigint): void {
  if (netBaseUnits <= 0n) {
    throw new Error("the recipient must receive at least 1 base unit, got " + netBaseUnits);
  }
}

/**
 * The smallest gross in [net, upper] whose net is at or above 'netBaseUnits',
 * by bisection over the shared fee arithmetic (fact 1 makes the predicate
 * monotone; fact 2 makes 'upper' satisfy it). The caller checks its own bound
 * on 'upper' first and re-derives the result forward afterwards.
 */
function smallestGross(netBaseUnits: bigint, schedule: TransferFeeSchedule, upper: bigint): bigint {
  let lo = netBaseUnits;
  let hi = upper;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (computeTransferFee(mid, schedule).netTransferAmount >= netBaseUnits) {
      hi = mid;
    } else {
      lo = mid + 1n;
    }
  }
  return lo;
}

/** The refusal both inverses share when no gross yields the stated net exactly. */
function noExactGross(netBaseUnits: bigint, gross: bigint, net: bigint): Error {
  return new Error(
    "no gross yields a net of exactly " + netBaseUnits + " base units under this schedule (nearest gross " + gross +
      " nets " + net + ")",
  );
}

/**
 * CONFIDENTIAL: the smallest gross whose net under 'schedule' equals
 * 'netBaseUnits'. Throws on a non-positive net, on a schedule the forward
 * split refuses, and on a net whose gross would exceed the 48-bit bound.
 */
export function grossForNet(netBaseUnits: bigint, schedule: TransferFeeSchedule): GrossForNet {
  requirePositiveNet(netBaseUnits);
  // Upper end of the interval, always sufficient (fact 2). Checked against
  // the bound BEFORE any split so the refusal names the sender's figure.
  const upper = netBaseUnits + schedule.maximumFee;
  if (upper > TRANSFER_AMOUNT_MAX_BASE_UNITS) {
    throw new Error(
      "refusing to transfer " + netBaseUnits + " base units to the recipient: with the fee added, one confidential transfer carries at most " +
        TRANSFER_AMOUNT_MAX_BASE_UNITS + " base units (the amount is proven in 48 bits)",
    );
  }
  const grossBaseUnits = smallestGross(netBaseUnits, schedule, upper);
  const split = splitTransferFee(grossBaseUnits, schedule);
  if (split.netTransferAmount !== netBaseUnits) {
    throw noExactGross(netBaseUnits, grossBaseUnits, split.netTransferAmount);
  }
  return { grossBaseUnits, split };
}

/**
 * PUBLIC: the smallest gross whose net under 'schedule' equals
 * 'netBaseUnits'. Throws on a non-positive net, on a schedule the fee
 * arithmetic refuses, and on a net whose gross would exceed the largest
 * amount one transfer can carry. NAMES NO PROOF: this path builds none.
 */
export function grossForNetPublic(netBaseUnits: bigint, schedule: TransferFeeSchedule): GrossForNetPublic {
  requirePositiveNet(netBaseUnits);
  const upper = netBaseUnits + schedule.maximumFee;
  if (upper > PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS) {
    throw new Error(
      "refusing to transfer " + netBaseUnits + " base units to the recipient: with the fee added, one transfer carries at most " +
        PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS + " base units",
    );
  }
  const grossBaseUnits = smallestGross(netBaseUnits, schedule, upper);
  const amounts = computeTransferFee(grossBaseUnits, schedule);
  if (amounts.netTransferAmount !== netBaseUnits) {
    throw noExactGross(netBaseUnits, grossBaseUnits, amounts.netTransferAmount);
  }
  return { grossBaseUnits, amounts };
}
