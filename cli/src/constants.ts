// Devnet defaults for the DDC CLI. These are DEFAULTS ONLY — each is
// overridable by the config file / CLI flags once those land; nothing
// here is a hardcoded production value.

import { address, type Address } from "@solana/kit";
import type { Commitment } from "@solana/kit";

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export const COMMITMENT: Commitment = "confirmed";

// Issuer Operations Program (deployed devnet build, M1).
export const PROGRAM_ID: Address = address(
  "Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp",
);

// Reference mint (devnet, five-extension genesis layout): the THIRD devnet
// genesis, I-1 v3 of 2026-09-29 (scripts/devnet_i1v3_*), the
// conforming instrument: Confidential Transfer mint authority none, fee
// ceilings 100 bps / 1,000,000 base units. Earlier devnet mints stay
// on-chain as history, reachable with --mint. Every PDA below is derived
// from this mint at runtime.
export const DDC_MINT: Address = address(
  "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa",
);

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

// Issuer-side durable-nonce account (devnet; nonce authority = the issuer key in PDA-1). The
// Operator nonce account is OPERATOR_NONCE_ACCOUNT below.
export const ISSUER_NONCE_ACCOUNT: Address = address(
  "Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE",
);

// Operator-side durable-nonce account (devnet; nonce authority = the operator key in PDA-1). Serves
// I-6 update_transfer_fee (Issuer-countersigned) and I-8 rotate_signer
// (Reserve-countersigned) — both Operator-initiated. Re-ground its nonce value
// before every two-party broadcast (each send advances it).
export const OPERATOR_NONCE_ACCOUNT: Address = address(
  "Sd4959ZK3E2hnyt9o2RHLVxe9NX4Z7Z2ZPcWjaNsnMf",
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
