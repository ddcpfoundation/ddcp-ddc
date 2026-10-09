// I-7 publish_attestation typed instruction builder.
// Pure and synchronous: every address arrives already resolved; no
// derivation, no I/O. I-7 is single-signer (Reserve-only 1-of-1), so
// assembly is an ordinary blockhash transaction — NO durable nonce (a
// single-signer instruction needs none). Mirrors
// instructions/pause-issuance.ts (single-signer shape), with params.
//
// attestation_uri is carried on the wire as a borsh Vec<u8> (u32 LE length
// prefix + bytes), length-validated <= 128 and zero-padded into the fixed
// [u8; 128] PDA-2 field ON-CHAIN — it is NOT a fixed 128-byte field on the
// wire (a raw [u8; 128] produces undecodable instruction
// data). Instruction data is therefore VARIABLE length: 20 + uri_byte_length.

import { createHash } from "node:crypto";
import {
  AccountRole,
  getU32Encoder,
  getU64Encoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";

// Computed, not hardcoded (mirrors pause-issuance.ts) — expected value is
// 7726782d56169137, asserted below at module load.
export const PUBLISH_ATTESTATION_DISCRIMINATOR: Uint8Array = createHash("sha256")
  .update("global:publish_attestation")
  .digest()
  .subarray(0, 8);

const EXPECTED_DISCRIMINATOR_HEX = "7726782d56169137";
if (
  Buffer.from(PUBLISH_ATTESTATION_DISCRIMINATOR).toString("hex") !==
  EXPECTED_DISCRIMINATOR_HEX
) {
  throw new Error(
    `publish_attestation discriminator mismatch: computed ${Buffer.from(
      PUBLISH_ATTESTATION_DISCRIMINATOR,
    ).toString("hex")}, expected ${EXPECTED_DISCRIMINATOR_HEX}`,
  );
}

// Maximum attestation_uri length in BYTES (UTF-8), matching the on-chain
// InvalidAttestationUri validation (I-7). Guarded in the builder so
// the client fails fast rather than emitting a tx the program rejects; the
// on-chain check remains the backstop.
export const MAX_ATTESTATION_URI_BYTES = 128;

export interface PublishAttestationInput {
  mint: Address;
  /** PDA-2 AttestationRecord — WRITABLE in I-7 (it is the write target). */
  attestation: Address;
  /** PDA-1 MintState — READONLY in I-7 (read only for the Reserve authority
   * match; I-7 does not mutate it). NOT writable — unlike I-4 pause. */
  mintState: Address;
  /** The Reserve authority (Reserve-only 1-of-1); role-guarded at the command
   * layer against a fresh PDA-1 read, not here. */
  reserveAuthority: Address;
  /** attested_reserve_amount. Range-checked by the u64 encoder: 0 <= amount < 2^64. */
  amount: bigint;
  /** attestation_uri as a UTF-8 string. Encoded to bytes and length-guarded
   * (<= 128 bytes) here; carried on the wire as a borsh Vec<u8>. */
  uri: string;
}

// Instruction with `accounts` and `data` present (both are optional on the
// base kit type; this builder always sets them).
export interface PublishAttestationInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * Build the I-7 publish_attestation instruction. Data is VARIABLE length:
 * discriminator (8) ++ amount u64 LE (8) ++ uri length u32 LE (4) ++ uri bytes
 * (N) = 20 + N, where N is the UTF-8 byte length of `uri` (<= 128). Accounts
 * are exactly the four I-7 accounts, in order — mint (readonly —
 * PDA-derivation seed input), PDA-2 (WRITABLE — the write target),
 * PDA-1 (READONLY — Reserve authority source, not mutated), and the Reserve readonly
 * signer (1-of-1). NO token_2022_program: I-7 touches only PDA-2. This is
 * a public transparency record, NOT a mint gate — I-2 never reads it.
 */
export function buildPublishAttestationInstruction(
  input: PublishAttestationInput,
): PublishAttestationInstruction {
  const uriBytes = new TextEncoder().encode(input.uri);
  if (uriBytes.length > MAX_ATTESTATION_URI_BYTES) {
    throw new Error(
      `attestation_uri is ${uriBytes.length} bytes (UTF-8); maximum is ${MAX_ATTESTATION_URI_BYTES} — would fail on-chain with InvalidAttestationUri`,
    );
  }
  const data = new Uint8Array(20 + uriBytes.length);
  data.set(PUBLISH_ATTESTATION_DISCRIMINATOR, 0);
  data.set(getU64Encoder().encode(input.amount), 8);
  data.set(getU32Encoder().encode(uriBytes.length), 16);
  data.set(uriBytes, 20);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.attestation, role: AccountRole.WRITABLE },
      { address: input.mintState, role: AccountRole.READONLY },
      { address: input.reserveAuthority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}
