// GENERIC durable-nonce admin-verify skeleton, shared by every two-party
// admin verify except mint's. Holds the
// shared checks a–e and the instruction-AGNOSTIC frame of check f (ix1 program
// + exact data length + data/account byte-compare); everything
// instruction-SPECIFIC — the expected data length, the rebuild over live
// authorities, the per-position account labels, and any wire-fed confirm items
// — arrives via the descriptor. verifyMintCountersign in countersign-verify.ts
// keeps its own inline a–f and does NOT adopt this module. Reason strings
// here match mint's a–e wording verbatim — a drifted string is a behavior
// change, not a cleanup. The signer identities (initiator / countersigner /
// nonce account) are parameterized via SignerFrame; for the issuer frame the
// reason strings are byte-identical to mint's.

import type { Address } from "@solana/kit";
import type {
  CountersignContext,
  DecodedAdminTx,
  DecodedAdminTxInstruction,
  VerifyStage,
} from "./countersign-verify.js";

/**
 * Parameterized signer frame for a two-party admin instruction: who initiates
 * (fee-payer + nonce authority), who countersigns, and the durable-nonce
 * account. Checks b/c/e read these instead of hardcoding issuer/Reserve/issuer-
 * nonce, so the one core serves issuer-initiated instructions (resume, burn;
 * mint keeps its own verify) and Operator-initiated ones (I-6 Issuer-
 * countersigned, I-8 Reserve-countersigned). Invariant in every caller: nonce
 * authority == initiator. Labels are templated into the reason strings; for
 * the issuer frame (labels "issuer"/"Reserve") every string is byte-identical to
 * mint's own verify.
 */
export interface SignerFrame {
  readonly initiator: Address;
  readonly initiatorLabel: string;
  readonly countersigner: Address;
  readonly countersignerLabel: string;
  readonly nonceAccount: Address;
}

/**
 * Issuer-initiated frame, derived entirely from ctx — used by resume and burn.
 * Because it is ctx-derived it cannot diverge from ctx, so no coupling assert
 * is needed here; that assert belongs where a frame is built from a source
 * independent of ctx (the Operator-initiated command sites, I-6/I-8).
 */
export function issuerFrame(ctx: CountersignContext): SignerFrame {
  return {
    initiator: ctx.liveIssuer,
    initiatorLabel: "issuer",
    countersigner: ctx.liveReserve,
    countersignerLabel: "Reserve",
    nonceAccount: ctx.issuerNonceAccount,
  };
}

export type AdminVerifyFailure = {
  readonly ok: false;
  readonly reason: string;
};

/** The minimal instruction shape check f compares against (builder output). */
export interface RebuildableInstruction {
  readonly accounts: readonly { readonly address: Address }[];
  readonly data: Uint8Array;
}

export type RebuildResult<TExtracted> =
  | {
      readonly ok: true;
      readonly instruction: RebuildableInstruction;
      readonly extracted: TExtracted;
    }
  | AdminVerifyFailure;

/**
 * The instruction-specific slice of check f. `rebuild` reconstructs the
 * expected ix1 from live-read chain state (ctx) plus any values deliberately
 * extracted from the wire — those extracted values are the caller's human
 * confirm items and are returned untouched in `extracted`, never judged
 * here. It may refuse (ok:false) if a wire-fed value is unextractable.
 */
export interface AdminIx1Descriptor<TExtracted> {
  /** Exact required ix1 data length (discriminator + params), in bytes. */
  readonly expectedDataLength: number;
  /** Position → human label for account-mismatch reasons. */
  readonly accountPositionLabels: readonly string[];
  rebuild(
    ix1: DecodedAdminTxInstruction,
    ctx: CountersignContext,
  ): RebuildResult<TExtracted>;
}

export type AdminVerifyCoreVerdict<TExtracted> =
  | { readonly ok: true; readonly extracted: TExtracted }
  | AdminVerifyFailure;

