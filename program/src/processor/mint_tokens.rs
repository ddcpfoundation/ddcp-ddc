//! I-2 `mint_tokens`. Signing tier: Issuer + Reserve, 2-of-2 — new supply needs
//! both the issuer and the reserve.
//!
//! **Attestation is not a mint gate:** PDA-2 appears
//! nowhere in this handler's account list and is never read. The integration
//! suite pins a successful mint with no PDA-2 account in existence.
//!
//! **Validation order — authority before business:** both signer/authority
//! matches are checked BEFORE `pause_active`, so paused + wrong signer returns
//! `Unauthorized` (6001), not `MintPaused` (6000).
//!
//! CPI: Token-2022 `MintTo`, signed by PDA-1 (Mint Authority dual role) via
//! `invoke_signed` over the STORED `MintState.bump`; the derivation check
//! still runs canonically.

use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{error::DdcError, instruction::MintTokensArgs, pda, state::MintState, validation};

/// I-2 — accounts: `mint` (writable) · `destination` (writable) ·
/// `PDA-1` (read) · `issuer_authority` (signer) · `reserve_authority` (signer) ·
/// `token_2022_program`.
pub fn process_mint_tokens(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: borsh must consume the remainder exactly.
    let args =
        MintTokensArgs::try_from_slice(args).map_err(|_| ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let issuer = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    // Program-id check first: the ownership checks below compare
    // against the same canonical Token-2022 identity this validates.
    validation::assert_program_id(token_program, &spl_token_2022_interface::id())?;

    // Structural checks, grouped per account in account-list order.
    // mint: seed input and CPI target.
    validation::assert_owned_by(mint, &spl_token_2022_interface::id())?;
    validation::assert_writable(mint)?;

    // destination: the token-account-mint check closes the data-load stage —
    // it precedes the signer/authority checks, pinned by the
    // mismatch-beats-wrong-signer test.
    validation::assert_owned_by(destination, &spl_token_2022_interface::id())?;
    validation::assert_writable(destination)?;
    validation::assert_token_account_mint(destination, mint.key)?;

    // PDA-1 is read-only here: ownership + derivation + data integrity.
    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    let state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // Signer status + authority match: Issuer + Reserve 2-of-2.
    validation::assert_authority(issuer, &state.issuer_authority)?;
    validation::assert_authority(reserve, &state.reserve_authority)?;

    // Business validation last: the pause gate.
    if state.pause_active {
        return Err(DdcError::MintPaused.into());
    }

    let mint_to_ix = spl_token_2022_interface::instruction::mint_to(
        token_program.key,
        mint.key,
        destination.key,
        pda1.key,
        &[],
        args.amount,
    )?;
    invoke_signed(
        &mint_to_ix,
        &[
            mint.clone(),
            destination.clone(),
            pda1.clone(),
            token_program.clone(),
        ],
        &[&[pda::MINT_STATE_SEED, mint.key.as_ref(), &[state.bump]]],
    )
}
