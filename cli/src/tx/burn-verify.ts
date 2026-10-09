// PURE burn countersign/submit verify: the
// burn slice of check f over the generic admin-verify skeleton
// (admin-verify-core.ts). PDA-5 is LIVE-DERIVED by the caller and reaches
// the rebuild via a FACTORY descriptor that closes over it — never
// wire-fed, and deliberately NOT a CountersignContext field (the ctx stays
// instruction-agnostic). Amount and source ARE wire-fed: they are the
// human confirm items, extracted and returned for the command layer's
// confirm gate, never judged here (the same contract as mint's
// amount/destination). Mint keeps its own inline a–f in
// countersign-verify.ts.

import { getU64Decoder, type Address } from "@solana/kit";
import { buildBurnTokensInstruction } from "../instructions/burn-tokens.js";
import {
  issuerFrame,
  verifyAdminCountersignCore,
  type AdminIx1Descriptor,
} from "./admin-verify-core.js";
import type {
  CountersignContext,
  DecodedAdminTx,
  VerifyStage,
} from "./countersign-verify.js";

/** Burn's human confirm items, wire-extracted and surfaced for the gate. */
export interface BurnConfirmItems {
  readonly amount: bigint;
  readonly source: Address;
}

export type BurnVerdict =
  | { readonly ok: true; readonly amount: bigint; readonly source: Address }
  | { readonly ok: false; readonly reason: string };

const I3_ACCOUNT_POSITION_LABELS = [
  "mint",
  "source",
  "PDA-1 MintState",
  "PDA-5",
  "issuer_authority",
  "reserve_authority",
  "token_2022_program",
] as const;

/**
 * Factory: build burn's descriptor around the already-derived PDA-5 so
 * rebuild stays synchronous. Rebuild reconstructs the I-3 instruction from
 * the live authorities (mint, PDA-1, the closed-over PDA-5, issuer, Reserve,
 * token-2022) plus the wire-extracted amount + source — transitively
 * verifying the discriminator, every live-derived account, and account
 * order. The wire-fed amount/source are self-consistent by construction
 * and are judged only by the human confirm gate.
 */
export function makeBurnIx1Descriptor(
  redemptionAuthority: Address,
): AdminIx1Descriptor<BurnConfirmItems> {
  return {
    expectedDataLength: 16,
    accountPositionLabels: I3_ACCOUNT_POSITION_LABELS,
    rebuild(ix1, ctx) {
      const source = ix1.accounts[1];
      if (source === undefined) {
        return {
          ok: false,
          reason: "instruction 1 has no source account (position 1)",
        };
      }
      const amount = getU64Decoder().decode(ix1.data.subarray(8, 16));
      return {
        ok: true,
        instruction: buildBurnTokensInstruction({
          mint: ctx.mint,
          source,
          mintState: ctx.mintStatePda,
          redemptionAuthority,
          issuerAuthority: ctx.liveIssuer,
          reserveAuthority: ctx.liveReserve,
          token2022Program: ctx.token2022Program,
          amount,
        }),
        extracted: { amount, source },
      };
    },
  };
}

export function verifyBurnCountersign(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  redemptionAuthority: Address,
  stage: VerifyStage = "countersign",
): BurnVerdict {
  const verdict = verifyAdminCountersignCore(
    decoded,
    ctx,
    stage,
    issuerFrame(ctx),
    makeBurnIx1Descriptor(redemptionAuthority),
  );
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    amount: verdict.extracted.amount,
    source: verdict.extracted.source,
  };
}
