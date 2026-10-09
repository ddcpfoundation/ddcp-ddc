//! I-2 mint_tokens integration suite (LiteSVM, real program .so, pinned devnet
//! Token-2022 fixture layer). Pins the three validation-order rules
//! (authority before business), the attestation-is-not-a-mint-gate
//! constraint (mint succeeds with no PDA-2 account in existence), the
//! structural negatives, and the `TokenAccountMintMismatch` (6007) and
//! token-program id checks.

mod common;

use common::*;
use ddcp_ddc::pda;
use solana_keypair::Keypair;
use solana_program::instruction::{AccountMeta, InstructionError};
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::extension::StateWithExtensions;
use spl_token_2022_interface::state::{Account as TokenAccount, Mint};

use litesvm::LiteSVM;

fn mint_supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let acct = svm.get_account(mint).unwrap();
    StateWithExtensions::<Mint>::unpack(&acct.data)
        .unwrap()
        .base
        .supply
}

fn token_amount(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let acct = svm.get_account(account).unwrap();
    StateWithExtensions::<TokenAccount>::unpack(&acct.data)
        .unwrap()
        .base
        .amount
}

/// Correct metas for a ctx + destination; negatives mutate the result.
fn metas_for(ctx: &TokenHandlerCtx, destination: &Pubkey) -> Vec<AccountMeta> {
    mint_tokens_metas(
        &ctx.fx.mint,
        destination,
        &ctx.fx.pda1,
        &ctx.issuer.pubkey(),
        &ctx.reserve.pubkey(),
    )
}

// ---------------------------------------------------------------------------
// Positives
// ---------------------------------------------------------------------------

#[test]
fn mint_succeeds_credits_destination_and_supply() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let fi_owner = Pubkey::new_unique();
    let destination = token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &fi_owner);

    assert_eq!(mint_supply(&ctx.svm, &ctx.fx.mint), 0);
    let ix = mint_tokens_ix(metas_for(&ctx, &destination), 1_000_000);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]).unwrap();

    assert_eq!(token_amount(&ctx.svm, &destination), 1_000_000);
    assert_eq!(mint_supply(&ctx.svm, &ctx.fx.mint), 1_000_000);
    // PDA-1 state untouched by a mint.
    let state = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert!(!state.pause_active);
    assert_eq!(state.minimum_fee, 0);
}

/// Hard constraint: attestation is not a mint gate. No PDA-2 account
/// exists in this VM at all — I-2 neither receives nor reads it.
#[test]
fn mint_succeeds_with_no_attestation_record_in_existence() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();

    let (pda2, _) = pda::find_attestation_address(&ctx.fx.mint, &ddcp_ddc::id());
    assert!(
        ctx.svm.get_account(&pda2).is_none(),
        "precondition: PDA-2 must not exist for this pin"
    );

    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());
    let ix = mint_tokens_ix(metas_for(&ctx, &destination), 42);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]).unwrap();
    assert_eq!(token_amount(&ctx.svm, &destination), 42);
}

// ---------------------------------------------------------------------------
// Validation-order pins: authority before business
// ---------------------------------------------------------------------------

#[test]
fn paused_with_wrong_signer_is_unauthorized_not_mint_paused() {
    let mut ctx = setup_token_handlers(true);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let imposter = Keypair::new();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[3] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &reserve]);
    assert_custom(res, 6001); // Unauthorized wins over MintPaused
}

#[test]
fn paused_with_authorized_signers_is_mint_paused() {
    let mut ctx = setup_token_handlers(true);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let ix = mint_tokens_ix(metas_for(&ctx, &destination), 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6000); // MintPaused
}

#[test]
fn unpaused_wrong_issuer_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let imposter = Keypair::new();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[3] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &reserve]);
    assert_custom(res, 6001);
}

#[test]
fn unpaused_wrong_reserve_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let imposter = Keypair::new();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[4] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &imposter]);
    assert_custom(res, 6001);
}

