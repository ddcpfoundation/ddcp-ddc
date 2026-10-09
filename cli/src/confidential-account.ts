// Confidential-account reading — shared by every command that looks at a
// DDC token account's Confidential Balances state. `readActivationState`
// and `ActivationState` MIGRATED here from commands/setup-privacy.ts:
// balance, shield and apply-pending need the same reading, and importing
// it from a command file makes one command a library of the next three —
// the shape rejected for the refusal copy.
//
// The full extension member is exposed as upstream's own type via Extract,
// never restated locally — the twelve-field shape was read at pinned source
// and recorded once; restating it here would be a second
// copy that can drift. Decoded byte fields arrive as Uint8Array: the two
// pending limbs and the available balance are 64-byte ElGamal ciphertexts,
// the decryptable copy a 36-byte AES ciphertext.

import type { Address, MaybeAccount } from "@solana/kit";
import type { Extension, Token } from "@solana-program/token-2022";

/** Upstream's ConfidentialTransferAccount extension member, by Extract — no local restatement. */
export type ConfidentialTransferAccountExtension = Extract<
  Extension,
  { __kind: "ConfidentialTransferAccount" }
>;

/**
 * The extension-5 member of a decoded (maybe-)account, or undefined when the
 * account is absent, carries no extensions, or is not configured for
 * Confidential Balances.
 */
export function readConfidentialTransferAccount(
  account: MaybeAccount<Token>,
): ConfidentialTransferAccountExtension | undefined {
  if (!account.exists) return undefined;
  const extensions = account.data.extensions;
  if (extensions.__option === "None") return undefined;
  for (const extension of extensions.value) {
    if (extension.__kind === "ConfidentialTransferAccount") {
      return extension;
    }
  }
  return undefined;
}

export type ActivationState =
  | { kind: "absent" }
  | { kind: "unconfigured" }
  | { kind: "configured"; elgamalPubkey: Address; approved: boolean };

/**
 * Pure over a decoded (maybe-)account: what the token account says about
 * activation. Extension 5, ConfidentialTransferAccount, present means
 * configured; the account existing without it means the ATA exists (someone
 * sent DDC to it) but has never been activated; absent means no ATA yet.
 */
export function readActivationState(account: MaybeAccount<Token>): ActivationState {
  if (!account.exists) return { kind: "absent" };
  const extension = readConfidentialTransferAccount(account);
  if (extension === undefined) return { kind: "unconfigured" };
  return {
    kind: "configured",
    elgamalPubkey: extension.elgamalPubkey,
    approved: extension.approved,
  };
}
