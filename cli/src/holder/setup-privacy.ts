// Activation of Confidential Balances on the signer's token account: the
// four-instruction setup, signed once by the holder. The library reads and
// activates; the informed-consent step between the two is the caller's, and
// activation is never performed on the way to anything else.

import {
  assertIsFullySignedTransaction,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Address,
  type Signature,
} from "@solana/kit";
import { readActivationState, type ActivationState } from "../confidential-account.js";
import { deriveConfidentialKeys } from "../confidential-keys.js";
import { assembleConfidentialSetupTransaction } from "../tx/confidential-setup-tx.js";
import { holderTokenAccount, readTokenAccount } from "./account.js";
import type { HolderContext, HolderSigner, Submit } from "./context.js";
import { HolderRefusal } from "./refusal.js";

export type ActivationCheck =
  /** Not yet activated: activation may proceed once the holder consents. */
  | { readonly kind: "not-activated"; readonly tokenAccount: Address; readonly state: Exclude<ActivationState, { kind: "configured" }> }
  /** Already activated; `matches` says whether the stored key is the one this signer derives. */
  | {
      readonly kind: "already-activated";
      readonly tokenAccount: Address;
      readonly onChainKey: Address;
      readonly approved: boolean;
      readonly derivedKey: Address;
      readonly matches: boolean;
    };

/**
 * ACTIVATION PRE-CHECK: a configured account is never configured again
 * (ConfigureAccount would fail on chain after the fee was paid). On a
 * configured account the keys are derived to say whether they match.
 */
export async function checkActivation(ctx: HolderContext, signer: HolderSigner): Promise<ActivationCheck> {
  const tokenAccount = await holderTokenAccount(ctx, signer.address);
  const state = readActivationState(await readTokenAccount(ctx, tokenAccount));
  if (state.kind !== "configured") {
    return { kind: "not-activated", tokenAccount, state };
  }
  const keys = await deriveConfidentialKeys({ signer });
  const derivedKey = getAddressDecoder().decode(keys.elgamalPublicKey);
  return {
    kind: "already-activated",
    tokenAccount,
    onChainKey: state.elgamalPubkey,
    approved: state.approved,
    derivedKey,
    matches: derivedKey === state.elgamalPubkey,
  };
}

export interface ActivationResult {
  readonly signature: Signature;
  readonly tokenAccount: Address;
  readonly elgamalPubkey: Address;
  readonly approved: boolean;
}

/**
 * Activate, after the holder's consent: ONE signature derives the keys, the
 * setup transaction is sent through `submit`, and the account is read back.
 * `beforeSubmit` receives the derived key and the wire size before the send;
 * the stored key is then compared with the derived one, and a mismatch refused.
 */
export async function activateConfidentialBalances(
  ctx: HolderContext,
  input: {
    readonly signer: HolderSigner;
    readonly tokenAccount: Address;
    readonly beforeSubmit?: (info: { readonly derivedKey: Address; readonly wireBytes: number }) => void;
    readonly submit: Submit;
    /** Receives the account as read back, before the stored key is compared with the derived one. */
    readonly onReadBack?: (result: ActivationResult) => void;
  },
): Promise<ActivationResult> {
  const { signer, tokenAccount } = input;
  const keys = await deriveConfidentialKeys({ signer });
  const derivedKey = getAddressDecoder().decode(keys.elgamalPublicKey);

  // ORDINARY blockhash — single signer, self-pay.
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send();
  const { transaction, tokenAccount: assembledFor } = await assembleConfidentialSetupTransaction({
    signer,
    mint: ctx.mint,
    elgamalSecretKey: keys.elgamalSecretKey,
    aeKey: keys.aeKey,
    blockhash,
  });
  if (assembledFor !== tokenAccount) {
    throw new HolderRefusal({ kind: "token-account-differs", read: tokenAccount, assembled: assembledFor });
  }
  assertIsFullySignedTransaction(transaction); // single signer, so fully signed
  input.beforeSubmit?.({ derivedKey, wireBytes: getTransactionEncoder().encode(transaction).length });
  const signature = await input.submit(getBase64EncodedWireTransaction(transaction), transaction);

  // READ BACK: written to chain, and read back.
  const after = readActivationState(await readTokenAccount(ctx, tokenAccount));
  if (after.kind !== "configured") {
    throw new HolderRefusal({ kind: "activation-read-back-failed", signature, tokenAccount, stateKind: after.kind });
  }
  const result = { signature, tokenAccount, elgamalPubkey: after.elgamalPubkey, approved: after.approved };
  input.onReadBack?.(result);
  if (after.elgamalPubkey !== derivedKey) {
    throw new HolderRefusal({
      kind: "activation-read-back-mismatch",
      signature,
      onChainKey: after.elgamalPubkey,
      derivedKey,
    });
  }
  return result;
}
