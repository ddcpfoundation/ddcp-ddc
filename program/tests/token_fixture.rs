//! Fixture fidelity proof + InvalidExtensionCombination negative. No handler
//! instructions are
//! exercised here — this suite proves the fixture layer itself, so every
//! later handler suite builds on a proven mint and a proven binary.

mod common;

use common::token::{
    assert_mint_fixture_valid, assert_no_ambient_token_2022, assert_token_2022_program_registered,
    assert_token_account_fixture_valid, create_three_extension_mint, create_token_account,
    load_pinned_token_2022, setup_token, svm_without_default_programs,
    try_create_two_extension_mint,
};
use solana_program::instruction::InstructionError;
use solana_program::pubkey::Pubkey;
use spl_token_2022_interface::error::TokenError;

/// Binary-identity assertions 1–3 (assertion 3 is a shallow registration
/// check):
/// no ambient Token-2022 in the no-defaults VM; the pinned load is
/// checksum-gated and is the sole injection point; the canonical address
/// holds an executable, loader-owned account afterward.
#[test]
fn pinned_token_2022_binary_identity() {
    let mut svm = svm_without_default_programs();
    assert_no_ambient_token_2022(&svm);
    let _pinned = load_pinned_token_2022(&mut svm);
    assert_token_2022_program_registered(&svm);
}

#[test]
fn fixture_is_valid_three_extension_mint() {
    let mut ctx = setup_token();
    let fx = create_three_extension_mint(&mut ctx.svm, &ctx.payer);
    assert_mint_fixture_valid(&ctx.svm, &fx);
}

#[test]
fn token_account_carries_transfer_fee_amount_extension() {
    let mut ctx = setup_token();
    let fx = create_three_extension_mint(&mut ctx.svm, &ctx.payer);
    let owner = Pubkey::new_unique();
    let account = create_token_account(&mut ctx.svm, &ctx.payer, &fx.mint, &owner);
    assert_token_account_fixture_valid(&ctx.svm, &account, &fx.mint, &owner);
}

/// The required-extension rule executed as a negative, not assumed: the pinned program
/// rejects ConfidentialTransferMint + TransferFeeConfig without
/// ConfidentialTransferFeeConfig, at the `initialize_mint2` instruction
/// (index 2 — the transaction holds only the two extension inits before it),
/// with the interface crate's own error value — not a hand-counted code.
#[test]
fn two_extension_mint_fails_invalid_extension_combination() {
    let mut ctx = setup_token();
    let (index, err) = try_create_two_extension_mint(&mut ctx.svm, &ctx.payer).unwrap_err();
    assert_eq!(index, 2, "failure must surface at initialize_mint2");
    assert_eq!(
        err,
        InstructionError::Custom(TokenError::InvalidExtensionCombination as u32)
    );
}
