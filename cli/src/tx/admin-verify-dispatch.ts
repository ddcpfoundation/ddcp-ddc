// PURE wire-level admin-verify dispatch. Routes on the ix1
// DISCRIMINATOR read from the wire bytes, never the envelope's untrusted
// "instruction" string. Unknown or missing ix1 refuses (fail-closed). The
// tagged union tells callers whether a human typed-confirm gate applies:
// mint carries { amount, destination }; burn carries { amount, source };
// update_transfer_fee carries the fee triple; rotate_signer carries
// { role, newPubkey }; resume has no confirm items. Three members need
// live-derived deps a caller must supply deliberately: burn the PDA-5
// (redemptionAuthority), update_transfer_fee an UpdateFeeVerifyDeps, and
// rotate_signer a RotateSignerVerifyDeps — a caller that omits a dep gets a
// fail-closed refusal on that wire, never a downgraded verify, and each
// overload's return type excludes exactly the success members its missing
// deps make unreachable.

import type { Address } from "@solana/kit";
import { BURN_TOKENS_DISCRIMINATOR } from "../instructions/burn-tokens.js";
import { MINT_TOKENS_DISCRIMINATOR } from "../instructions/mint-tokens.js";
import { RESUME_ISSUANCE_DISCRIMINATOR } from "../instructions/resume-issuance.js";
import { UPDATE_TRANSFER_FEE_DISCRIMINATOR } from "../instructions/update-transfer-fee.js";
import { ROTATE_SIGNER_DISCRIMINATOR } from "../instructions/rotate-signer.js";
import type { SignerFrame } from "./admin-verify-core.js";
import {
  verifyMintCountersign,
  type CountersignContext,
  type DecodedAdminTx,
  type VerifyStage,
} from "./countersign-verify.js";
import { verifyResumeCountersign } from "./resume-verify.js";
import { verifyBurnCountersign } from "./burn-verify.js";
import { verifyUpdateFeeCountersign } from "./update-fee-verify.js";
import { verifyRotateSignerCountersign } from "./rotate-signer-verify.js";

const MINT_DISCRIMINATOR_HEX = Buffer.from(MINT_TOKENS_DISCRIMINATOR).toString(
  "hex",
);
const RESUME_DISCRIMINATOR_HEX = Buffer.from(
  RESUME_ISSUANCE_DISCRIMINATOR,
).toString("hex");
const BURN_DISCRIMINATOR_HEX = Buffer.from(BURN_TOKENS_DISCRIMINATOR).toString(
  "hex",
);
const UPDATE_FEE_DISCRIMINATOR_HEX = Buffer.from(
  UPDATE_TRANSFER_FEE_DISCRIMINATOR,
).toString("hex");
const ROTATE_SIGNER_DISCRIMINATOR_HEX = Buffer.from(
  ROTATE_SIGNER_DISCRIMINATOR,
).toString("hex");

