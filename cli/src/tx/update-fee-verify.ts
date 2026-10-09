// PURE update-fee countersign/submit verify (I-6): the update-fee slice of
// check f over the generic admin-verify skeleton (admin-verify-core.ts). I-6 is
// OPERATOR-INITIATED: the caller supplies the Operator signer frame (fee-payer /
// nonce authority = Operator, countersigner = Issuer) and the LIVE-DERIVED PDA-3,
// both reaching the rebuild via a FACTORY descriptor that closes over them — never
// wire-fed, and deliberately NOT CountersignContext fields (the ctx stays
// instruction-agnostic). The fee triple IS wire-fed: it is the human confirm item
// set, extracted and returned for the command layer's confirm gate, never judged
// here (the same contract as burn's amount/source).
// Mint keeps its own inline a–f in countersign-verify.ts.

import { getU16Decoder, getU64Decoder, type Address } from "@solana/kit";
import { buildUpdateTransferFeeInstruction } from "../instructions/update-transfer-fee.js";
import {
  verifyAdminCountersignCore,
  type AdminIx1Descriptor,
  type SignerFrame,
} from "./admin-verify-core.js";
import type {
  CountersignContext,
  DecodedAdminTx,
  VerifyStage,
} from "./countersign-verify.js";

/** I-6's human confirm items, wire-extracted and surfaced for the gate. */
export interface UpdateFeeConfirmItems {
  readonly newFeeBasisPoints: number;
  readonly newMaximumFee: bigint;
  readonly newMinimumFee: bigint;
}

export type UpdateFeeVerdict =
  | {
      readonly ok: true;
      readonly newFeeBasisPoints: number;
      readonly newMaximumFee: bigint;
      readonly newMinimumFee: bigint;
    }
  | { readonly ok: false; readonly reason: string };

const I6_ACCOUNT_POSITION_LABELS = [
  "mint",
  "PDA-3 fee_authority",
  "PDA-1 MintState",
  "issuer_authority",
  "operator_authority",
  "token_2022_program",
] as const;

/**
 * Factory: build I-6's descriptor around the already-derived PDA-3 and the
 * Operator signer frame so rebuild stays synchronous. Rebuild reconstructs the
 * I-6 instruction from the live authorities (mint, PDA-1, the closed-over
 * PDA-3, the frame's countersigning Issuer and initiating Operator, token-2022)
 * plus the wire-extracted fee triple — transitively verifying the
 * discriminator, every live-derived account, and account order. The
 * wire-fed triple is self-consistent by construction and is judged only by
 * the human confirm gate (and the on-chain FeeBoundsInvalid check).
 */
export function makeUpdateFeeIx1Descriptor(
  feeAuthority: Address,
  frame: SignerFrame,
): AdminIx1Descriptor<UpdateFeeConfirmItems> {
  return {
    expectedDataLength: 26,
    accountPositionLabels: I6_ACCOUNT_POSITION_LABELS,
    rebuild(ix1, ctx) {
      const newFeeBasisPoints = getU16Decoder().decode(
        ix1.data.subarray(8, 10),
      );
      const newMaximumFee = getU64Decoder().decode(ix1.data.subarray(10, 18));
      const newMinimumFee = getU64Decoder().decode(ix1.data.subarray(18, 26));
      return {
        ok: true,
        instruction: buildUpdateTransferFeeInstruction({
          mint: ctx.mint,
          feeAuthority,
          mintState: ctx.mintStatePda,
          issuerAuthority: frame.countersigner, // Issuer countersigns I-6
          operatorAuthority: frame.initiator, // Operator initiates I-6
          token2022Program: ctx.token2022Program,
          newFeeBasisPoints,
          newMaximumFee,
          newMinimumFee,
        }),
        extracted: { newFeeBasisPoints, newMaximumFee, newMinimumFee },
      };
    },
  };
}

export function verifyUpdateFeeCountersign(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  feeAuthority: Address,
  operatorFrame: SignerFrame,
  stage: VerifyStage = "countersign",
): UpdateFeeVerdict {
  const verdict = verifyAdminCountersignCore(
    decoded,
    ctx,
    stage,
    operatorFrame,
    makeUpdateFeeIx1Descriptor(feeAuthority, operatorFrame),
  );
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    newFeeBasisPoints: verdict.extracted.newFeeBasisPoints,
    newMaximumFee: verdict.extracted.newMaximumFee,
    newMinimumFee: verdict.extracted.newMinimumFee,
  };
}