#[test]
fn swapped_issuer_reserve_slots_are_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[3] = AccountMeta::new_readonly(reserve.pubkey(), true); // right keys,
    metas[4] = AccountMeta::new_readonly(issuer.pubkey(), true); // wrong slots
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6001);
}

// ---------------------------------------------------------------------------
// Strict / truncated args
// ---------------------------------------------------------------------------

#[test]
fn trailing_args_are_invalid_instruction_data() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut ix = mint_tokens_ix(metas_for(&ctx, &destination), 1);
    ix.data.push(0x00);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

#[test]
fn truncated_args_are_invalid_instruction_data() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut ix = mint_tokens_ix(metas_for(&ctx, &destination), 1);
    ix.data.truncate(ix.data.len() - 3); // cut amount short mid-field
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

// ---------------------------------------------------------------------------
// Structural negatives
// ---------------------------------------------------------------------------

// solana-instruction 3.x deprecates NotEnoughAccountKeys in favor of
// MissingAccount, but the runtime still maps ProgramError::NotEnoughAccountKeys
// to it — this assert pins actual runtime behavior.
#[allow(deprecated)]
#[test]
fn missing_token_program_account_is_not_enough_account_keys() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas.pop(); // drop token_2022_program
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::NotEnoughAccountKeys));
}

#[test]
fn pda1_wrong_owner_is_invalid_account_owner() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    // Same address, same data — owner flipped to a foreign program.
    let mut account = ctx.svm.get_account(&ctx.fx.pda1).unwrap();
    account.owner = Pubkey::new_unique();
    ctx.svm.set_account(ctx.fx.pda1, account).unwrap();

    let ix = mint_tokens_ix(metas_for(&ctx, &destination), 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidAccountOwner));
}

/// Cross-mint pairing: mint B's PDA-1 offered
/// against mint A must fail the canonical derivation.
#[test]
fn cross_mint_pda1_is_invalid_seeds() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mint_b = Pubkey::new_unique();
    let pda1_b = seed_mint_state(
        &mut ctx.svm,
        &mint_b,
        &issuer.pubkey(),
        &ctx.operator.pubkey(),
        &reserve.pubkey(),
        false,
    );

    let mut metas = metas_for(&ctx, &destination);
    metas[2] = AccountMeta::new_readonly(pda1_b, false);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn readonly_mint_is_immutable() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[0] = AccountMeta::new_readonly(ctx.fx.mint, false);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn readonly_destination_is_immutable() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[1] = AccountMeta::new_readonly(destination, false);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn issuer_not_signer_is_missing_required_signature() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[3] = AccountMeta::new_readonly(ctx.issuer.pubkey(), false);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&reserve]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn reserve_not_signer_is_missing_required_signature() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[4] = AccountMeta::new_readonly(ctx.reserve.pubkey(), false);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

// ---------------------------------------------------------------------------
// Token-account-mint check (6007) and token-program id check
// ---------------------------------------------------------------------------

#[test]
fn destination_of_other_mint_is_token_account_mint_mismatch() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();

    // A second full three-extension mint, and a destination belonging to IT.
    let fx_b = token::create_three_extension_mint(&mut ctx.svm, &payer);
    let destination_b =
        token::create_token_account(&mut ctx.svm, &payer, &fx_b.mint, &Pubkey::new_unique());

    let ix = mint_tokens_ix(metas_for(&ctx, &destination_b), 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6007); // TokenAccountMintMismatch — the program's check, not the CPI's
}

/// Ladder pin: data-load-stage failure (mint mismatch) precedes
/// the authority stage — both wrong, 6007 must win over 6001.
#[test]
fn mint_mismatch_beats_wrong_signer_ladder_order() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let imposter = Keypair::new();

    let fx_b = token::create_three_extension_mint(&mut ctx.svm, &payer);
    let destination_b =
        token::create_token_account(&mut ctx.svm, &payer, &fx_b.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination_b);
    metas[3] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &reserve]);
    assert_custom(res, 6007);
}

#[test]
fn wrong_token_program_account_is_incorrect_program_id() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let destination =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());

    let mut metas = metas_for(&ctx, &destination);
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let ix = mint_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::IncorrectProgramId));
}