export type AdminVerifyResult =
  | {
      readonly ok: true;
      readonly instruction: "mint_tokens";
      readonly amount: bigint;
      readonly destination: Address;
    }
  | { readonly ok: true; readonly instruction: "resume_issuance" }
  | {
      readonly ok: true;
      readonly instruction: "burn_tokens";
      readonly amount: bigint;
      readonly source: Address;
    }
  | {
      readonly ok: true;
      readonly instruction: "update_transfer_fee";
      readonly newFeeBasisPoints: number;
      readonly newMaximumFee: bigint;
      readonly newMinimumFee: bigint;
    }
  | {
      readonly ok: true;
      readonly instruction: "rotate_signer";
      readonly role: number;
      readonly newPubkey: Address;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * I-6 update_transfer_fee needs two live-derived inputs a caller must
 * supply deliberately: the PDA-3 fee authority (for the rebuild) and the
 * Operator signer frame (I-6 is Operator-initiated over the Operator nonce,
 * Issuer-countersigned). A caller that does not supply them gets a
 * fail-closed refusal on update-fee wires, never a downgraded verify.
 */
export interface UpdateFeeVerifyDeps {
  readonly feeAuthority: Address;
  readonly operatorFrame: SignerFrame;
}

/**
 * I-8 rotate_signer is Operator-initiated over the Operator nonce, Reserve-countersigned.
 * It needs only the Operator signer frame (no CPI authority — contrast I-6's
 * PDA-3). A caller that does not supply it gets a fail-closed refusal on
 * rotate-signer wires, never a downgraded verify.
 */
export interface RotateSignerVerifyDeps {
  readonly operatorFrame: SignerFrame;
}

export type AdminVerifyResultWithoutBurnOrUpdateFee = Exclude<
  AdminVerifyResult,
  | { readonly instruction: "burn_tokens" }
  | { readonly instruction: "update_transfer_fee" }
>;

export type AdminVerifyResultWithoutRotateSigner = Exclude<
  AdminVerifyResult,
  { readonly instruction: "rotate_signer" }
>;

export type AdminVerifyResultWithoutUpdateFeeOrRotateSigner = Exclude<
  AdminVerifyResult,
  | { readonly instruction: "update_transfer_fee" }
  | { readonly instruction: "rotate_signer" }
>;

export type AdminVerifyResultWithoutBurnUpdateFeeOrRotateSigner = Exclude<
  AdminVerifyResult,
  | { readonly instruction: "burn_tokens" }
  | { readonly instruction: "update_transfer_fee" }
  | { readonly instruction: "rotate_signer" }
>;

export function dispatchAdminVerify(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage,
): AdminVerifyResultWithoutBurnUpdateFeeOrRotateSigner;
export function dispatchAdminVerify(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage,
  redemptionAuthority: Address,
): AdminVerifyResultWithoutUpdateFeeOrRotateSigner;
export function dispatchAdminVerify(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage,
  redemptionAuthority: Address | undefined,
  updateFeeDeps: UpdateFeeVerifyDeps,
): AdminVerifyResultWithoutRotateSigner;
export function dispatchAdminVerify(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage,
  redemptionAuthority: Address | undefined,
  updateFeeDeps: UpdateFeeVerifyDeps | undefined,
  rotateSignerDeps: RotateSignerVerifyDeps,
): AdminVerifyResult;
export function dispatchAdminVerify(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage,
  redemptionAuthority?: Address,
  updateFeeDeps?: UpdateFeeVerifyDeps,
  rotateSignerDeps?: RotateSignerVerifyDeps,
): AdminVerifyResult {
  const ix1 = decoded.instructions[1];
  if (ix1 === undefined) {
    return { ok: false, reason: "admin tx has no instruction 1" };
  }
  const discriminatorHex = Buffer.from(ix1.data.subarray(0, 8)).toString(
    "hex",
  );
  if (discriminatorHex === MINT_DISCRIMINATOR_HEX) {
    const verdict = verifyMintCountersign(decoded, ctx, stage);
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      instruction: "mint_tokens",
      amount: verdict.amount,
      destination: verdict.destination,
    };
  }
  if (discriminatorHex === RESUME_DISCRIMINATOR_HEX) {
    const verdict = verifyResumeCountersign(decoded, ctx, stage);
    if (!verdict.ok) return verdict;
    return { ok: true, instruction: "resume_issuance" };
  }
  if (discriminatorHex === BURN_DISCRIMINATOR_HEX) {
    if (redemptionAuthority === undefined) {
      return {
        ok: false,
        reason:
          "burn_tokens verify requires the live-derived PDA-5 — dispatch was called without redemptionAuthority",
      };
    }
    const verdict = verifyBurnCountersign(
      decoded,
      ctx,
      redemptionAuthority,
      stage,
    );
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      instruction: "burn_tokens",
      amount: verdict.amount,
      source: verdict.source,
    };
  }
  if (discriminatorHex === UPDATE_FEE_DISCRIMINATOR_HEX) {
    if (updateFeeDeps === undefined) {
      return {
        ok: false,
        reason:
          "update_transfer_fee verify requires the live-derived PDA-3 fee authority and the Operator signer frame - dispatch was called without updateFeeDeps",
      };
    }
    const verdict = verifyUpdateFeeCountersign(
      decoded,
      ctx,
      updateFeeDeps.feeAuthority,
      updateFeeDeps.operatorFrame,
      stage,
    );
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      instruction: "update_transfer_fee",
      newFeeBasisPoints: verdict.newFeeBasisPoints,
      newMaximumFee: verdict.newMaximumFee,
      newMinimumFee: verdict.newMinimumFee,
    };
  }
  if (discriminatorHex === ROTATE_SIGNER_DISCRIMINATOR_HEX) {
    if (rotateSignerDeps === undefined) {
      return {
        ok: false,
        reason:
          "rotate_signer verify requires the Operator signer frame - dispatch was called without rotateSignerDeps",
      };
    }
    const verdict = verifyRotateSignerCountersign(
      decoded,
      ctx,
      rotateSignerDeps.operatorFrame,
      stage,
    );
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      instruction: "rotate_signer",
      role: verdict.role,
      newPubkey: verdict.newPubkey,
    };
  }
  return {
    ok: false,
    reason: `unrecognized admin instruction discriminator ${discriminatorHex}`,
  };
}
