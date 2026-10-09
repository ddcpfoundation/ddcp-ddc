// Transfer refusal copy shared by every command that sends DDC from one
// wallet to another, confidential or public. ADMISSION RULE, the
// confidential-refusals.ts rule applied to this file: a message printed
// VERBATIM by more than one such command belongs here; a message one command
// alone prints stays in that command.
//
// THE NAME CARRIES NO confidential- PREFIX, on the announcements.ts reasoning:
// nothing here is confidential-path copy. A recipient that is not an address,
// a recipient that is this wallet, and a fee below the instrument's minimum
// are refusals of a TRANSFER, and the confidential path is one of two that
// reach them. A prefix would misdescribe them and a later hand restoring one
// for symmetry would be making the file lie.
//
// PLACEMENT IS FLAT, beside confidential-refusals.ts and announcements.ts:
// commands/, instructions/ and tx/ each hold a
// KIND of thing, and shared refusal copy is none of them. Exporting from
// commands/confidential-transfer.ts was rejected on the ground that file's own
// sibling records: a command file becomes a library of the next command, and
// its rpc and broadcast imports come along with every import of a string.
//
// THE THREE MESSAGES ARE BYTE-IDENTICAL to the strings that shipped in
// commands/confidential-transfer.ts and are pinned there by test. This file
// MOVED them; it did not reword them. A wording change is a copy decision and
// is decided first, not in this file.
//
// A FOURTH MESSAGE IS NEW HERE, NOT MOVED: formatNotAWalletRefusal, the
// off-curve refusal both commands reach through transfer-args.ts.
import type { Address } from "@solana/kit";
import { formatDdcAmount } from "./amount.js";

const EM_DASH = String.fromCharCode(0x2014);

/** The recipient does not parse as a Solana wallet address. */
export function formatNotAnAddressRefusal(text: string): string {
  return "REFUSED " + EM_DASH + " " + text + " is not a Solana wallet address. Nothing was sent and no fee was paid.";
}

/** The recipient parses as an address but is off-curve, so it is not a key-held wallet. */
export function formatNotAWalletRefusal(text: string): string {
  return (
    "REFUSED " + EM_DASH + " " + text + " is not a wallet address. It may be a token account or a program address; this command sends only to a wallet. " +
    "Nothing was sent and no fee was paid. Ask the recipient for their correct wallet address."
  );
}

/** Sending to the sender's own wallet. */
export function formatSelfTransferRefusal(wallet: Address): string {
  return "REFUSED " + EM_DASH + " " + wallet + " is this wallet. A transfer to yourself moves nothing. Nothing was sent and no fee was paid.";
}

/** The fee is below the instrument's minimum (PDA-1 minimum_fee). Reaches the public path too. */
export function formatBelowMinimumFeeRefusal(input: { feeBaseUnits: bigint; minimumFeeBaseUnits: bigint }): string {
  return (
    "REFUSED " + EM_DASH + " the fee on this amount (" + formatDdcAmount(input.feeBaseUnits) + " DDC) is below the minimum fee this instrument sets (" +
    formatDdcAmount(input.minimumFeeBaseUnits) + " DDC). Nothing was sent and no fee was paid. Restate a larger amount."
  );
}
