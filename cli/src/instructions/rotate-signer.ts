// I-8 rotate_signer typed instruction builder.
// Pure and synchronous: every address arrives already resolved.
// PDA-1 MintState is the only writable account; there is no CPI and no
// fee/redemption authority account (contrast I-6, which CPI-signs
// SetTransferFee over PDA-3). Mirrors instructions/update-transfer-fee.ts.

import { createHash } from "node:crypto";
import {
  AccountRole,
  getAddressEncoder,
  getU8Encoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors update-transfer-fee.ts) — expected value
// is c687351b15cb0800, asserted below at module load.
export const ROTATE_SIGNER_DISCRIMINATOR: Uint8Array = createHash("sha256")
  .update("global:rotate_signer")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "c687351b15cb0800";
if (
  Buffer.from(ROTATE_SIGNER_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `rotate_signer discriminator mismatch: computed ${Buffer.from(
      ROTATE_SIGNER_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

export interface RotateSignerInput {
  mint: Address;
  /** PDA-1 MintState — WRITABLE; the stored authority pubkey is overwritten. */
  mintState: Address;
  /** Sec 4.4 2-of-2 signers; Operator initiates, Reserve countersigns. */
  operatorAuthority: Address;
  reserveAuthority: Address;
  /**
   * 0=Issuer, 1=Operator, 2=Reserve. Range-checked 0..255 by the u8 encoder; the
   * role<=2 bound is owned by the on-chain InvalidRole (6005) check and the
   * --confirm-role gate, not duplicated here (mirrors I-6's no-bounds-guard).
   */
  role: number;
  /**
   * New authority pubkey for the selected role. !=default enforced on-chain
   * (InvalidPubkey 6004); the --confirm-new-signer exact-match gate is the
   * client-side control.
   */
  newPubkey: Address;
}

export interface RotateSignerInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-8 rotate_signer instruction. Data is 41 bytes: discriminator
 * (8) ++ role u8 (1) ++ new_pubkey 32B (9..41); borsh field order is role
 * then new_pubkey per Sec 4.6. Accounts are exactly the four Sec 4.6 I-8
 * accounts, in order: mint READONLY (PDA-derivation seed input),
 * PDA-1 WRITABLE (the rotated authority is written directly), operatorAuthority
 * and reserveAuthority READONLY_SIGNER (Sec 4.4 2-of-2). No CPI — no PDA-3 fee
 * authority, no token-2022 program account (contrast I-6).
 */
export function buildRotateSignerInstruction(
  input: RotateSignerInput,
): RotateSignerInstruction {
  const data = new Uint8Array(41);
  data.set(ROTATE_SIGNER_DISCRIMINATOR, 0);
  data.set(getU8Encoder().encode(input.role), 8);
  data.set(getAddressEncoder().encode(input.newPubkey), 9);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.mintState, role: AccountRole.WRITABLE },
      { address: input.operatorAuthority, role: AccountRole.READONLY_SIGNER },
      { address: input.reserveAuthority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}
