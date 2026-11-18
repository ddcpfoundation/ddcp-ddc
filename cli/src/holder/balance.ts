// The read behind `balance`: a token account's public figure, its
// Confidential Balances state and, on the signer's own configured account,
// the decrypted figures and the check of the balance copy. Never sends.
//
// THE SIGNATURE IS REQUESTED LATE AND AT MOST ONCE: only for the signer's own
// configured account, where decryption needs it. Another holder's account gets
// public figures, activation status and counters, with no derivation.

import { getAddressDecoder, type Address } from "@solana/kit";
import {
  readActivationState,
  readConfidentialTransferAccount,
  type ActivationState,
  type ConfidentialTransferAccountExtension,
} from "../confidential-account.js";
import {
  checkBalanceCopy,
  decryptDecryptableBalance,
  decryptPendingBalance,
  type BalanceCopyCheck,
  type DecryptResult,
} from "../confidential-balance.js";
import { deriveConfidentialKeys } from "../confidential-keys.js";
import { holderTokenAccount, readTokenAccount } from "./account.js";
import type { HolderContext, HolderSigner } from "./context.js";

export type HolderBalance = {
  readonly tokenAccount: Address;
  readonly owner: Address;
  readonly publicBaseUnits: bigint;
  readonly activation: ActivationState;
} & (
  /** Another holder's account: no derivation, counters when configured. */
  | { readonly kind: "foreign"; readonly extension: ConfidentialTransferAccountExtension | undefined }
  /** The signer's own account, not activated. */
  | { readonly kind: "not-activated" }
  /** The signer's own configured account, under another key: no figure is decrypted. */
  | { readonly kind: "key-mismatch"; readonly onChainKey: Address; readonly derivedKey: Address }
  /** The signer's own configured account, decrypted. */
  | {
      readonly kind: "decrypted";
      readonly extension: ConfidentialTransferAccountExtension;
      readonly confidential: DecryptResult;
      readonly pending: DecryptResult;
      /** The copy against the encrypted balance; undefined when the confidential figure is unreadable. */
      readonly copyCheck: BalanceCopyCheck | undefined;
    }
);

/** Read the balance of `owner`'s token account; `signer` decrypts only when it is the owner. */
export async function readHolderBalance(
  ctx: HolderContext,
  input: { readonly owner: Address; readonly signer: HolderSigner },
): Promise<HolderBalance> {
  const { owner, signer } = input;
  const tokenAccount = await holderTokenAccount(ctx, owner);
  const account = await readTokenAccount(ctx, tokenAccount);
  const publicBaseUnits = account.exists ? account.data.amount : 0n;
  const activation = readActivationState(account);
  const extension = readConfidentialTransferAccount(account);
  const base = { tokenAccount, owner, publicBaseUnits, activation };

  if (owner !== signer.address) {
    return { ...base, kind: "foreign", extension };
  }
  if (activation.kind !== "configured" || extension === undefined) {
    return { ...base, kind: "not-activated" };
  }

  // CONFIGURED AND MINE — derive late, once; compare before decrypting.
  const keys = await deriveConfidentialKeys({ signer });
  const derived = getAddressDecoder().decode(keys.elgamalPublicKey);
  if (derived !== extension.elgamalPubkey) {
    return { ...base, kind: "key-mismatch", onChainKey: extension.elgamalPubkey, derivedKey: derived };
  }
  const confidential = decryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    new Uint8Array(extension.decryptableAvailableBalance),
  );
  const pending = decryptPendingBalance(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.pendingBalanceLow),
    new Uint8Array(extension.pendingBalanceHigh),
    extension.pendingBalanceCreditCounter,
  );
  // THE COPY AGAINST THE BALANCE IT COPIES, not the counters: two shields run
  // at the same time leave the counters equal and the copy short.
  const copyCheck = confidential.readable
    ? checkBalanceCopy(
        new Uint8Array(keys.elgamalSecretKey),
        new Uint8Array(extension.availableBalance),
        confidential.baseUnits,
      )
    : undefined;
  return { ...base, kind: "decrypted", extension, confidential, pending, copyCheck };
}
