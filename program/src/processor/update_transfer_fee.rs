//! I-6 `update_transfer_fee`. Signing tier: Issuer + Operator, 2-of-2; the
//! reserve takes no part in fee changes.
//!
//! Effects are atomic within the single instruction (any error reverts before
//! anything is committed): the Token-2022 `SetTransferFee` CPI sets
//! `fee_basis_points` + `maximum_fee`, then `minimum_fee` is written directly
//! into PDA-1 as a load-modify-save — every other MintState field (the three
//! authorities, `pause_active`, the two fee ceilings, `reserved`, the stored `bump`) passes through
//! untouched. The CPI runs first, so a CPI failure aborts before
//! `minimum_fee` is touched.
//!
//! **`new_fee_basis_points` is bounded by PDA-1's genesis-settled ceiling**
//! (`fee_ceiling_basis_points`, itself at most 10_000) and `new_maximum_fee`
//! by `fee_ceiling_base_units`; neither ceiling is written by any
//! instruction after I-1. The Token-2022 CPI's own bps <= 10_000 bound is
//! not pre-validated here and stays pinned invariant-style by the
//! bps-passthrough test under a ceiling seeded above that bound.
//!
//! CPI: signed by PDA-3 (Fee Authority) via `invoke_signed` over the
//! CANONICAL bump returned by the derivation check. Unlike I-2's PDA-1,
//! PDA-3 is dataless — there is no stored bump; the single `assert_pda` call
//! yields both the key check and the signing bump. PDA-1 signs nothing here:
//! writing a program-owned account needs no signature.

use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use spl_token_2022_interface::extension::transfer_fee::instruction::set_transfer_fee;

use crate::{
    error::DdcError, instruction::UpdateTransferFeeArgs, pda, state::MintState, validation,
};

/// I-6 — accounts: `mint` (writable) · `PDA-3` (read, CPI signer) ·
/// `PDA-1` (WRITABLE — distinct from I-2/I-3, which read it) ·
/// `issuer_authority` (signer) · `operator_authority` (signer) ·
/// `token_2022_program`.
pub fn process_update_transfer_fee(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: borsh must consume the remainder exactly.
    let args = UpdateTransferFeeArgs::try_from_slice(args)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let pda3 = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let issuer = next_account_info(iter)?;
    let operator = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    // Program-id check first.
    validation::assert_program_id(token_program, &spl_token_2022_interface::id())?;

    // Structural checks, grouped per account in account-list order.
    validation::assert_owned_by(mint, &spl_token_2022_interface::id())?;
    validation::assert_writable(mint)?;

    // PDA-3: dataless signing identity — the derivation check is the only
    // structural check that applies, and its returned canonical bump signs
    // the SetTransferFee CPI below.
    let pda3_bump = validation::assert_pda(
        pda3,
        &[pda::FEE_AUTHORITY_SEED, mint.key.as_ref()],
        program_id,
    )?;

    // PDA-1 is WRITTEN here: ownership -> derivation -> writable -> data
    // load.
    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    validation::assert_writable(pda1)?;
    let mut state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // Signer status + authority match: Issuer + Operator 2-of-2.
    validation::assert_authority(issuer, &state.issuer_authority)?;
    validation::assert_authority(operator, &state.operator_authority)?;

    // Business validation last: the fee-bounds check,
    // then the two genesis-settled ceilings in fixed order, rate before
    // maximum. Lowering a fee is never refused here. With minimum <= maximum
    // <= ceiling, the minimum is bounded by the absolute ceiling as well.
    if args.new_minimum_fee > args.new_maximum_fee {
        return Err(DdcError::FeeBoundsInvalid.into());
    }
    if args.new_fee_basis_points > state.fee_ceiling_basis_points {
        return Err(DdcError::FeeAboveCeiling.into());
    }
    if args.new_maximum_fee > state.fee_ceiling_base_units {
        return Err(DdcError::MaximumFeeAboveCeiling.into());
    }

    // Effects in order: the CPI first, then the PDA-1
    // write.
    let set_fee_ix = set_transfer_fee(
        token_program.key,
        mint.key,
        pda3.key,
        &[],
        args.new_fee_basis_points,
        args.new_maximum_fee,
    )?;
    invoke_signed(
        &set_fee_ix,
        &[mint.clone(), pda3.clone(), token_program.clone()],
        &[&[pda::FEE_AUTHORITY_SEED, mint.key.as_ref(), &[pda3_bump]]],
    )?;

    // Load-modify-save: only minimum_fee changes; every other field of the
    // loaded struct is written back verbatim (pinned by the field-preservation
    // test).
    state.minimum_fee = args.new_minimum_fee;
    let mut data = pda1.try_borrow_mut_data()?;
    state.save(&mut data[..])
}
