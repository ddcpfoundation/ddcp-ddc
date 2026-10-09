//! I-3 burn_tokens integration suite (LiteSVM, real program .so, pinned devnet
//! Token-2022 fixture layer). Pins the pause-immunity positive (redemption
//! is always available — the precondition is proven, not assumed:
//! PDA-1 reads back paused AND an I-2 probe fails MintPaused), the TWO
//! distinct source owner checks (AccountInfo ownership at the
//! ownership stage vs the deserialized `.owner` FIELD == PDA-5 as the final
//! authority-stage check), the shared `TokenAccountMintMismatch` 6007 on
//! source with its ladder pin, the Issuer+Reserve tier, and the structural
//! negatives. Sources are funded through the real I-2 handler — PDA-1 is the
//! mint authority, so no other mint path exists.

mod common;

use common::*;
use ddcp_ddc::pda;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_program::instruction::{AccountMeta, InstructionError};
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::extension::StateWithExtensions;
use spl_token_2022_interface::state::{Account as TokenAccount, Mint};

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

/// Correct metas for a ctx + source; negatives mutate the result.
/// Index map: 0 mint · 1 source · 2 PDA-1 · 3 PDA-5 · 4 issuer · 5 reserve ·
/// 6 token program.
fn metas_for(ctx: &TokenHandlerCtx, source: &Pubkey) -> Vec<AccountMeta> {
    burn_tokens_metas(
        &ctx.fx.mint,
        source,
        &ctx.fx.pda1,
        &ctx.fx.pda5,
        &ctx.issuer.pubkey(),
        &ctx.reserve.pubkey(),
    )
}

/// A token account whose `.owner` FIELD is `owner`, funded through the real
/// I-2 handler. Precondition: ctx not paused at call time.
fn funded_account(ctx: &mut TokenHandlerCtx, owner: &Pubkey, amount: u64) -> Pubkey {
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let account = token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, owner);
    let ix = mint_tokens_ix(
        mint_tokens_metas(
            &ctx.fx.mint,
            &account,
            &ctx.fx.pda1,
            &issuer.pubkey(),
            &reserve.pubkey(),
        ),
        amount,
    );
    send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]).unwrap();
    account
}

/// The canonical redemption-collection source: owner field == PDA-5.
fn funded_source(ctx: &mut TokenHandlerCtx, amount: u64) -> Pubkey {
    let pda5 = ctx.fx.pda5;
    funded_account(ctx, &pda5, amount)
}

// ---------------------------------------------------------------------------
// Positives
// ---------------------------------------------------------------------------

#[test]
fn burn_succeeds_debits_source_and_supply() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 1_000_000);
    assert_eq!(mint_supply(&ctx.svm, &ctx.fx.mint), 1_000_000);
    let pre_state = read_mint_state(&ctx.svm, &ctx.fx.pda1);

    let ix = burn_tokens_ix(metas_for(&ctx, &source), 400_000);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]).unwrap();

    assert_eq!(token_amount(&ctx.svm, &source), 600_000);
    assert_eq!(mint_supply(&ctx.svm, &ctx.fx.mint), 600_000);
    // PDA-1 state untouched by a burn.
    assert_eq!(read_mint_state(&ctx.svm, &ctx.fx.pda1), pre_state);
}

/// I-3 is NOT subject to the pause — redemption is always available. The
/// precondition is set via the real I-4 and proven non-vacuously (state read
/// back paused AND the same pause blocks an I-2 probe with 6000) before the
/// burn executes anyway.
#[test]
fn burn_succeeds_while_paused() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 1_000);

    let pause = pause_ix(&ctx.fx.mint, &ctx.fx.pda1, &issuer.pubkey(), true);
    send(&mut ctx.svm, &payer, pause, &[&issuer]).unwrap();
    assert!(
        read_mint_state(&ctx.svm, &ctx.fx.pda1).pause_active,
        "precondition: pause must actually be active"
    );
    let probe_dest =
        token::create_token_account(&mut ctx.svm, &payer, &ctx.fx.mint, &Pubkey::new_unique());
    let probe = mint_tokens_ix(
        mint_tokens_metas(
            &ctx.fx.mint,
            &probe_dest,
            &ctx.fx.pda1,
            &issuer.pubkey(),
            &reserve.pubkey(),
        ),
        1,
    );
    assert_custom(send(&mut ctx.svm, &payer, probe, &[&issuer, &reserve]), 6000);

    let ix = burn_tokens_ix(metas_for(&ctx, &source), 250);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]).unwrap();
    assert_eq!(token_amount(&ctx.svm, &source), 750);
    assert_eq!(mint_supply(&ctx.svm, &ctx.fx.mint), 750);
}

// ---------------------------------------------------------------------------
// Signer matrix: Issuer + Reserve 2-of-2
// ---------------------------------------------------------------------------

#[test]
fn wrong_issuer_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let imposter = Keypair::new();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[4] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &reserve]);
    assert_custom(res, 6001);
}

#[test]
fn wrong_reserve_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let imposter = Keypair::new();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[5] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &imposter]);
    assert_custom(res, 6001);
}

#[test]
fn swapped_issuer_reserve_slots_are_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[4] = AccountMeta::new_readonly(reserve.pubkey(), true); // right keys,
    metas[5] = AccountMeta::new_readonly(issuer.pubkey(), true); // wrong slots
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6001);
}

/// Tier pin: Operator is a real authority on this mint but NOT in the I-3
/// tier — the Operator key in the Reserve slot must fail.
#[test]
fn operator_in_reserve_slot_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[5] = AccountMeta::new_readonly(operator.pubkey(), true);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_custom(res, 6001);
}

