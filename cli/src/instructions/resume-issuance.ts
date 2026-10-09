// I-5 resume_issuance typed instruction builder. Pure and synchronous: every
// address arrives already resolved; no derivation, no I/O. Assembly lives in
// tx/durable-nonce-tx.ts (generic), not here. Mirrors
// instructions/mint-tokens.ts; the two builders are kept separate.

import { createHash } from "node:crypto";
import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors mint-tokens.ts) — expected value is
// e10ad2de30200b92, asserted below at module load.
export const RESUME_ISSUANCE_DISCRIMINATOR: Uint8Array = createHash("sha256")
  .update("global:resume_issuance")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "e10ad2de30200b92";
if (
  Buffer.from(RESUME_ISSUANCE_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `resume_issuance discriminator mismatch: computed ${Buffer.from(
      RESUME_ISSUANCE_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

export interface ResumeIssuanceInput {
  mint: Address;
  /** PDA-1 MintState — WRITABLE in I-5 (it clears pause_active). */
  mintState: Address;
  issuerAuthority: Address;
  reserveAuthority: Address;
}

// Instruction with `accounts` and `data` present (both are optional on the
// base kit type; this builder always sets them).
export interface ResumeIssuanceInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-5 resume_issuance instruction. Data is the 8-byte
 * discriminator ONLY (no params). Accounts are exactly the four I-5
 * accounts, in order — mint (readonly), PDA-1 (writable), and the
 * 2-of-2 issuer + Reserve readonly signers. NO token_2022_program: I-5 touches
 * only PDA-1.
 */
export function buildResumeIssuanceInstruction(
  input: ResumeIssuanceInput,
): ResumeIssuanceInstruction {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.mintState, role: AccountRole.WRITABLE },
      { address: input.issuerAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.reserveAuthority, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from(RESUME_ISSUANCE_DISCRIMINATOR),
  };
}
