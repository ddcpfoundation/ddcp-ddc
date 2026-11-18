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

// Fixed network and program addresses and seeds live in program-addresses.ts;
// re-exported here so every existing import keeps resolving.
export {
  ATTESTATION_SEED,
  FEE_AUTHORITY_SEED,
  MINT_STATE_SEED,
  REDEMPTION_AUTHORITY_SEED,
  SYSTEM_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  SYSVAR_RECENT_BLOCKHASHES,
  TOKEN_2022_PROGRAM,
} from "./program-addresses.js";
