// PDA-1 MintState account decoder — corrected layout, 178 bytes:
//   [0:8]     account discriminator = SHA-256("account:MintState")[0:8]
//   [8]       pause_active (bool)
//   [9:41]    issuer_authority   (Pubkey)
//   [41:73]   operator_authority (Pubkey)
//   [73:105]  reserve_authority (Pubkey)
//   [105:113] minimum_fee (u64 LE) — offset 105, NOT 106
//   [113:115] fee_ceiling_basis_points (u16 LE) — genesis-settled, never updated
//   [115:123] fee_ceiling_base_units (u64 LE) — genesis-settled, never updated
//   [123:177] reserved (54 bytes, zeroed)
//   [177]     bump
// A PDA-1 written before the ceilings existed carries zeros in [113:123] and
// therefore reads as ceilings of 0 bps / 0 base units.

import { createHash } from "node:crypto";
import { getAddressDecoder, type Address } from "@solana/kit";

const MINT_STATE_LEN = 178;

// Computed, not hardcoded — expected value is 51118f7817391675.
const EXPECTED_DISCRIMINATOR: Buffer = createHash("sha256")
  .update("account:MintState")
  .digest()
  .subarray(0, 8);

const addressDecoder = getAddressDecoder();

export interface MintState {
  pauseActive: boolean;
  issuer: Address;
  operator: Address;
  reserve: Address;
  minimumFee: bigint;
  /** Genesis-settled ceiling on the fee rate, basis points (0..10000). */
  feeCeilingBasisPoints: number;
  /** Genesis-settled ceiling on the per-transfer maximum fee, base units. */
  feeCeilingBaseUnits: bigint;
  bump: number;
}

export function decodeMintState(data: Uint8Array): MintState {
  if (data.length !== MINT_STATE_LEN) {
    throw new Error(
      `MintState account data must be exactly ${MINT_STATE_LEN} bytes, got ${data.length}`,
    );
  }
  const discriminator = Buffer.from(data.subarray(0, 8));
  if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
    throw new Error(
      `MintState discriminator mismatch: expected ${EXPECTED_DISCRIMINATOR.toString("hex")}, got ${discriminator.toString("hex")}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pauseActive: view.getUint8(8) !== 0,
    issuer: addressDecoder.decode(data.subarray(9, 41)),
    operator: addressDecoder.decode(data.subarray(41, 73)),
    reserve: addressDecoder.decode(data.subarray(73, 105)),
    minimumFee: view.getBigUint64(105, true),
    feeCeilingBasisPoints: view.getUint16(113, true),
    feeCeilingBaseUnits: view.getBigUint64(115, true),
    bump: view.getUint8(177),
  };
}
