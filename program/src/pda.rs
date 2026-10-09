//! Canonical PDA derivations. Every handler validates supplied PDA accounts
//! against these derivations via `validation::assert_pda` — a missing check is
//! an audit finding.
//!
//! Program-derived accounts:
//! - **PDA-1 MintState** — state account AND the mint's Mint Authority (dual
//!   role): signs `MintTo` (I-2) and the on-mint `TokenMetadata` Initialize
//!   (I-1) via `invoke_signed` over `[b"mint_state", mint, [bump]]`.
//! - **PDA-2 AttestationRecord** — transparency record written by I-7 only.
//! - **PDA-3 Fee Authority** — signing identity only, no data; the mint's
//!   `fee_authority`; signs the `SetTransferFee` CPI in I-6.
//! - **PDA-5 Redemption Collection Authority** — signing identity only, no
//!   data; owns the redemption-collection token account; signs the `Burn` CPI
//!   in I-3.
//!
//! There is no PDA-4. Do not reuse the number.

use solana_program::pubkey::Pubkey;

pub const MINT_STATE_SEED: &[u8] = b"mint_state";
pub const ATTESTATION_SEED: &[u8] = b"attestation";
pub const FEE_AUTHORITY_SEED: &[u8] = b"fee_authority";
pub const REDEMPTION_AUTHORITY_SEED: &[u8] = b"redemption_authority";

/// PDA-1: `[b"mint_state", mint]`.
pub fn find_mint_state_address(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MINT_STATE_SEED, mint.as_ref()], program_id)
}

/// PDA-2: `[b"attestation", mint]`.
pub fn find_attestation_address(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ATTESTATION_SEED, mint.as_ref()], program_id)
}

/// PDA-3: `[b"fee_authority", mint]`.
pub fn find_fee_authority_address(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[FEE_AUTHORITY_SEED, mint.as_ref()], program_id)
}

/// PDA-5: `[b"redemption_authority", mint]`.
pub fn find_redemption_authority_address(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[REDEMPTION_AUTHORITY_SEED, mint.as_ref()], program_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivations_are_deterministic_and_distinct() {
        let program_id = crate::id();
        let mint = Pubkey::new_unique();

        let addrs = [
            find_mint_state_address(&mint, &program_id),
            find_attestation_address(&mint, &program_id),
            find_fee_authority_address(&mint, &program_id),
            find_redemption_authority_address(&mint, &program_id),
        ];

        // Deterministic: same inputs, same outputs.
        assert_eq!(addrs[0], find_mint_state_address(&mint, &program_id));

        // Distinct: no two PDAs may collide for the same mint.
        for i in 0..addrs.len() {
            for j in (i + 1)..addrs.len() {
                assert_ne!(addrs[i].0, addrs[j].0, "PDA collision between {i} and {j}");
            }
        }

        // Bumps match the canonical find_program_address result by construction;
        // verify each derived key round-trips through create_program_address.
        for (i, seed) in [
            MINT_STATE_SEED,
            ATTESTATION_SEED,
            FEE_AUTHORITY_SEED,
            REDEMPTION_AUTHORITY_SEED,
        ]
        .iter()
        .enumerate()
        {
            let (key, bump) = addrs[i];
            let recreated =
                Pubkey::create_program_address(&[seed, mint.as_ref(), &[bump]], &program_id)
                    .unwrap();
            assert_eq!(key, recreated);
        }
    }

    #[test]
    fn different_mints_derive_different_pdas() {
        let program_id = crate::id();
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        assert_ne!(
            find_mint_state_address(&mint_a, &program_id).0,
            find_mint_state_address(&mint_b, &program_id).0
        );
    }
}
