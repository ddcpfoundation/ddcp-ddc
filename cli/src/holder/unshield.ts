// Unshield: confidential to public. One version-1 transaction with the
// equality and range proofs inline; no stored-result account, no rent.

import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  type Address,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { readActivationState, readConfidentialTransferAccount } from "../confidential-account.js";
import { checkBalanceCopy, decryptDecryptableBalance, encryptDecryptableBalance } from "../confidential-balance.js";
import type { DerivedConfidentialKeys } from "../confidential-keys.js";
import { buildUnshieldProofs, type UnshieldProofs } from "../tx/unshield-proofs.js";
import { assembleUnshieldTransaction } from "../tx/unshield-tx.js";
import {
  deriveMatchingKeys,
  holderTokenAccount,
  readTokenAccount,
  requireTransactionFormat,
  requireUnchangedBeforeSend,
  snapshotOf,
  type AccountSnapshot,
} from "./account.js";
import type { HolderSigner, Submit, TokenContext } from "./context.js";
import { HolderRefusal } from "./refusal.js";

export interface UnshieldPlan {
  readonly kind: "ready";
  readonly tokenAccount: Address;
  readonly amountBaseUnits: bigint;
  readonly confidentialAfterBaseUnits: bigint;
  readonly publicAfterBaseUnits: bigint;
  readonly snapshot: AccountSnapshot;
  readonly proofs: UnshieldProofs;
  readonly newDecryptableAvailableBalance: Uint8Array;
  readonly keys: DerivedConfidentialKeys;
}

export type UnshieldPreparation = { readonly kind: "not-activated"; readonly tokenAccount: Address } | UnshieldPlan;

export async function prepareUnshield(
  ctx: TokenContext,
  input: { readonly signer: HolderSigner; readonly amountBaseUnits: bigint },
): Promise<UnshieldPreparation> {
  const { signer, amountBaseUnits } = input;
  const tokenAccount = await holderTokenAccount(ctx, signer.address);
  // FORMAT GATE, the first live read.
  await requireTransactionFormat(ctx);
  const account = await readTokenAccount(ctx, tokenAccount);
  const state = readActivationState(account);
  const extension = readConfidentialTransferAccount(account);
  if (state.kind !== "configured" || extension === undefined) {
    return { kind: "not-activated", tokenAccount };
  }
  if (!state.approved) {
    throw new HolderRefusal({ kind: "account-unapproved" });
  }
  const keys = await deriveMatchingKeys(signer, extension.elgamalPubkey);
  const confidential = decryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    new Uint8Array(extension.decryptableAvailableBalance),
  );
  if (!confidential.readable) {
    throw new HolderRefusal({ kind: "figure-unreadable", figure: "confidential" });
  }
  // THE COPY AGAINST THE BALANCE IT COPIES: a proof built on a short copy
  // fails, so a short or unreadable difference is refused before the proofs.
  const copyCheck = checkBalanceCopy(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.availableBalance),
    confidential.baseUnits,
  );
  if (copyCheck.kind === "short") {
    throw new HolderRefusal({ kind: "copy-short", missingBaseUnits: copyCheck.missingBaseUnits });
  }
  if (copyCheck.kind === "unreadable") {
    throw new HolderRefusal({ kind: "copy-unreadable" });
  }
  if (amountBaseUnits > confidential.baseUnits) {
    throw new HolderRefusal({
      kind: "insufficient-confidential-for-unshield",
      amountBaseUnits,
      confidentialBaseUnits: confidential.baseUnits,
    });
  }
  const proofs = buildUnshieldProofs({
    elgamalSecretKey: new Uint8Array(keys.elgamalSecretKey),
    availableBalanceCiphertext: new Uint8Array(extension.availableBalance),
    availableBaseUnits: confidential.baseUnits,
    amountBaseUnits,
  });
  const newDecryptableAvailableBalance = encryptDecryptableBalance(new Uint8Array(keys.aeKey), proofs.remainingBaseUnits);
  const publicBefore = account.exists ? account.data.amount : 0n;
  return {
    kind: "ready",
    tokenAccount,
    amountBaseUnits,
    confidentialAfterBaseUnits: proofs.remainingBaseUnits,
    publicAfterBaseUnits: publicBefore + amountBaseUnits,
    snapshot: snapshotOf(tokenAccount, extension),
    proofs,
    newDecryptableAvailableBalance,
    keys,
  };
}

export interface UnshieldResult {
  readonly signature: Signature;
  /** The confidential figure read back, or the planned figure when it cannot be read. */
  readonly confidentialAfterBaseUnits: bigint;
  readonly publicAfterBaseUnits: bigint;
}

/**
 * Send a prepared unshield: the send-time check (available balance only; an
 * incoming credit lands in pending and is not a reason to refuse), then build,
 * sign, `submit`, and read the balances back. `beforeSubmit` sees the signed
 * transaction before it is sent.
 */
export async function sendUnshield(
  ctx: TokenContext,
  plan: UnshieldPlan,
  input: {
    readonly signer: HolderSigner;
    readonly beforeSubmit?: (transaction: Transaction) => void;
    readonly submit: Submit;
  },
): Promise<UnshieldResult> {
  await requireUnchangedBeforeSend(ctx, plan.snapshot, { counter: false });
  const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send()).value;
  const { transaction } = await assembleUnshieldTransaction({
    signer: input.signer,
    mint: ctx.mint,
    decimals: ctx.decimals,
    amountBaseUnits: plan.amountBaseUnits,
    newDecryptableAvailableBalance: plan.newDecryptableAvailableBalance,
    equalityProof: plan.proofs.equalityProof,
    rangeProof: plan.proofs.rangeProof,
    blockhash,
  });
  assertIsFullySignedTransaction(transaction);
  input.beforeSubmit?.(transaction);
  const signature = await input.submit(getBase64EncodedWireTransaction(transaction), transaction);
  const after = await readTokenAccount(ctx, plan.tokenAccount);
  const afterExtension = readConfidentialTransferAccount(after);
  const afterConfidential =
    afterExtension === undefined
      ? undefined
      : decryptDecryptableBalance(new Uint8Array(plan.keys.aeKey), new Uint8Array(afterExtension.decryptableAvailableBalance));
  return {
    signature,
    confidentialAfterBaseUnits:
      afterConfidential !== undefined && afterConfidential.readable ? afterConfidential.baseUnits : plan.confidentialAfterBaseUnits,
    publicAfterBaseUnits: after.exists ? after.data.amount : 0n,
  };
}