#[test]
fn issuer_not_signer_is_missing_required_signature() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[4] = AccountMeta::new_readonly(ctx.issuer.pubkey(), false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&reserve]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn reserve_not_signer_is_missing_required_signature() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[5] = AccountMeta::new_readonly(ctx.reserve.pubkey(), false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

// ---------------------------------------------------------------------------
// The two distinct source owner checks
// ---------------------------------------------------------------------------

/// Owner check (b) — the deserialized `.owner` FIELD, the FINAL
/// authority-stage check: a token account of the right mint, funded, every
/// signer correct — but owned by a wallet, not PDA-5.
#[test]
fn source_not_owned_by_pda5_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let wallet = Pubkey::new_unique();
    let source = funded_account(&mut ctx, &wallet, 100);

    let ix = burn_tokens_ix(metas_for(&ctx, &source), 50);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6001);
    assert_eq!(token_amount(&ctx.svm, &source), 100, "nothing may burn");
}

/// Owner check (a) — ACCOUNT ownership (`AccountInfo.owner`), the
/// ownership-stage check, distinct from (b): a never-initialized account is
/// system-owned and fails long before the authority stage — with a different
/// error than (b), proving the two checks are separate.
#[test]
fn source_not_token_2022_owned_is_invalid_account_owner() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();

    let bogus = Pubkey::new_unique(); // system-owned, not Token-2022
    let ix = burn_tokens_ix(metas_for(&ctx, &bogus), 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidAccountOwner));
}

// ---------------------------------------------------------------------------
// Token-account-mint check (6007) on source, and its ladder pin
// ---------------------------------------------------------------------------

#[test]
fn source_of_other_mint_is_token_account_mint_mismatch() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();

    // A second full three-extension mint, and a source belonging to IT — the
    // owner FIELD is deliberately our PDA-5, isolating the mint check.
    let fx_b = token::create_three_extension_mint(&mut ctx.svm, &payer);
    let source_b = token::create_token_account(&mut ctx.svm, &payer, &fx_b.mint, &ctx.fx.pda5);

    let ix = burn_tokens_ix(metas_for(&ctx, &source_b), 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6007); // the program's check, not the CPI's
}

/// Ladder pin: data-load-stage failure (mint mismatch)
/// precedes the authority stage — both wrong, 6007 must win over 6001.
#[test]
fn mint_mismatch_beats_wrong_signer_ladder_order() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let imposter = Keypair::new();

    let fx_b = token::create_three_extension_mint(&mut ctx.svm, &payer);
    let source_b = token::create_token_account(&mut ctx.svm, &payer, &fx_b.mint, &ctx.fx.pda5);

    let mut metas = metas_for(&ctx, &source_b);
    metas[4] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &reserve]);
    assert_custom(res, 6007);
}

// ---------------------------------------------------------------------------
// Structural negatives
// ---------------------------------------------------------------------------

#[test]
fn cross_mint_pda1_is_invalid_seeds() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mint_b = Pubkey::new_unique();
    let pda1_b = seed_mint_state(
        &mut ctx.svm,
        &mint_b,
        &issuer.pubkey(),
        &ctx.operator.pubkey(),
        &reserve.pubkey(),
        false,
    );

    let mut metas = metas_for(&ctx, &source);
    metas[2] = AccountMeta::new_readonly(pda1_b, false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn cross_mint_pda5_is_invalid_seeds() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mint_b = Pubkey::new_unique();
    let (pda5_b, _) = pda::find_redemption_authority_address(&mint_b, &ddcp_ddc::id());
    let mut metas = metas_for(&ctx, &source);
    metas[3] = AccountMeta::new_readonly(pda5_b, false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn readonly_mint_is_immutable() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[0] = AccountMeta::new_readonly(ctx.fx.mint, false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn readonly_source_is_immutable() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[1] = AccountMeta::new_readonly(source, false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn wrong_token_program_account_is_incorrect_program_id() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas[6] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::IncorrectProgramId));
}

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
    let source = funded_source(&mut ctx, 100);

    let mut metas = metas_for(&ctx, &source);
    metas.pop(); // drop token_2022_program
    let ix = burn_tokens_ix(metas, 1);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::NotEnoughAccountKeys));
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
    let source = funded_source(&mut ctx, 100);

    let mut ix = burn_tokens_ix(metas_for(&ctx, &source), 1);
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
    let source = funded_source(&mut ctx, 100);

    let mut ix = burn_tokens_ix(metas_for(&ctx, &source), 1);
    ix.data.truncate(ix.data.len() - 3); // cut amount short mid-field
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

// ---------------------------------------------------------------------------
// CPI passthrough (invariant-style, parity with I-6's bps pin)
// ---------------------------------------------------------------------------

/// The program does not pre-validate the burn amount against the balance —
/// Token-2022 does. Asserted on the INVARIANT, not an upstream error name:
/// the instruction fails, the error is NOT a DDC custom code (6000–6007),
/// and nothing was written.
#[test]
fn burn_over_balance_fails_in_cpi_and_writes_nothing() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let source = funded_source(&mut ctx, 100);

    let ix = burn_tokens_ix(metas_for(&ctx, &source), 101);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    match res {
        Ok(()) => panic!("burning more than the balance must not succeed"),
        Err(InstructionError::Custom(code)) => assert!(
            !(6000..=6007).contains(&code),
            "failure must come from the Token-2022 CPI, not a DDC code ({code})"
        ),
        Err(_) => {} // any non-custom error is by definition not a DDC code
    }
    assert_eq!(token_amount(&ctx.svm, &source), 100);
    assert_eq!(mint_supply(&ctx.svm, &ctx.fx.mint), 100);
}
