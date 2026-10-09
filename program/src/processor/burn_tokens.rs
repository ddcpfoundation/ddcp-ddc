//! I-3 `burn_tokens`. Signing tier: Issuer + Reserve, 2-of-2 — symmetric with
//! I-2: both parties sanction every reduction in supply.
//!
//! **No pause check — deliberately:** the pause blocks I-2 only;
//! redemption is always available. The integration suite pins a successful
//! burn while `pause_active == true`.
//!
//! **Two distinct owner checks on `source`:**
//! (a) the ACCOUNT-ownership check — `source`'s `AccountInfo.owner`
//! must be the canonical Token-2022 program (ownership stage,
//! `InvalidAccountOwner`); and (b) the deserialized SPL token-account
//! `.owner` FIELD must equal PDA-5 — the FINAL authority-stage check
//! (`Unauthorized`). They are different checks at different ladder stages;
//! never conflate or collapse them.
//!
//! CPI: Token-2022 `Burn`, signed by PDA-5 (Redemption Collection Authority)
//! via `invoke_signed` over the CANONICAL bump returned by the derivation
//! check. Unlike I-2's PDA-1, PDA-5 is dataless — there is no
//! stored bump; the single `assert_pda` call yields both the key check and
//! the signing bump. `find_program_address` is never re-run per use.

use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{instruction::BurnTokensArgs, pda, state::MintState, validation};

/// I-3 — accounts: `mint` (writable) · `source` (writable) ·
/// `PDA-1` (read) · `PDA-5` (read, CPI signer) · `issuer_authority` (signer) ·
/// `reserve_authority` (signer) · `token_2022_program`.
pub fn process_burn_tokens(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: borsh must consume the remainder exactly.
    let args =
        BurnTokensArgs::try_from_slice(args).map_err(|_| ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let source = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let pda5 = next_account_info(iter)?;
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

    // source — owner check (a): ACCOUNT ownership (`AccountInfo.owner`), the
    // ownership-stage check. The `.owner` FIELD check (b) sits at the end of
    // the authority stage below.
    validation::assert_owned_by(source, &spl_token_2022_interface::id())?;
    validation::assert_writable(source)?;
    // The token-account-mint check closes the data-load stage — it precedes
    // the signer/authority checks, pinned by the
    // mismatch-beats-wrong-signer test.
    validation::assert_token_account_mint(source, mint.key)?;

    // PDA-1 is read-only here: ownership + derivation + data integrity.
    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    let state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // PDA-5: the derivation check IS the bump derivation — the returned
    // canonical bump signs the Burn CPI below.
    let pda5_bump = validation::assert_pda(
        pda5,
        &[pda::REDEMPTION_AUTHORITY_SEED, mint.key.as_ref()],
        program_id,
    )?;

    // Signer status + authority match: Issuer + Reserve 2-of-2.
    validation::assert_authority(issuer, &state.issuer_authority)?;
    validation::assert_authority(reserve, &state.reserve_authority)?;

    // Owner check (b), the FINAL authority-stage check: the token
    // account's `.owner` FIELD must be PDA-5.
    validation::assert_token_account_owner_field(source, pda5.key)?;

    // No pause check — redemption is always available.

    let burn_ix = spl_token_2022_interface::instruction::burn(
        token_program.key,
        source.key,
        mint.key,
        pda5.key,
        &[],
        args.amount,
    )?;
    invoke_signed(
        &burn_ix,
        &[
            source.clone(),
            mint.clone(),
            pda5.clone(),
            token_program.clone(),
        ],
        &[&[
            pda::REDEMPTION_AUTHORITY_SEED,
            mint.key.as_ref(),
            &[pda5_bump],
        ]],
    )
}
