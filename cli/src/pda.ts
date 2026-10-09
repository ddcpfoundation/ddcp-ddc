// PDA derivation for the Issuer Operations Program.

import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import {
  ATTESTATION_SEED,
  FEE_AUTHORITY_SEED,
  MINT_STATE_SEED,
  REDEMPTION_AUTHORITY_SEED,
} from "./constants.js";

const addressEncoder = getAddressEncoder();

// PDA-1 MintState: seeds [b"mint_state", mint_pubkey].
export async function deriveMintStatePda(
  programAddress: Address,
  mintAddress: Address,
): Promise<readonly [Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [MINT_STATE_SEED, addressEncoder.encode(mintAddress)],
  });
  return [pda, bump];
}

// PDA-5 Redemption Collection Authority: seeds [b"redemption_authority",
// mint_pubkey] — signing identity only, no account data; owns the FI
// redemption-collection token account and CPI-signs the I-3 Burn on-chain.
export async function deriveRedemptionAuthorityPda(
  programAddress: Address,
  mintAddress: Address,
): Promise<readonly [Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [REDEMPTION_AUTHORITY_SEED, addressEncoder.encode(mintAddress)],
  });
  return [pda, bump];
}

// PDA-2 AttestationRecord: seeds [b"attestation", mint_pubkey]. Written by I-7
// publish_attestation (Reserve-only 1-of-1); public transparency record, NOT a
// mint gate (I-2 never reads it). On the reference devnet mint:
// 7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP (bump 255).
export async function deriveAttestationPda(
  programAddress: Address,
  mintAddress: Address,
): Promise<readonly [Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [ATTESTATION_SEED, addressEncoder.encode(mintAddress)],
  });
  return [pda, bump];
}

// PDA-3 Fee Authority: seeds [b"fee_authority", mint_pubkey]. Signing identity
// only, no account data; configured as the mint's TransferFeeConfig authority.
// The program CPI-signs Token-2022 SetTransferFee via invoke_signed over this
// PDA in I-6 update_transfer_fee. On the reference devnet mint:
// 48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu (bump 255).
export async function deriveFeeAuthorityPda(
  programAddress: Address,
  mintAddress: Address,
): Promise<readonly [Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [FEE_AUTHORITY_SEED, addressEncoder.encode(mintAddress)],
  });
  return [pda, bump];
}
