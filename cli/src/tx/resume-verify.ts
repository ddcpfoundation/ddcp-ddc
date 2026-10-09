// PURE resume countersign/submit verify (I-5), on the generic admin-verify
// skeleton (admin-verify-core.ts). Surface:
// verifyResumeCountersign(decoded, ctx, stage) -> ResumeVerdict; checks a–e
// and their reason strings come from the core. Resume
// has NO amount/destination — nothing is wire-fed into the rebuild, there
// are no human confirm items, and the ok verdict carries no extraction. The
// ctx's token2022Program is simply unused: I-5 carries no Token-2022
// account. Mint keeps its own inline a–f in countersign-verify.ts.

import { buildResumeIssuanceInstruction } from "../instructions/resume-issuance.js";
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

export type ResumeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const I5_ACCOUNT_POSITION_LABELS = [
  "mint",
  "PDA-1 MintState",
  "issuer_authority",
  "reserve_authority",
] as const;

// Resume's instruction-specific slice of check f: 8-byte data (discriminator
// only), four accounts, rebuilt ENTIRELY from live authorities — structurally
// stronger than mint's, whose destination is wire-fed and human-confirmed.
const RESUME_IX1_DESCRIPTOR: AdminIx1Descriptor<undefined> = {
  expectedDataLength: 8,
  accountPositionLabels: I5_ACCOUNT_POSITION_LABELS,
  rebuild(_ix1, ctx) {
    return {
      ok: true,
      instruction: buildResumeIssuanceInstruction({
        mint: ctx.mint,
        mintState: ctx.mintStatePda,
        issuerAuthority: ctx.liveIssuer,
        reserveAuthority: ctx.liveReserve,
      }),
      extracted: undefined,
    };
  },
};

export function verifyResumeCountersign(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage = "countersign",
): ResumeVerdict {
  const verdict = verifyAdminCountersignCore(
    decoded,
    ctx,
    stage,
    issuerFrame(ctx),
    RESUME_IX1_DESCRIPTOR,
  );
  return verdict.ok ? { ok: true } : verdict;
}
