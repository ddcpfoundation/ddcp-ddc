// Apply pending: fold the pending balance into the confidential balance, and
// correct a short balance copy in the same request, even with nothing pending.
// The only operation that applies; no sending operation applies on the way.

import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  type Address,
 
  type Signature,
} from "@solana/kit";
import { checkBalanceCopy, decryptDecryptableBalance, decryptPendingBalance, encryptDecryptableBalance } from "../confidential-balance.js";
import type { DerivedConfidentialKeys } from "../confidential-keys.js";
import type { BlockhashLifetime } from "../tx/confidential-setup-tx.js";
import { assembleApplyPendingTransaction } from "../tx/apply-pending-tx.js";
import {
  deriveMatchingKeys,
  holderTokenAccount,
  readBackCopy,
  readConfidentialExtension,
  requireUnchangedBeforeSend,
  snapshotOf,
  type AccountSnapshot,
  type CopyReadBack,
} from "./account.js";
import type { HolderContext, HolderSigner, Submit } from "./context.js";
import { HolderRefusal } from "./refusal.js";

export interface ApplyPendingPlan {
  readonly kind: "ready";
  readonly tokenAccount: Address;
  /** The pending credit counter as read; the transaction states it. */
  readonly credits: bigint;
  readonly pendingBaseUnits: bigint;
  /** The pending credit cap read from this account's extension. */
  readonly cap: bigint;
  /** The amount the copy was short by and this request corrects; zero when it was consistent. */
  readonly correctionBaseUnits: bigint;
  readonly confidentialAfterBaseUnits: bigint;
  readonly snapshot: AccountSnapshot;
  readonly newDecryptableAvailableBalance: Uint8Array;
  readonly keys: DerivedConfidentialKeys;
  readonly blockhash: BlockhashLifetime;
}

export type ApplyPendingPreparation =
  /** Confidential Balances is not activated: nothing can be pending. */
  | { readonly kind: "not-activated"; readonly tokenAccount: Address }
  /** Nothing pending and the copy matches the encrypted balance. */
  | { readonly kind: "nothing-to-apply"; readonly tokenAccount: Address }
  | ApplyPendingPlan;

export async function prepareApplyPending(
  ctx: HolderContext,
  input: { readonly signer: HolderSigner },
): Promise<ApplyPendingPreparation> {
  const { signer } = input;
  const tokenAccount = await holderTokenAccount(ctx, signer.address);

  // BLOCKHASH BEFORE THE ACCOUNT READ: one fewer round trip between the
  // counter read here and the counter the network sees. It is fetched even on
  // the two stops, which cost nothing but a read.
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send();

  const extension = await readConfidentialExtension(ctx, tokenAccount);
  if (extension === undefined) {
    return { kind: "not-activated", tokenAccount };
  }
  const credits = extension.pendingBalanceCreditCounter;

  // The zero-pending stop comes after the derivation: telling a matching copy
  // from a short one takes the key. Only here is the wallet asked, once.
  const keys = await deriveMatchingKeys(signer, extension.elgamalPubkey);
  const confidential = decryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    new Uint8Array(extension.decryptableAvailableBalance),
  );
  const pending = decryptPendingBalance(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.pendingBalanceLow),
    new Uint8Array(extension.pendingBalanceHigh),
    credits,
  );
  // The confidential figure is tested FIRST, so that when both are unreadable
  // the refusal names the figure the display order names first.
  if (!confidential.readable) {
    throw new HolderRefusal({ kind: "figure-unreadable", figure: "confidential" });
  }
  if (!pending.readable) {
    throw new HolderRefusal({ kind: "figure-unreadable", figure: "pending" });
  }
  const copyCheck = checkBalanceCopy(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.availableBalance),
    confidential.baseUnits,
  );
  if (copyCheck.kind === "unreadable") {
    throw new HolderRefusal({ kind: "copy-unreadable" });
  }
  const correctionBaseUnits = copyCheck.kind === "short" ? copyCheck.missingBaseUnits : 0n;
  if (credits === 0n && correctionBaseUnits === 0n) {
    return { kind: "nothing-to-apply", tokenAccount };
  }

  // THE ARITHMETIC: available (corrected) plus pending. The guarded wrapper
  // throws rather than letting the encoder wrap silently at 2^64.
  const confidentialAfterBaseUnits = confidential.baseUnits + correctionBaseUnits + pending.baseUnits;
  const newDecryptableAvailableBalance = encryptDecryptableBalance(new Uint8Array(keys.aeKey), confidentialAfterBaseUnits);
  return {
    kind: "ready",
    tokenAccount,
    credits,
    pendingBaseUnits: pending.baseUnits,
    cap: extension.maximumPendingBalanceCreditCounter,
    correctionBaseUnits,
    confidentialAfterBaseUnits,
    snapshot: snapshotOf(tokenAccount, extension),
    newDecryptableAvailableBalance,
    keys,
    blockhash,
  };
}

export interface ApplyPendingResult {
  readonly signature: Signature;
  readonly readBack: CopyReadBack;
}

/**
 * Send a prepared apply: the send-time check (counter and available
 * balance), then `afterCheck` (the caller's announcement), then build, sign,
 * `submit`, and read the copy back.
 */
export async function sendApplyPending(
  ctx: HolderContext,
  plan: ApplyPendingPlan,
  input: { readonly signer: HolderSigner; readonly afterCheck?: () => void; readonly submit: Submit },
): Promise<ApplyPendingResult> {
  await requireUnchangedBeforeSend(ctx, plan.snapshot, { counter: true });
  input.afterCheck?.();
  // THE COUNTER PASSED HERE IS THE ONE READ: the figures were computed from it.
  const { transaction, tokenAccount: assembledFor } = await assembleApplyPendingTransaction({
    signer: input.signer,
    mint: ctx.mint,
    newDecryptableAvailableBalance: plan.newDecryptableAvailableBalance,
    expectedPendingBalanceCreditCounter: plan.credits,
    blockhash: plan.blockhash,
  });
  if (assembledFor !== plan.tokenAccount) {
    throw new HolderRefusal({ kind: "token-account-differs", read: plan.tokenAccount, assembled: assembledFor });
  }
  assertIsFullySignedTransaction(transaction); // single signer, so fully signed
  const signature = await input.submit(getBase64EncodedWireTransaction(transaction), transaction);
  const readBack = await readBackCopy(ctx, { tokenAccount: plan.tokenAccount, keys: plan.keys, signature });
  return { signature, readBack };
}
