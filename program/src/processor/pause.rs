//! I-4 `pause_issuance` and I-5 `resume_issuance`. Signing tiers: I-4 any
//! 1-of-3, so the pause needs no coordination; I-5 Issuer + Reserve 2-of-2, so
//! Operator alone cannot restart minting. Both idempotent. The pause blocks I-2
//! only; burns and user-to-user transfers are unaffected.
//!
//! Account #0 on both is `mint`, read-only, seed input only — its data is never
//! read; a wrong mint key is caught when the PDA derivation check fails.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{error::DdcError, pda, state::MintState, validation};

/// I-4 — accounts: `mint` (read-only, seed only) · `PDA-1` (writable) ·
/// `authority` (signer, any of the three).
pub fn process_pause_issuance(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: I-4 takes no arguments; any remainder is rejected.
    if !args.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let authority = next_account_info(iter)?;

    // Structural checks on PDA-1: ownership -> derivation -> writable.
    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    validation::assert_writable(pda1)?;

    let mut state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // Signer status + authority match: any 1-of-3.
    validation::assert_signer(authority)?;
    if authority.key != &state.issuer_authority
        && authority.key != &state.operator_authority
        && authority.key != &state.reserve_authority
    {
        return Err(DdcError::Unauthorized.into());
    }

    // Idempotent: sets the flag regardless of prior value; never errors on
    // an already-paused mint.
    state.pause_active = true;
    let mut data = pda1.try_borrow_mut_data()?;
    state.save(&mut data[..])
}

/// I-5 — accounts: `mint` (read-only, seed only) ·
/// `PDA-1` (writable) · `issuer_authority` (signer) · `reserve_authority` (signer).
pub fn process_resume_issuance(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: I-5 takes no arguments.
    if !args.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let issuer = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;

    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    validation::assert_writable(pda1)?;

    let mut state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // Positional 2-of-2: issuer slot must match the stored issuer
    // authority, reserve slot the stored Reserve authority. Operator in either slot fails
    // with Unauthorized: Operator alone cannot restart minting.
    validation::assert_authority(issuer, &state.issuer_authority)?;
    validation::assert_authority(reserve, &state.reserve_authority)?;

    // Idempotent.
    state.pause_active = false;
    let mut data = pda1.try_borrow_mut_data()?;
    state.save(&mut data[..])
}
