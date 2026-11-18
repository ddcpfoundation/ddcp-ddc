// Public transfer: public to the recipient's public balance, a distinct
// operation from the confidential transfer. The fee is added on top of the
// amount the recipient receives. The recipient's token account is created
// only when the read before the announcement found it absent, and the sender
// pays its rent, shown before the holder agrees.

import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  isOffCurveAddress,
  type Address,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { readConfidentialTransferAccount } from "../confidential-account.js";
import { decideScheduleHeadroom, sameScheduleParameters } from "../tx/schedule-headroom.js";
import type { TransferFeeSchedule } from "../tx/transfer-fee-split.js";
import { grossForNetPublic } from "../tx/transfer-fee-gross.js";
import { assemblePublicTransferTransaction } from "../tx/public-transfer-tx.js";
import { holderTokenAccount, readTokenAccount } from "./account.js";
import type { HolderSigner, ProgramContext, Submit, TokenContext } from "./context.js";
import { readEpochPosition, readMinimumFee, readMintFeeSchedules, scheduleOrRefuse } from "./fees.js";
import { HolderRefusal } from "./refusal.js";

/** The size of the recipient's token account when this operation creates it, for its rent. */
export const NEW_RECIPIENT_ACCOUNT_BYTES = 182n;

export interface PublicTransferPlan {
  readonly kind: "ready";
  readonly sourceToken: Address;
  readonly recipient: Address;
  readonly netBaseUnits: bigint;
  readonly grossBaseUnits: bigint;
  readonly feeBaseUnits: bigint;
  readonly schedule: TransferFeeSchedule;
  readonly publicBeforeBaseUnits: bigint;
  /** Rent in lamports for the recipient's account, when it is created; undefined when it exists. */
  readonly rentLamports: bigint | undefined;
  readonly createRecipientAccount: boolean;
}

export async function preparePublicTransfer(
  ctx: ProgramContext,
  input: { readonly signer: HolderSigner; readonly recipient: Address; readonly netBaseUnits: bigint },
): Promise<PublicTransferPlan> {
  const { signer, recipient, netBaseUnits } = input;
  if (recipient === signer.address) {
    throw new HolderRefusal({ kind: "self-transfer", recipient });
  }
  if (isOffCurveAddress(recipient)) {
    throw new HolderRefusal({ kind: "recipient-not-a-wallet", recipient });
  }
  const sourceToken = await holderTokenAccount(ctx, signer.address);
  const destinationToken = await holderTokenAccount(ctx, recipient);
  // COURTESY headroom check, before anything is quoted.
  const schedule = scheduleOrRefuse(decideScheduleHeadroom(await readMintFeeSchedules(ctx), await readEpochPosition(ctx)));
  // THE ONE FEE COMPUTATION: announced and sent from this result.
  const gross = grossForNetPublic(netBaseUnits, schedule);
  const source = await readTokenAccount(ctx, sourceToken);
  const publicBaseUnits = source.exists ? source.data.amount : 0n;
  if (gross.grossBaseUnits > publicBaseUnits) {
    throw new HolderRefusal({
      kind: "insufficient-public-for-transfer",
      netBaseUnits,
      grossBaseUnits: gross.grossBaseUnits,
      publicBaseUnits,
    });
  }
  // PDA-1 minimum fee: client policy, applied to the public path as well.
  const minimumFee = await readMinimumFee(ctx);
  if (gross.amounts.feeAmount < minimumFee) {
    throw new HolderRefusal({ kind: "below-minimum-fee", feeBaseUnits: gross.amounts.feeAmount, minimumFeeBaseUnits: minimumFee });
  }
  // DESTINATION read: drives the creation and the public-credits refusal.
  const destination = await readTokenAccount(ctx, destinationToken);
  const destinationExtension = readConfidentialTransferAccount(destination);
  if (destinationExtension !== undefined && !destinationExtension.allowNonConfidentialCredits) {
    throw new HolderRefusal({ kind: "recipient-refuses-public", recipient });
  }
  // RENT, read at announcement time and only when an account will be created.
  const rentLamports = destination.exists
    ? undefined
    : BigInt(
        await ctx.rpc.getMinimumBalanceForRentExemption(NEW_RECIPIENT_ACCOUNT_BYTES, { commitment: ctx.commitment }).send(),
      );
  return {
    kind: "ready",
    sourceToken,
    recipient,
    netBaseUnits,
    grossBaseUnits: gross.grossBaseUnits,
    feeBaseUnits: gross.amounts.feeAmount,
    schedule,
    publicBeforeBaseUnits: publicBaseUnits,
    rentLamports,
    // THE SAME READ THAT DECIDED THE ANNOUNCEMENT: rent is announced only when
    // the account was absent, so only then is the creation sent.
    createRecipientAccount: !destination.exists,
  };
}

export interface PublicTransferResult {
  readonly signature: Signature;
  readonly publicAfterBaseUnits: bigint;
}

/**
 * Send a prepared public transfer: the load-bearing headroom check on a fresh
 * mint and epoch read with the same parameters as quoted, then build, sign,
 * `submit`, and read the source back.
 */
export async function sendPublicTransfer(
  ctx: TokenContext,
  plan: PublicTransferPlan,
  input: {
    readonly signer: HolderSigner;
    readonly beforeSubmit?: (transaction: Transaction) => void;
    readonly submit: Submit;
  },
): Promise<PublicTransferResult> {
  const scheduleAgain = scheduleOrRefuse(decideScheduleHeadroom(await readMintFeeSchedules(ctx), await readEpochPosition(ctx)));
  if (!sameScheduleParameters(scheduleAgain, plan.schedule)) {
    throw new HolderRefusal({ kind: "schedule-moved" });
  }
  const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send()).value;
  const { transaction } = await assemblePublicTransferTransaction({
    signer: input.signer,
    mint: ctx.mint,
    decimals: ctx.decimals,
    recipient: plan.recipient,
    grossBaseUnits: plan.grossBaseUnits,
    feeBaseUnits: plan.feeBaseUnits,
    blockhash,
    createRecipientAccount: plan.createRecipientAccount,
  });
  assertIsFullySignedTransaction(transaction);
  input.beforeSubmit?.(transaction);
  const signature = await input.submit(getBase64EncodedWireTransaction(transaction), transaction);
  const after = await readTokenAccount(ctx, plan.sourceToken);
  return {
    signature,
    publicAfterBaseUnits: after.exists ? after.data.amount : plan.publicBeforeBaseUnits - plan.grossBaseUnits,
  };
}
