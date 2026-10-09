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

/** Pre-send: the account carries a key this wallet did not derive; not reconfigurable in place. */
export function formatPreSendKeyMismatch(input: {
  onChainKey: Address;
  derivedKey: Address;
}): string {
  return (
    `KEY MISMATCH — the on-chain ElGamal public key ${input.onChainKey} is not the key this wallet derives (${input.derivedKey}). ` +
    "The account cannot be reconfigured in place; nothing was sent. " +
    "Shield NOTHING into this account's confidential balance: amounts placed behind a key this wallet did not derive cannot be decrypted by this wallet."
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
 * Post-send: the apply confirmed, a credit
 * raced it, and the written copy understates. Printed by every command that lands an
 * ApplyPendingBalance; the HEADLINE names the command that ran and the body is shared
 * verbatim. The action line uses the register commands/balance.ts ships in
 * formatStaleWarning — no repair exists yet, the capability is later — never a repair
 * instruction. The two copies are NOT verbatim-identical: they share a REGISTER, not a
 * string, so the admission rule does not reach them. Their extraction is
 * therefore closed WITHOUT extracting: formatStaleWarning speaks of a past
 * apply the holder did not just run, this message of the one they just ran, and
 * converging the wording would make one of the two slightly wrong.
 */
export function formatPostApplyMismatch(input: {
  expected: bigint;
  actual: bigint;
  command?: "apply-pending" | "shield";
}): string {
  const headline = input.command === "shield" ? "SHIELD CONFIRMED" : "APPLY-PENDING CONFIRMED";
  return (
    `${headline} — but your displayed confidential balance may understate what you hold. ` +
    `Cause: a confidential credit arrived between this command's read and the network's execution; the network folded it correctly, and the balance copy this request wrote was computed before it arrived (expected counter ${input.expected}, actual counter ${input.actual}). ` +
    "Risk: ddc balance will show a figure lower than the true holding; nothing on-chain is wrong and no value is lost. Another apply pending balance request does not correct the copy — the missing amount sits in the encrypted balance this CLI cannot read. Until the copy is corrected, confidential sends from this account may be refused by the network. " +
    "Action: no repair exists yet; correcting the figure from transaction history is a later capability. Treat the confidential figure as a lower bound until then. Shielding into this account continues to work normally. Do not repeat the request expecting a fix."
  );
}
