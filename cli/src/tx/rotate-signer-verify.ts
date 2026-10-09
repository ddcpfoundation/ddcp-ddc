// PURE rotate-signer countersign/submit verify (I-8): the rotate-signer slice
// of check f over the generic admin-verify skeleton (admin-verify-core.ts). I-8 is
// OPERATOR-INITIATED: the caller supplies the Operator signer frame (fee-payer /
// nonce authority = Operator, countersigner = Reserve). Unlike I-6 there is NO PDA-3
// and no CPI — the descriptor closes over the frame only. role + new_pubkey ARE
// wire-fed: they are the human confirm item set, extracted and returned for the
// command layer's confirm gate, never judged here (the same contract as I-6's fee
// triple and burn's amount/source). Mint keeps its own verify in countersign-verify.ts.

import { getAddressDecoder, getU8Decoder, type Address } from "@solana/kit";
import { buildRotateSignerInstruction } from "../instructions/rotate-signer.js";
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

/** I-8's human confirm items, wire-extracted and surfaced for the gate. */
export interface RotateSignerConfirmItems {
  readonly role: number;
  readonly newPubkey: Address;
}

export type RotateSignerVerdict =
  | { readonly ok: true; readonly role: number; readonly newPubkey: Address }
  | { readonly ok: false; readonly reason: string };

const I8_ACCOUNT_POSITION_LABELS = [
  "mint",
  "PDA-1 MintState",
  "operator_authority",
  "reserve_authority",
] as const;

/**
 * Factory: build I-8's descriptor around the Operator signer frame so rebuild
 * stays synchronous. No PDA-3 to close over (I-8 has no CPI). Rebuild
 * reconstructs the I-8 instruction from the live authorities (mint, PDA-1,
 * the frame's initiating Operator and countersigning Reserve) plus the wire-extracted
 * role + new_pubkey — transitively verifying the discriminator, every
 * live-derived account, and account order. The wire-fed pair is
 * self-consistent by construction and is judged only by the human confirm
 * gate (and the on-chain InvalidPubkey / InvalidRole checks).
 */
export function makeRotateSignerIx1Descriptor(
  frame: SignerFrame,
): AdminIx1Descriptor<RotateSignerConfirmItems> {
  return {
    expectedDataLength: 41,
    accountPositionLabels: I8_ACCOUNT_POSITION_LABELS,
    rebuild(ix1, ctx) {
      const role = getU8Decoder().decode(ix1.data.subarray(8, 9));
      const newPubkey = getAddressDecoder().decode(ix1.data.subarray(9, 41));
      return {
        ok: true,
        instruction: buildRotateSignerInstruction({
          mint: ctx.mint,
          mintState: ctx.mintStatePda,
          operatorAuthority: frame.initiator, // Operator initiates I-8
          reserveAuthority: frame.countersigner, // Reserve countersigns I-8
          role,
          newPubkey,
        }),
        extracted: { role, newPubkey },
      };
    },
  };
}

export function verifyRotateSignerCountersign(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  operatorFrame: SignerFrame,
  stage: VerifyStage = "countersign",
): RotateSignerVerdict {
  const verdict = verifyAdminCountersignCore(
    decoded,
    ctx,
    stage,
    operatorFrame,
    makeRotateSignerIx1Descriptor(operatorFrame),
  );
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    role: verdict.extracted.role,
    newPubkey: verdict.extracted.newPubkey,
  };
}
