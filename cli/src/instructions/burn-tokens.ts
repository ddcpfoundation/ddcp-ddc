// I-3 burn_tokens typed instruction builder. Pure and synchronous: every address arrives
// already resolved — PDA-5 (the redemption collection authority that owns
// the source account) is derived by the caller, never here.
// Mirrors instructions/mint-tokens.ts; the two builders are kept separate.

import { createHash } from "node:crypto";
import {
  AccountRole,
  getU64Encoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors mint-tokens.ts) — expected value is
// 4c0f33fee5d77942, asserted below at module load.
export const BURN_TOKENS_DISCRIMINATOR: Uint8Array = createHash("sha256")
  .update("global:burn_tokens")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "4c0f33fee5d77942";
if (
  Buffer.from(BURN_TOKENS_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `burn_tokens discriminator mismatch: computed ${Buffer.from(
      BURN_TOKENS_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

export interface BurnTokensInput {
  mint: Address;
  /** FI redemption-collection token account, owned by PDA-5. */
  source: Address;
  /** PDA-1 MintState — read-only in I-3. */
  mintState: Address;
  /**
   * PDA-5 Redemption Collection Authority — CPI signer on-chain (the
   * program invoke_signs over its seeds), NOT a transaction-level signer.
   */
  redemptionAuthority: Address;
  issuerAuthority: Address;
  reserveAuthority: Address;
  token2022Program: Address;
  /** Range-checked by the u64 encoder: 0 <= amount < 2^64. */
  amount: bigint;
}

// Instruction with `accounts` and `data` present (both are optional on the
// base kit type; this builder always sets them).
export interface BurnTokensInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-3 burn_tokens instruction. Data is 16 bytes: discriminator (8)
 * ++ amount u64 LE (8). Accounts are exactly the seven I-3 accounts, in
 * order; issuer and Reserve are the 2-of-2 readonly signers; PDA-5 is
 * READONLY — it signs only the Burn CPI on-chain, never the transaction. No
 * pause check exists on I-3 — redemption is always available.
 */
export function buildBurnTokensInstruction(
  input: BurnTokensInput,
): BurnTokensInstruction {
  const data = new Uint8Array(16);
  data.set(BURN_TOKENS_DISCRIMINATOR, 0);
  data.set(getU64Encoder().encode(input.amount), 8);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.WRITABLE },
      { address: input.source, role: AccountRole.WRITABLE },
      { address: input.mintState, role: AccountRole.READONLY },
      { address: input.redemptionAuthority, role: AccountRole.READONLY },
      { address: input.issuerAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.reserveAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.token2022Program, role: AccountRole.READONLY },
    ],
    data,
  };
}
