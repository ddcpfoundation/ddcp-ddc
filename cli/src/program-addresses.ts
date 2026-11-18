// Addresses and seeds fixed by the Solana network and by the reference
// program's own code, the same for every deployment and every currency built
// from this repository: program and sysvar addresses, and the PDA seed
// prefixes the program derives its records from. Deployment-specific values
// (cluster, program and mint addresses, nonce accounts) stay in constants.ts,
// which re-exports these for its existing importers.

import { address, type Address } from "@solana/kit";

// PDA-1 MintState seed prefix: b"mint_state".
export const MINT_STATE_SEED: Uint8Array = new TextEncoder().encode("mint_state");

// PDA-5 Redemption Collection Authority seed prefix: b"redemption_authority"
// — signing identity only, no account data.
export const REDEMPTION_AUTHORITY_SEED: Uint8Array = new TextEncoder().encode(
  "redemption_authority",
);

// PDA-2 AttestationRecord seed prefix: b"attestation" — I-7
// publish_attestation writes this record; public transparency, not a mint
// gate. No account data field on the seed side (the record lives in the
// derived account).
export const ATTESTATION_SEED: Uint8Array = new TextEncoder().encode("attestation");

// PDA-3 Fee Authority seed prefix: b"fee_authority" — signing identity
// only, no account data. Configured as the mint's TransferFeeConfig
// authority; the program CPI-signs Token-2022 SetTransferFee via
// invoke_signed over PDA-3 in I-6 update_transfer_fee.
export const FEE_AUTHORITY_SEED: Uint8Array = new TextEncoder().encode("fee_authority");

// Token-2022 program (Token Extensions program id).
export const TOKEN_2022_PROGRAM: Address = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

// System program.
export const SYSTEM_PROGRAM: Address = address(
  "11111111111111111111111111111111",
);

// Recent-blockhashes sysvar ("B1ockHashes" — digit 1), the second account of
// System AdvanceNonceAccount.
export const SYSVAR_RECENT_BLOCKHASHES: Address = address(
  "SysvarRecentB1ockHashes11111111111111111111",
);

// Instructions sysvar — the account ConfigureAccount reads to locate the
// verify-proof instruction at proofInstructionOffset. Stated explicitly rather
// than inherited from the encoder's compile-time default, on the rule
// against inherited values. Digit-1 spelling, same trap as the
// recent-blockhashes sysvar above.
export const SYSVAR_INSTRUCTIONS: Address = address(
  "Sysvar1nstructions1111111111111111111111111",
);
