// Shield: public to confidential, nothing else. Deposit and apply in one
// transaction, writing the balance copy as the available figure plus the
// amount, the available figure corrected first when the copy was short.
//
// CHECK ORDER, cheapest first: not activated, pending at its cap, anything
// pending, the public balance short of the amount; none of these needs a key.
// Only then is the wallet asked to sign, once.

import { getBase64EncodedWireTransaction, type Address, type Signature } from "@solana/kit";
import { readConfidentialTransferAccount } from "../confidential-account.js";
import { checkBalanceCopy, decryptDecryptableBalance, encryptDecryptableBalance } from "../confidential-balance.js";
import type { DerivedConfidentialKeys } from "../confidential-keys.js";
import type { BlockhashLifetime } from "../tx/confidential-setup-tx.js";
import { assembleShieldTransaction } from "../tx/shield-tx.js";
import {
  deriveMatchingKeys,
  holderTokenAccount,
  readBackCopy,
  readTokenAccount,
  requireUnchangedBeforeSend,
  snapshotOf,
  type AccountSnapshot,
  type CopyReadBack,
} from "./account.js";
import type { HolderSigner, Submit, TokenContext } from "./context.js";
import { HolderRefusal } from "./refusal.js";
import { assertIsFullySignedTransaction } from "@solana/kit";

export interface ShieldPlan {
  readonly kind: "ready";
  readonly tokenAccount: Address;
  readonly amountBaseUnits: bigint;
  /** The amount the copy was short by and this request corrects; zero when it was consistent. */
  readonly correctionBaseUnits: bigint;
  readonly confidentialAfterBaseUnits: bigint;
  readonly snapshot: AccountSnapshot;
  readonly newDecryptableAvailableBalance: Uint8Array;
  readonly keys: DerivedConfidentialKeys;
  readonly blockhash: BlockhashLifetime;
}

export type ShieldPreparation = { readonly kind: "not-activated"; readonly tokenAccount: Address } | ShieldPlan;

export async function prepareShield(
  ctx: TokenContext,
  input: { readonly signer: HolderSigner; readonly amountBaseUnits: bigint },
): Promise<ShieldPreparation> {
  const { signer, amountBaseUnits } = input;
  const tokenAccount = await holderTokenAccount(ctx, signer.address);

  // BLOCKHASH BEFORE THE ACCOUNT READ: one fewer round trip between the
  // counter read here and the counter the network sees.
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send();

  const account = await readTokenAccount(ctx, tokenAccount);
  const extension = readConfidentialTransferAccount(account);
  if (extension === undefined) {
    return { kind: "not-activated", tokenAccount };
  }
  const publicBaseUnits = account.exists ? account.data.amount : 0n;
  const creditsAtRead = extension.pendingBalanceCreditCounter;
  const cap = extension.maximumPendingBalanceCreditCounter;
  if (creditsAtRead >= cap) {
    throw new HolderRefusal({ kind: "pending-at-cap", count: creditsAtRead, cap });
  }
  if (creditsAtRead !== 0n) {
    throw new HolderRefusal({ kind: "pending-present", credits: creditsAtRead });
  }
  if (amountBaseUnits > publicBaseUnits) {
    throw new HolderRefusal({ kind: "insufficient-public-for-shield", amountBaseUnits, publicBaseUnits });
  }

  // DERIVE — only here is the wallet asked, once.
  const keys = await deriveMatchingKeys(signer, extension.elgamalPubkey);
  const confidential = decryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    new Uint8Array(extension.decryptableAvailableBalance),
  );
  if (!confidential.readable) {
    throw new HolderRefusal({ kind: "figure-unreadable", figure: "confidential" });
  }
  // THE COPY AGAINST THE BALANCE IT COPIES: a short copy is corrected by this
  // same request; an unreadable difference is refused.
  const copyCheck = checkBalanceCopy(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.availableBalance),
    confidential.baseUnits,
  );
  if (copyCheck.kind === "unreadable") {
    throw new HolderRefusal({ kind: "copy-unreadable" });
  }
  const correctionBaseUnits = copyCheck.kind === "short" ? copyCheck.missingBaseUnits : 0n;

  // THE ARITHMETIC: available (corrected) plus amount, pending being zero.
  const confidentialAfterBaseUnits = confidential.baseUnits + correctionBaseUnits + amountBaseUnits;
  const newDecryptableAvailableBalance = encryptDecryptableBalance(new Uint8Array(keys.aeKey), confidentialAfterBaseUnits);
  return {
    kind: "ready",
    tokenAccount,
    amountBaseUnits,
    correctionBaseUnits,
    confidentialAfterBaseUnits,
    snapshot: snapshotOf(tokenAccount, extension),
    newDecryptableAvailableBalance,
    keys,
    blockhash,
  };
}

export interface ShieldResult {
  readonly signature: Signature;
  readonly readBack: CopyReadBack;
}

/**
 * Send a prepared shield: the send-time check (counter and available
 * balance), then `afterCheck` (the caller's announcement), then build, sign,
 * `submit`, and read the copy back.
 */
export async function sendShield(
  ctx: TokenContext,
  plan: ShieldPlan,
  input: { readonly signer: HolderSigner; readonly afterCheck?: () => void; readonly submit: Submit },
): Promise<ShieldResult> {
  await requireUnchangedBeforeSend(ctx, plan.snapshot, { counter: true });
  input.afterCheck?.();
  // ONE SIGNER. The assembler adds the one credit its own Deposit creates to
  // the counter AS READ.
  const { transaction, tokenAccount: assembledFor } = await assembleShieldTransaction({
    signer: input.signer,
    mint: ctx.mint,
    decimals: ctx.decimals,
    amountBaseUnits: plan.amountBaseUnits,
    newDecryptableAvailableBalance: plan.newDecryptableAvailableBalance,
    pendingBalanceCreditCounterAtRead: plan.snapshot.pendingBalanceCreditCounter,
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
