// I-4 pause_issuance typed instruction builder.
// Pure and synchronous: every address arrives already resolved; no
// derivation, no I/O. I-4 is single-signer (any 1-of-3), so assembly
// is an ordinary blockhash transaction — NO durable nonce (forbids
// gold-plating single-signer instructions). Mirrors
// instructions/resume-issuance.ts, minus the second signer.

import { createHash } from "node:crypto";
import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors resume-issuance.ts) — expected value is
// c70d81ec90b58a98, asserted below at module load.
export const PAUSE_ISSUANCE_DISCRIMINATOR: Uint8Array = createHash("sha256")
  .update("global:pause_issuance")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "c70d81ec90b58a98";
if (
  Buffer.from(PAUSE_ISSUANCE_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `pause_issuance discriminator mismatch: computed ${Buffer.from(
      PAUSE_ISSUANCE_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

export interface PauseIssuanceInput {
  mint: Address;
  /** PDA-1 MintState — WRITABLE in I-4 (it sets pause_active: true). */
  mintState: Address;
  /** Any ONE of the three PDA-1 authorities (1-of-3); which one is
   * role-guarded at the command layer, not here. */
  authority: Address;
}

// Instruction with `accounts` and `data` present (both are optional on the
// base kit type; this builder always sets them).
export interface PauseIssuanceInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-4 pause_issuance instruction. Data is the 8-byte
 * discriminator ONLY (no params). Accounts are exactly the three I-4
 * accounts, in order — mint (readonly — PDA-derivation seed input),
 * PDA-1 (writable — sets pause_active: true), and ONE readonly signer
 * (any 1-of-3 — issuer, Operator, or Reserve). Idempotent on-chain. NO
 * token_2022_program: I-4 touches only PDA-1.
 */
export function buildPauseIssuanceInstruction(
  input: PauseIssuanceInput,
): PauseIssuanceInstruction {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.mintState, role: AccountRole.WRITABLE },
      { address: input.authority, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from(PAUSE_ISSUANCE_DISCRIMINATOR),
  };
}
