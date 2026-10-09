//! DDC Issuer Operations Program.
//!
//! Native Rust (no Anchor), with Anchor-compatible discriminators and naming.
//! Holds Mint Authority over the DDC Token-2022 mint through PDA-1, which is
//! also the program's state account. 8 instructions (I-1..I-8) and 4
//! program-derived accounts (PDA-1, PDA-2, PDA-3, PDA-5; the number PDA-4 is
//! not used).

pub mod error;
pub mod instruction;
pub mod pda;
pub mod processor;
pub mod state;
pub mod validation;

#[cfg(not(feature = "no-entrypoint"))]
pub mod entrypoint;

// The address of the reference program on devnet. A deployment to any other
// cluster uses its own program keypair, and so its own address.
solana_program::declare_id!("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp");
