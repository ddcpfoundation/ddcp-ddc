// I-2 mint_tokens typed instruction builder. Pure and synchronous: every
// address arrives already resolved; no derivation, no I/O. Transaction
// assembly, durable-nonce wiring, and serialization live in the command layer
// (3.1.b), not here.

import { createHash } from "node:crypto";
import {
  AccountRole,
  getU64Encoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors mint-state.ts) — expected value is
// 3b8418f67a2708f3, asserted below at module load.
export const MINT_TOKENS_DISCRIMINATOR: Uint8Array = createHash("sha256")
  .update("global:mint_tokens")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "3b8418f67a2708f3";
if (
  Buffer.from(MINT_TOKENS_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `mint_tokens discriminator mismatch: computed ${Buffer.from(
      MINT_TOKENS_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

export interface MintTokensInput {
  mint: Address;
  destination: Address;
  /** PDA-1 MintState — read-only in I-2. */
  mintState: Address;
  issuerAuthority: Address;
  reserveAuthority: Address;
  token2022Program: Address;
  /** Range-checked by the u64 encoder: 0 <= amount < 2^64. */
  amount: bigint;
}

// Instruction with `accounts` and `data` present (both are optional on the
// base kit type; this builder always sets them).
export interface MintTokensInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-2 mint_tokens instruction. Data is 16 bytes: discriminator
 * (8) ++ amount u64 LE (8). Accounts are exactly the six I-2 accounts,
 * in order; issuer and Reserve are the 2-of-2 readonly signers.
 */
export function buildMintTokensInstruction(
  input: MintTokensInput,
): MintTokensInstruction {
  const data = new Uint8Array(16);
  data.set(MINT_TOKENS_DISCRIMINATOR, 0);
  data.set(getU64Encoder().encode(input.amount), 8);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.WRITABLE },
      { address: input.destination, role: AccountRole.WRITABLE },
      { address: input.mintState, role: AccountRole.READONLY },
      { address: input.issuerAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.reserveAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.token2022Program, role: AccountRole.READONLY },
    ],
    data,
  };
}