export function verifyAdminCountersignCore<TExtracted>(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage,
  frame: SignerFrame,
  descriptor: AdminIx1Descriptor<TExtracted>,
): AdminVerifyCoreVerdict<TExtracted> {
  // a. exactly 2 instructions
  if (decoded.instructions.length !== 2) {
    return {
      ok: false,
      reason: `expected exactly 2 instructions, got ${decoded.instructions.length}`,
    };
  }

  // b. exactly 2 signature slots; fee-payer slot signed and == the frame
  //    initiator; the frame countersigner slot present and in the stage's
  //    required state (countersign: NOT signed; submit: signed); no stray
  //    slot signed.
  if (decoded.signatures.length !== 2) {
    return {
      ok: false,
      reason: `expected exactly 2 signature slots, got ${decoded.signatures.length}`,
    };
  }
  const feePayerSlot = decoded.signatures[0];
  if (feePayerSlot === undefined) {
    return { ok: false, reason: "missing fee-payer signature slot" };
  }
  if (!feePayerSlot.signed) {
    return {
      ok: false,
      reason: `fee-payer slot ${feePayerSlot.address} is not signed`,
    };
  }
  if (feePayerSlot.address !== frame.initiator) {
    return {
      ok: false,
      reason: `fee-payer slot is ${feePayerSlot.address}, not the live on-chain ${frame.initiatorLabel} ${frame.initiator}`,
    };
  }
  const countersignerSlot = decoded.signatures.find(
    (s) => s.address === frame.countersigner,
  );
  if (countersignerSlot === undefined) {
    return {
      ok: false,
      reason: `no signature slot for the live on-chain ${frame.countersignerLabel} ${frame.countersigner}`,
    };
  }
  if (stage === "countersign" && countersignerSlot.signed) {
    return {
      ok: false,
      reason: `${frame.countersignerLabel} slot ${frame.countersigner} is already signed`,
    };
  }
  if (stage === "submit" && !countersignerSlot.signed) {
    return {
      ok: false,
      reason: `${frame.countersignerLabel} slot ${frame.countersigner} is not signed — the envelope is not countersigned`,
    };
  }
  const straySigned = decoded.signatures.find(
    (s) =>
      s.address !== frame.initiator &&
      s.address !== frame.countersigner &&
      s.signed,
  );
  if (straySigned !== undefined) {
    return {
      ok: false,
      reason: `unexpected signed slot ${straySigned.address}`,
    };
  }

  // c. fee payer field
  if (decoded.feePayer !== frame.initiator) {
    return {
      ok: false,
      reason: `fee payer ${decoded.feePayer} is not the live ${frame.initiatorLabel} ${frame.initiator}`,
    };
  }

  // d. nonce freshness
  if (decoded.nonceValue !== ctx.liveNonceValue) {
    return {
      ok: false,
      reason: `stale nonce: transaction nonce ${decoded.nonceValue} != live nonce ${ctx.liveNonceValue}`,
    };
  }

  // e. instruction 0 is AdvanceNonceAccount over the frame's nonce account,
  //    with the frame initiator as nonce authority.
  const ix0 = decoded.instructions[0];
  const ix1 = decoded.instructions[1];
  if (ix0 === undefined || ix1 === undefined) {
    return { ok: false, reason: "missing instruction 0 or 1" };
  }
  if (ix0.programAddress !== ctx.systemProgram) {
    return {
      ok: false,
      reason: `instruction 0 program is ${ix0.programAddress}, not the System program ${ctx.systemProgram}`,
    };
  }
  const ix0DataHex = Buffer.from(ix0.data).toString("hex");
  if (ix0DataHex !== "04000000") {
    return {
      ok: false,
      reason: `instruction 0 data is ${ix0DataHex}, not AdvanceNonceAccount (04000000)`,
    };
  }
  if (ix0.accounts[0] !== frame.nonceAccount) {
    return {
      ok: false,
      reason: `instruction 0 nonce account is ${ix0.accounts[0]}, not the ${frame.initiatorLabel} nonce account ${frame.nonceAccount}`,
    };
  }
  if (ix0.accounts[2] !== frame.initiator) {
    return {
      ok: false,
      reason: `instruction 0 nonce authority is ${ix0.accounts[2]}, not the live ${frame.initiatorLabel} ${frame.initiator}`,
    };
  }

  // f. instruction 1: frame (program + exact data length), then
  //    reconstruct-and-compare against the descriptor's rebuild over the
  //    live authorities.
  if (ix1.programAddress !== ctx.programId) {
    return {
      ok: false,
      reason: `instruction 1 program is ${ix1.programAddress}, not the issuer-ops program ${ctx.programId}`,
    };
  }
  if (ix1.data.length !== descriptor.expectedDataLength) {
    return {
      ok: false,
      reason: `instruction 1 data must be ${descriptor.expectedDataLength} bytes, got ${ix1.data.length}`,
    };
  }
  const rebuilt = descriptor.rebuild(ix1, ctx);
  if (!rebuilt.ok) {
    return rebuilt;
  }
  const receivedDataHex = Buffer.from(ix1.data).toString("hex");
  const rebuiltDataHex = Buffer.from(rebuilt.instruction.data).toString("hex");
  if (receivedDataHex !== rebuiltDataHex) {
    // For discriminator-only data (8 bytes) the two branches coincide: the
    // full hex IS the first 16 hex chars, so the discriminator wording is
    // exactly the pre-extraction resume reason.
    if (receivedDataHex.slice(0, 16) !== rebuiltDataHex.slice(0, 16)) {
      return {
        ok: false,
        reason: `instruction 1 discriminator is ${receivedDataHex.slice(0, 16)}, expected ${rebuiltDataHex.slice(0, 16)}`,
      };
    }
    return {
      ok: false,
      reason: `instruction 1 data mismatch: received ${receivedDataHex}, rebuilt ${rebuiltDataHex}`,
    };
  }
  const rebuiltAccounts = rebuilt.instruction.accounts.map((a) => a.address);
  if (ix1.accounts.length !== rebuiltAccounts.length) {
    return {
      ok: false,
      reason: `instruction 1 has ${ix1.accounts.length} accounts, expected ${rebuiltAccounts.length}`,
    };
  }
  for (let i = 0; i < rebuiltAccounts.length; i += 1) {
    if (ix1.accounts[i] !== rebuiltAccounts[i]) {
      return {
        ok: false,
        reason: `instruction 1 account ${i} (${descriptor.accountPositionLabels[i] ?? "unknown"}) is ${ix1.accounts[i]}, expected ${rebuiltAccounts[i]}`,
      };
    }
  }

  return { ok: true, extracted: rebuilt.extracted };
}
