// I-6 update_transfer_fee typed instruction builder. Pure and synchronous:
// every address arrives already resolved — PDA-3 (the fee authority that
// CPI-signs SetTransferFee) is derived by the caller, never here. Mirrors
// instructions/burn-tokens.ts.

import { createHash } from "node:crypto";
import {
  AccountRole,
  getU16Encoder,
  getU64Encoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors burn-tokens.ts) — expected value is
// 876a394d5df7d29e, asserted below at module load.
export const UPDATE_TRANSFER_FEE_DISCRIMINATOR: Uint8Array = createHash(
  "sha256",
)
  .update("global:update_transfer_fee")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "876a394d5df7d29e";
if (
  Buffer.from(UPDATE_TRANSFER_FEE_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `update_transfer_fee discriminator mismatch: computed ${Buffer.from(
      UPDATE_TRANSFER_FEE_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

export interface UpdateTransferFeeInput {
  mint: Address;
  /**
   * PDA-3 Fee Authority — CPI signer on-chain (the program invoke_signs
   * SetTransferFee over its seeds), NOT a transaction-level signer.
   */
  feeAuthority: Address;
  /** PDA-1 MintState — WRITABLE in I-6 (minimum_fee is written directly). */
  mintState: Address;
  issuerAuthority: Address;
  operatorAuthority: Address;
  token2022Program: Address;
  /** Range-checked by the u16 encoder: 0 <= bps < 2^16. */
  newFeeBasisPoints: number;
  /** Range-checked by the u64 encoder: 0 <= max < 2^64. */
  newMaximumFee: bigint;
  /** Range-checked by the u64 encoder: 0 <= min < 2^64. */
  newMinimumFee: bigint;
}

// Instruction with `accounts` and `data` present (both are optional on the
// base kit type; this builder always sets them).
export interface UpdateTransferFeeInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-6 update_transfer_fee instruction. Data is 26 bytes:
 * discriminator (8) ++ new_fee_basis_points u16 LE (2) ++ new_maximum_fee
 * u64 LE (8) ++ new_minimum_fee u64 LE (8). Accounts are exactly the six
 * I-6 accounts, in order; issuer and Operator are the 2-of-2 readonly
 * signers; PDA-3 is READONLY — it signs only the SetTransferFee CPI
 * on-chain, never the transaction; PDA-1 is WRITABLE (minimum_fee written
 * directly). No bps <= 10000 or min <= max guard here — the countersign
 * confirm gate and the on-chain FeeBoundsInvalid check own the bounds; the encoders
 * provide the only range checks, as in mint/burn.
 */
export function buildUpdateTransferFeeInstruction(
  input: UpdateTransferFeeInput,
): UpdateTransferFeeInstruction {
  const data = new Uint8Array(26);
  data.set(UPDATE_TRANSFER_FEE_DISCRIMINATOR, 0);
  data.set(getU16Encoder().encode(input.newFeeBasisPoints), 8);
  data.set(getU64Encoder().encode(input.newMaximumFee), 10);
  data.set(getU64Encoder().encode(input.newMinimumFee), 18);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.WRITABLE },
      { address: input.feeAuthority, role: AccountRole.READONLY },
      { address: input.mintState, role: AccountRole.WRITABLE },
      { address: input.issuerAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.operatorAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.token2022Program, role: AccountRole.READONLY },
    ],
    data,
  };
}
