// The genesis-settled fee ceilings of PDA-1 (fee_ceiling_basis_points,
// fee_ceiling_base_units), judged client-side before an I-6 update-fee
// transaction is built, in the program's own order: rate first, then maximum.
// The program refuses the same cases on-chain (FeeAboveCeiling 6008,
// MaximumFeeAboveCeiling 6009); this check exists so the refusal is a
// sentence at the serialize step rather than a code after a countersign.

import { formatDdcAmount } from "./amount.js";

const EM_DASH = String.fromCharCode(0x2014);

export interface FeeCeilingInput {
  readonly newFeeBasisPoints: number;
  readonly newMaximumFee: bigint;
  readonly feeCeilingBasisPoints: number;
  readonly feeCeilingBaseUnits: bigint;
}

export function formatRateAboveCeilingRefusal(input: { newFeeBasisPoints: number; feeCeilingBasisPoints: number }): string {
  return (
    "REFUSED " + EM_DASH + " the requested rate (" + input.newFeeBasisPoints + " bps) is above the ceiling this currency set at issuance (" +
    input.feeCeilingBasisPoints + " bps). No instruction can raise the ceiling. Nothing was built and nothing was sent. Restate a rate at or below " +
    input.feeCeilingBasisPoints + " bps."
  );
}

export function formatMaximumAboveCeilingRefusal(input: { newMaximumFee: bigint; feeCeilingBaseUnits: bigint }): string {
  return (
    "REFUSED " + EM_DASH + " the requested maximum fee (" + formatDdcAmount(input.newMaximumFee) + " DDC) is above the ceiling this currency set at issuance (" +
    formatDdcAmount(input.feeCeilingBaseUnits) + " DDC). No instruction can raise the ceiling. Nothing was built and nothing was sent. Restate a maximum at or below " +
    formatDdcAmount(input.feeCeilingBaseUnits) + " DDC."
  );
}

/** Pure: the refusal sentence, or undefined when both values are at or below their ceilings. */
export function decideFeeCeiling(input: FeeCeilingInput): string | undefined {
  if (input.newFeeBasisPoints > input.feeCeilingBasisPoints) {
    return formatRateAboveCeilingRefusal(input);
  }
  if (input.newMaximumFee > input.feeCeilingBaseUnits) {
    return formatMaximumAboveCeilingRefusal(input);
  }
  return undefined;
}
