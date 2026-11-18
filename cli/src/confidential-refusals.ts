// Confidential-path refusal copy — cause/risk/action messages extracted into
// pure formatters so the load-bearing sentences are pinned by test.
// ADMISSION RULE: this file holds copy shared VERBATIM by every command that
// meets the same conditions — a message one command alone prints does not
// belong here. Five messages qualify: balance, shield and apply-pending
// reuse the key-mismatch copy; every command that lands an
// ApplyPendingBalance carries the read-back pair and the post-apply mismatch;
// apply-pending, shield and unshield share the unreadable refusal, worded
// command-neutral.
//
// PLACEMENT IS FLAT, beside confidential-keys.ts, for this reason: commands/,
// instructions/ and tx/ each hold a KIND of thing, and shared refusal copy is
// none of them. Exporting from setup-privacy.ts was rejected: a command file
// becomes a library of the next three commands, and its rpc/broadcast imports
// come along with every import of a string.
//
// THESE MESSAGES ARE USER COPY shared by several commands. None uses
// "deposit" as a user verb: the user word is "shield". A wording change is a
// copy decision, not a refactor — it is decided first, not in this file.

import type { Address, Signature } from "@solana/kit";
import { formatDdcAmount } from "./amount.js";
import type { BalanceCopyCheck } from "./confidential-balance.js";

/** Pre-send: the account carries a key this wallet did not derive; not reconfigurable in place. */
export function formatPreSendKeyMismatch(input: {
  onChainKey: Address;
  derivedKey: Address;
}): string {
  return (
    `KEY MISMATCH — this account's confidential key (${input.onChainKey}) was set up under a different derivation from the one this version of the tool uses (${input.derivedKey}): an earlier version of this tool (0.1.0), whose derivation included the account's owner and mint, or another wallet application. ` +
    "This version cannot read or move this account's confidential balance. Its public balance is unaffected. " +
    "The account cannot be reconfigured in place; nothing was sent. " +
    "To recover access to the confidential balance, use the tool that set the account up. " +
    "Shield nothing into this account's confidential balance in the meantime."
  );
}

/** Post-send: the network confirmed, but the re-read does not show the extension — likely replica lag, not failure. */
export function formatReadBackFailed(input: {
  signature: Signature;
  tokenAccount: Address;
  stateKind: "absent" | "unconfigured";
}): string {
  return (
    `READ-BACK FAILED — the network confirmed signature ${input.signature}, but token account ${input.tokenAccount} reads as "${input.stateKind}". ` +
    "Most likely a stale or lagging RPC read, not a failed activation. Do NOT re-run this command yet: " +
    "if the activation actually landed, a second send pays a fee and then fails on-chain. " +
    `First check the account directly (for example: solana account ${input.tokenAccount} --url YOUR_RPC_URL) or look the signature up in an explorer; ` +
    "re-run only if the account truly has no ConfidentialTransferAccount extension."
  );
}

/** Post-send: the extension is present but carries a key other than the one this wallet derived. */
export function formatReadBackMismatch(input: {
  onChainKey: Address;
  derivedKey: Address;
  signature: Signature;
}): string {
  return (
    `READ-BACK MISMATCH — the key on-chain (${input.onChainKey}) is not the key this wallet derived (${input.derivedKey}); signature ${input.signature}. ` +
    "Treat this account as UNSAFE for confidential funds: shield NOTHING into its confidential balance until this is resolved — " +
    "amounts placed behind a key you do not hold cannot be decrypted by you. " +
    "Re-read the account from a second RPC endpoint and record both keys before doing anything else."
  );
}

/**
 * Pre-send, the sixth refusal branch: a confidential figure returned
 * readable: false, so the request that would write a balance copy computed
 * from it is refused before anything is sent — the silent-understatement
 * failure that is the one corruption only the holder's
 * own client can produce. The cause names the failing figure by its own
 * noun, per branch, with no parenthetical.
 */
export function formatUnreadableRefusal(which: "pending" | "confidential"): string {
  const cause =
    which === "pending"
      ? "the pending balance did not decrypt"
      : "the confidential balance did not decrypt";
  return (
    "REFUSED — this CLI cannot read your confidential figures, so it will not send this request. " +
    `Cause: ${cause}. ` +
    "Risk: this request writes a new balance copy computed from the figures just read. Sending one now would write a copy that is wrong. Nothing was sent and no fee was paid. " +
    "Action: run ddc balance to re-read. If the figure is still unreadable, send nothing further into this account's confidential balance until it is resolved."
  );
}

/**
 * Post-send: the apply or shield confirmed, and the balance copy now on the
 * account does not match the encrypted balance. Printed by every command that
 * lands an ApplyPendingBalance; the HEADLINE names the command that ran.
 * apply-pending corrects a short copy (D-208 item 1). The copy now on the
 * account may be another concurrent command's, so the cause names the copy on
 * the account, not this request's (D-212).
 */
export function formatPostApplyMismatch(input: {
  expected: bigint;
  actual: bigint;
  check: Exclude<BalanceCopyCheck, { kind: "consistent" }>;
  command?: "apply-pending" | "shield";
}): string {
  const headline = input.command === "shield" ? "SHIELD CONFIRMED" : "APPLY-PENDING CONFIRMED";
  const counters = `(expected counter ${input.expected}, actual counter ${input.actual})`;
  if (input.check.kind === "short") {
    return (
      `${headline} — but the balance copy on this account is short by ${formatDdcAmount(input.check.missingBaseUnits)} DDC. ` +
      `Cause: a confidential credit arrived between this command's read and the network's execution, or another command on this account ran at the same time; the network folded it into the encrypted balance correctly, and the copy now on the account, written by this request or by another command that ran at the same time, was computed without it ${counters}. ` +
      "Risk: until the copy is corrected, ddc balance shows less than you hold and confidential sends from this account are refused; nothing on-chain is wrong and no value is lost. " +
      "Action: run ddc apply-pending. It corrects the copy, even with nothing pending."
    );
  }
  return (
    `${headline} — but the balance copy on this account does not match the encrypted balance, by more than this tool can read ${counters}. ` +
    "Risk: ddc balance may not show what you hold, and confidential sends from this account are refused; nothing on-chain is wrong and no value is lost. " +
    "Action: do not repeat the request expecting a fix. A correction needs the account's transaction history, which this tool does not read."
  );
}

/** Pre-send, apply-pending and shield: the copy was short, and this request corrects it. */
export function formatCopyCorrectionNotice(missingBaseUnits: bigint): string {
  return (
    `CORRECTION — the balance copy on this account is short by ${formatDdcAmount(missingBaseUnits)} DDC of its encrypted balance (an earlier apply or shield was raced by a credit). ` +
    "This request also writes the corrected figure."
  );
}

/** Pre-send, unshield and confidential-transfer: a proof built on a short copy would fail. */
export function formatCopyShortRefusal(missingBaseUnits: bigint): string {
  return (
    `REFUSED — the balance copy on this account is short by ${formatDdcAmount(missingBaseUnits)} DDC of its encrypted balance, so a proof built on it would fail. ` +
    "Run ddc apply-pending first: it corrects the copy, even with nothing pending. Nothing was sent and no fee was paid."
  );
}

/** Pre-send, every confidential command: the difference cannot be read. */
export function formatCopyUnreadableRefusal(): string {
  return (
    "REFUSED — the balance copy on this account does not match its encrypted balance, by more than this tool can read. " +
    "A correction needs the account's transaction history, which this tool does not read. Nothing was sent and no fee was paid."
  );
}
