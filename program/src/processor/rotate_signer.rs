//! I-8 `rotate_signer`. Signing tier: Operator + Reserve 2-of-2 — the Issuer cannot
//! rotate any key, including its own, so a compromised Issuer key cannot
//! authorize its own replacement. An Issuer
//! signature in either signer slot fails the authority match with
//! `Unauthorized`.
//!
//! Role encoding is fixed: 0 = Issuer, 1 = Operator, 2 = Reserve, mapping
//! to `issuer_authority` / `operator_authority` / `reserve_authority` respectively —
//! each mapping is pinned individually in the integration tests.
//! Validation order is also fixed: `new_pubkey != default` (InvalidPubkey)
//! **before** `role <= 2` (InvalidRole).
//!
//! After the role check, the three keys as they would stand are required to be
//! distinct (CoSignersNotDistinct): a replacement may not give one role
//! another role's current key. Replacing a key with itself leaves the three
//! unchanged and stays permitted, as does self-rotation (the current Operator/Reserve
//! rotating their own slot).

use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{error::DdcError, instruction::RotateSignerArgs, pda, state::MintState, validation};

/// I-8 — accounts: `mint` (read-only, seed only) · `PDA-1` (writable) ·
/// `operator_authority` (signer) · `reserve_authority` (signer).
pub fn process_rotate_signer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: borsh must consume the remainder exactly.
    let args =
        RotateSignerArgs::try_from_slice(args).map_err(|_| ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let operator = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;

    // Structural checks on PDA-1: ownership -> derivation -> writable.
    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    validation::assert_writable(pda1)?;

    let mut state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // Signer status + authority match: Operator + Reserve, positional.
    validation::assert_authority(operator, &state.operator_authority)?;
    validation::assert_authority(reserve, &state.reserve_authority)?;

    // Business validation in the fixed order: pubkey, then role.
    if args.new_pubkey == Pubkey::default() {
        return Err(DdcError::InvalidPubkey.into());
    }
    match args.role {
        0 => state.issuer_authority = args.new_pubkey,
        1 => state.operator_authority = args.new_pubkey,
        2 => state.reserve_authority = args.new_pubkey,
        _ => return Err(DdcError::InvalidRole.into()),
    }
    validation::assert_distinct_co_signers(
        &state.issuer_authority,
        &state.operator_authority,
        &state.reserve_authority,
    )?;

    let mut data = pda1.try_borrow_mut_data()?;
    state.save(&mut data[..])
}
