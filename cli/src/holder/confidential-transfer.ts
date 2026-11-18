// Confidential transfer: confidential to the recipient's pending balance, with
// all five proofs inline ahead of TransferWithFee in one version-1
// transaction. No public fallback: a recipient who cannot receive
// confidentially is refused. The amount the sender states is what the
// recipient receives; the fee is added on top.

import {
  assertIsFullySignedTransaction,
  fetchEncodedAccount,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  isOffCurveAddress,
  type Address,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { decodeMint, type Mint } from "@solana-program/token-2022";
import { readActivationState, readConfidentialTransferAccount } from "../confidential-account.js";
import {
  checkBalanceCopy,
  decryptDecryptableBalance,
  decryptPendingBalance,
  encryptDecryptableBalance,
} from "../confidential-balance.js";
import type { DerivedConfidentialKeys } from "../confidential-keys.js";
import { decodeMintTransferFeeConfig } from "../mint-transfer-fee.js";
import { decideScheduleHeadroom, sameScheduleParameters } from "../tx/schedule-headroom.js";
import type { TransferFeeConfig, TransferFeeSchedule, TransferFeeSplit } from "../tx/transfer-fee-split.js";
import { readEpochPosition, readMinimumFee, scheduleOrRefuse } from "./fees.js";
import { grossForNet } from "../tx/transfer-fee-gross.js";
import { buildTransferProofs, type TransferProofs } from "../tx/transfer-proofs.js";
import { assembleTransferTransaction } from "../tx/transfer-tx.js";
import {
  deriveMatchingKeys,
  holderTokenAccount,
  readConfidentialExtension,
  readTokenAccount,
  requireTransactionFormat,
  requireUnchangedBeforeSend,
  snapshotOf,
  type AccountSnapshot,
} from "./account.js";
import type { HolderContext, HolderSigner, ProgramContext, Submit } from "./context.js";
import { HolderRefusal } from "./refusal.js";

/** The two ElGamal keys a transfer proof is built against, read off the decoded mint. */
export function readMintTransferKeys(mint: Mint): {
  auditorElgamalPubkey: Uint8Array | undefined;
  withdrawWithheldAuthorityElgamalPubkey: Uint8Array;
} {
  const extensions = mint.extensions;
  if (extensions.__option === "None") {
    throw new HolderRefusal({ kind: "mint-extension-missing", extension: "any" });
  }
  let auditor: Uint8Array | undefined;
  let withheld: Uint8Array | undefined;
  let sawAuditor = false;
  const encoder = getAddressEncoder();
  for (const extension of extensions.value) {
    if (extension.__kind === "ConfidentialTransferMint") {
      sawAuditor = true;
      auditor =
        extension.auditorElgamalPubkey.__option === "Some"
          ? new Uint8Array(encoder.encode(extension.auditorElgamalPubkey.value))
          : undefined;
    }
    if (extension.__kind === "ConfidentialTransferFee") {
      withheld = new Uint8Array(encoder.encode(extension.elgamalPubkey));
    }
  }
  if (!sawAuditor) throw new HolderRefusal({ kind: "mint-extension-missing", extension: "ConfidentialTransferMint" });
  if (withheld === undefined) throw new HolderRefusal({ kind: "mint-extension-missing", extension: "ConfidentialTransferFeeConfig" });
  return { auditorElgamalPubkey: auditor, withdrawWithheldAuthorityElgamalPubkey: withheld };
}

/** One fresh read of the mint, decoded twice on the same bytes: the fee schedules and the transfer keys. */
export async function readTransferMint(ctx: HolderContext): Promise<{
  schedules: TransferFeeConfig;
  keys: ReturnType<typeof readMintTransferKeys>;
}> {
  const encoded = await fetchEncodedAccount(ctx.rpc, ctx.mint, { commitment: ctx.commitment });
  if (!encoded.exists) throw new HolderRefusal({ kind: "account-not-found", account: "mint", address: ctx.mint });
  return { schedules: decodeMintTransferFeeConfig(new Uint8Array(encoded.data)), keys: readMintTransferKeys(decodeMint(encoded).data) };
}

export interface ConfidentialTransferPlan {
  readonly kind: "ready";
  readonly sourceToken: Address;
  readonly recipient: Address;
  readonly netBaseUnits: bigint;
  readonly grossBaseUnits: bigint;
  readonly split: TransferFeeSplit;
  readonly schedule: TransferFeeSchedule;
  readonly confidentialBeforeBaseUnits: bigint;
  /** The pending figure, or undefined when it does not decrypt. */
  readonly pendingBaseUnits: bigint | undefined;
  readonly zeroAuditorKey: boolean;
  readonly snapshot: AccountSnapshot;
  readonly proofs: TransferProofs;
  readonly newDecryptableAvailableBalance: Uint8Array;
  readonly keys: DerivedConfidentialKeys;
}

export type ConfidentialTransferPreparation =
  | { readonly kind: "not-activated"; readonly tokenAccount: Address }
  | ConfidentialTransferPlan;

export async function prepareConfidentialTransfer(
  ctx: ProgramContext,
  input: { readonly signer: HolderSigner; readonly recipient: Address; readonly netBaseUnits: bigint },
): Promise<ConfidentialTransferPreparation> {
  const { signer, recipient, netBaseUnits } = input;
  if (recipient === signer.address) {
    throw new HolderRefusal({ kind: "self-transfer", recipient });
  }
  if (isOffCurveAddress(recipient)) {
    throw new HolderRefusal({ kind: "recipient-not-a-wallet", recipient });
  }
  const sourceToken = await holderTokenAccount(ctx, signer.address);
  const destinationToken = await holderTokenAccount(ctx, recipient);
  // FORMAT GATE, the first live read.
  await requireTransactionFormat(ctx);
  const source = await readTokenAccount(ctx, sourceToken);
  const state = readActivationState(source);
  const extension = readConfidentialTransferAccount(source);
  if (state.kind !== "configured" || extension === undefined) {
    return { kind: "not-activated", tokenAccount: sourceToken };
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
  const pending = decryptPendingBalance(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.pendingBalanceLow),
    new Uint8Array(extension.pendingBalanceHigh),
    extension.pendingBalanceCreditCounter,
  );
  const mint = await readTransferMint(ctx);
  // COURTESY headroom check, before the wait of proof generation.
  const schedule = scheduleOrRefuse(decideScheduleHeadroom(mint.schedules, await readEpochPosition(ctx)));
  const gross = grossForNet(netBaseUnits, schedule);
  if (gross.grossBaseUnits > confidential.baseUnits) {
    throw new HolderRefusal({
      kind: "insufficient-confidential-for-transfer",
      netBaseUnits,
      grossBaseUnits: gross.grossBaseUnits,
      confidentialBaseUnits: confidential.baseUnits,
    });
  }
  // PDA-1 minimum fee: client policy, refused by name.
  const minimumFee = await readMinimumFee(ctx);
  if (gross.split.feeAmount < minimumFee) {
    throw new HolderRefusal({ kind: "below-minimum-fee", feeBaseUnits: gross.split.feeAmount, minimumFeeBaseUnits: minimumFee });
  }
  // DESTINATION read.
  const destination = await readTokenAccount(ctx, destinationToken);
  const destinationState = readActivationState(destination);
  const destinationExtension = readConfidentialTransferAccount(destination);
  if (destinationState.kind !== "configured" || destinationExtension === undefined) {
    throw new HolderRefusal({ kind: "recipient-not-activated", recipient });
  }
  if (!destinationState.approved) throw new HolderRefusal({ kind: "recipient-cannot-receive", recipient, why: "unapproved" });
  if (!destinationExtension.allowConfidentialCredits) {
    throw new HolderRefusal({ kind: "recipient-cannot-receive", recipient, why: "credits-disabled" });
  }
  if (destinationExtension.pendingBalanceCreditCounter >= destinationExtension.maximumPendingBalanceCreditCounter) {
    throw new HolderRefusal({ kind: "recipient-cannot-receive", recipient, why: "pending-full" });
  }
  const proofs = buildTransferProofs({
    elgamalSecretKey: new Uint8Array(keys.elgamalSecretKey),
    availableBalanceCiphertext: new Uint8Array(extension.availableBalance),
    availableBaseUnits: confidential.baseUnits,
    grossBaseUnits: gross.grossBaseUnits,
    split: gross.split,
    schedule,
    destinationElgamalPubkey: new Uint8Array(getAddressEncoder().encode(destinationExtension.elgamalPubkey)),
    auditorElgamalPubkey: mint.keys.auditorElgamalPubkey,
    withdrawWithheldAuthorityElgamalPubkey: mint.keys.withdrawWithheldAuthorityElgamalPubkey,
  });
  const newDecryptableAvailableBalance = encryptDecryptableBalance(new Uint8Array(keys.aeKey), proofs.remainingBaseUnits);
  return {
    kind: "ready",
    sourceToken,
    recipient,
    netBaseUnits,
    grossBaseUnits: gross.grossBaseUnits,
    split: gross.split,
    schedule,
    confidentialBeforeBaseUnits: confidential.baseUnits,
    pendingBaseUnits: pending.readable ? pending.baseUnits : undefined,
    zeroAuditorKey: proofs.zeroAuditorKey,
    snapshot: snapshotOf(sourceToken, extension),
    proofs,
    newDecryptableAvailableBalance,
    keys,
  };
}

export interface ConfidentialTransferResult {
  readonly signature: Signature;
  /** The confidential figure read back, or the planned figure when it cannot be read. */
  readonly confidentialAfterBaseUnits: bigint;
}

/**
 * Send a prepared transfer: the send-time check (available balance only),
 * the load-bearing headroom check on a fresh mint and epoch read with the
 * same parameters as proven, then build, sign, `submit`, and read back.
 */
export async function sendConfidentialTransfer(
  ctx: HolderContext,
  plan: ConfidentialTransferPlan,
  input: {
    readonly signer: HolderSigner;
    readonly beforeSubmit?: (transaction: Transaction) => void;
    readonly submit: Submit;
  },
): Promise<ConfidentialTransferResult> {
  await requireUnchangedBeforeSend(ctx, plan.snapshot, { counter: false });
  const mintAgain = await readTransferMint(ctx);
  const scheduleAgain = scheduleOrRefuse(decideScheduleHeadroom(mintAgain.schedules, await readEpochPosition(ctx)));
  if (!sameScheduleParameters(scheduleAgain, plan.schedule)) {
    throw new HolderRefusal({ kind: "schedule-moved" });
  }
  const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: ctx.commitment }).send()).value;
  const { transaction } = await assembleTransferTransaction({
    signer: input.signer,
    mint: ctx.mint,
    recipient: plan.recipient,
    newDecryptableAvailableBalance: plan.newDecryptableAvailableBalance,
    proofs: plan.proofs,
    blockhash,
  });
  assertIsFullySignedTransaction(transaction);
  input.beforeSubmit?.(transaction);
  const signature = await input.submit(getBase64EncodedWireTransaction(transaction), transaction);
  const afterExtension = await readConfidentialExtension(ctx, plan.sourceToken);
  const afterConfidential =
    afterExtension === undefined
      ? undefined
      : decryptDecryptableBalance(new Uint8Array(plan.keys.aeKey), new Uint8Array(afterExtension.decryptableAvailableBalance));
  return {
    signature,
    confidentialAfterBaseUnits:
      afterConfidential !== undefined && afterConfidential.readable ? afterConfidential.baseUnits : plan.proofs.remainingBaseUnits,
  };
}
