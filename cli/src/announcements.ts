// Announcement copy shared VERBATIM by every send announcement. ADMISSION RULE:
// a line printed inside the pre-send announcement of more than one user command,
// byte for byte. A refusal belongs in confidential-refusals.ts; a threshold
// warning in confidential-warnings.ts; a line one command alone prints stays in
// that command.
//
// PLACEMENT IS FLAT beside its two sibling modules, for this reason: commands/,
// instructions/ and tx/ each hold a KIND of thing, and shared announcement copy
// is none of them.
//
// THE NAME CARRIES NO confidential- PREFIX, unlike its two siblings. Nothing
// this module holds is confidential-path copy: a SOL network-fee sentence
// printed by shield, apply-pending, unshield and both transfer commands, and
// a fee line printed by both transfer commands. A prefix here would
// misdescribe them, and a later hand restoring one for symmetry would be
// making the file lie.

import { formatDdcAmount } from "./amount.js";
import type { TransferFeeSchedule } from "./tx/transfer-fee-split.js";

/**
 * The network-fee line, fixed verbatim as an upper bound in SOL
 * grounded in a ten-transaction devnet measurement. MIGRATED here from
 * commands/apply-pending.ts when `shield` became its second consumer.
 *
 * THE BOUND'S CONDITION, which ships here because the sentence stops being true
 * the day it is broken: it holds only while NO SetComputeUnitPrice instruction
 * is set. A prioritization fee is priced in micro-lamports per compute unit and
 * is added on top of the base fee. The tripwire is a test, not a runtime branch
 * — tx/apply-pending-tx.test.ts and tx/shield-tx.test.ts each assert the
 * ComputeBudget program is absent and cost their transaction from the signature
 * count read off the assembled artifact.
 */
export const NETWORK_FEE_LINE =
  "network fee : less than 0.00002 SOL (base signature fee, paid by this wallet)";

/**
 * The fee line, printed byte for byte inside both transfer commands'
 * announcements. MOVED here from commands/confidential-transfer.ts unchanged
 * when the public transfer became its second consumer; the wording is the
 * one the confidential transfer settled and is pinned by test there.
 */
export function formatFeeLine(input: { feeBaseUnits: bigint; schedule: TransferFeeSchedule }): string {
  return (
    "fee : " + formatDdcAmount(input.feeBaseUnits) + " DDC (" + input.schedule.basisPoints + " bps, cap " +
    formatDdcAmount(input.schedule.maximumFee) + " DDC) withheld to the mint's fee ledger"
  );
}
