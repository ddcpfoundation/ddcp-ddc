//! Instruction dispatch: match the leading 8 bytes of instruction data against
//! the Anchor-compatible discriminators, route to the handler, and hand it the
//! remaining bytes as borsh-encoded arguments.
//!
//! Dispatch rules:
//! - data shorter than 8 bytes: no discriminator can exist -> `InvalidInstruction`
//! - unrecognized discriminator: `InvalidInstruction` immediately — **no
//!   fallthrough**
//!
//! All eight instructions route to their handlers.

pub mod burn_tokens;
pub mod initialize_mint;
pub mod mint_tokens;
pub mod pause;
pub mod publish_attestation;
pub mod rotate_signer;
pub mod update_transfer_fee;

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

use crate::error::DdcError;
use crate::instruction::*;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(DdcError::InvalidInstruction.into());
    }
    let (discriminator, args) = instruction_data.split_at(8);

    match <[u8; 8]>::try_from(discriminator).expect("split_at(8) yields 8 bytes") {
        INITIALIZE_MINT_DISCRIMINATOR => {
            initialize_mint::process_initialize_mint(program_id, accounts, args)
        }
        MINT_TOKENS_DISCRIMINATOR => mint_tokens::process_mint_tokens(program_id, accounts, args),
        BURN_TOKENS_DISCRIMINATOR => burn_tokens::process_burn_tokens(program_id, accounts, args),
        PAUSE_ISSUANCE_DISCRIMINATOR => pause::process_pause_issuance(program_id, accounts, args),
        RESUME_ISSUANCE_DISCRIMINATOR => pause::process_resume_issuance(program_id, accounts, args),
        UPDATE_TRANSFER_FEE_DISCRIMINATOR => {
            update_transfer_fee::process_update_transfer_fee(program_id, accounts, args)
        }
        PUBLISH_ATTESTATION_DISCRIMINATOR => {
            publish_attestation::process_publish_attestation(program_id, accounts, args)
        }
        ROTATE_SIGNER_DISCRIMINATOR => {
            rotate_signer::process_rotate_signer(program_id, accounts, args)
        }
        _ => Err(DdcError::InvalidInstruction.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::program_error::ProgramError;

    const INVALID_INSTRUCTION: ProgramError = ProgramError::Custom(6006);

    #[test]
    fn short_data_returns_invalid_instruction() {
        let program_id = crate::id();
        for len in 0..8 {
            let data = vec![0u8; len];
            assert_eq!(
                process(&program_id, &[], &data),
                Err(INVALID_INSTRUCTION),
                "data of length {len} must fail as InvalidInstruction"
            );
        }
    }

    #[test]
    fn unknown_discriminator_returns_invalid_instruction_no_fallthrough() {
        let program_id = crate::id();
        // An 8-byte value that is none of the eight known discriminators.
        let data = [0xffu8; 8];
        assert_eq!(process(&program_id, &[], &data), Err(INVALID_INSTRUCTION));
        // Flipping one bit of a known discriminator must also fail.
        let mut near_miss = MINT_TOKENS_DISCRIMINATOR;
        near_miss[0] ^= 0x01;
        assert_eq!(
            process(&program_id, &[], &near_miss),
            Err(INVALID_INSTRUCTION)
        );
    }

    #[test]
    fn initialize_mint_routes_past_dispatch() {
        let program_id = crate::id();
        // Decodable args + no accounts: the handler must be reached (strict
        // borsh decode succeeds) and fail on account acquisition — distinct
        // from Custom(6006), proving routing reached the real I-1 handler.
        let args = InitializeMintArgs {
            issuer_authority: Pubkey::default(),
            operator_authority: Pubkey::default(),
            reserve_authority: Pubkey::default(),
            confidential_transfer_mint_authority: None,
            confidential_transfer_fee_authority: Pubkey::default(),
            withdraw_withheld_authority_elgamal_pubkey: [0u8; 32],
            withdraw_withheld_authority: Pubkey::default(),
            name: String::new(),
            symbol: String::new(),
            uri: String::new(),
            metadata_pointer_authority: Pubkey::default(),
            fee_ceiling_basis_points: 0,
            fee_ceiling_base_units: 0,
        };
        let mut data = INITIALIZE_MINT_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&borsh::to_vec(&args).unwrap());
        assert_eq!(
            process(&program_id, &[], &data),
            Err(ProgramError::NotEnoughAccountKeys),
            "I-1 discriminator must reach the implemented handler"
        );
    }

    #[test]
    fn implemented_discriminators_route_past_dispatch() {
        let program_id = crate::id();
        // With no accounts supplied, an implemented handler fails on account
        // acquisition (NotEnoughAccountKeys) — distinct from Custom(6006),
        // proving routing reached the real handler.
        for disc in [
            MINT_TOKENS_DISCRIMINATOR,
            BURN_TOKENS_DISCRIMINATOR,
            PAUSE_ISSUANCE_DISCRIMINATOR,
            RESUME_ISSUANCE_DISCRIMINATOR,
            UPDATE_TRANSFER_FEE_DISCRIMINATOR,
            ROTATE_SIGNER_DISCRIMINATOR,
        ] {
            let mut data = disc.to_vec();
            // arg-bearing instructions need decodable args before account
            // acquisition.
            if disc == ROTATE_SIGNER_DISCRIMINATOR {
                data.push(0);
                data.extend_from_slice(&[1u8; 32]);
            }
            if disc == MINT_TOKENS_DISCRIMINATOR || disc == BURN_TOKENS_DISCRIMINATOR {
                data.extend_from_slice(&1u64.to_le_bytes());
            }
            if disc == UPDATE_TRANSFER_FEE_DISCRIMINATOR {
                data.extend_from_slice(&25u16.to_le_bytes());
                data.extend_from_slice(&1_000u64.to_le_bytes());
                data.extend_from_slice(&100u64.to_le_bytes());
            }
            assert_eq!(
                process(&program_id, &[], &data),
                Err(ProgramError::NotEnoughAccountKeys),
                "implemented discriminator must reach its handler"
            );
        }
    }
}
