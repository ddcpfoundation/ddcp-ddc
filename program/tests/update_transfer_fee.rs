//! I-6 update_transfer_fee integration suite (LiteSVM, real program .so,
//! pinned devnet Token-2022 fixture layer). Pins the atomic dual
//! effect (SetTransferFee CPI + `minimum_fee` into PDA-1) with the
//! field-preservation assertion, the epoch-delayed fee activation, the
//! TRIGGERED `FeeBoundsInvalid` (6002) with unchanged-state asserts, the
//! Issuer+Operator tier, the authority-before-business ladder, and the deliberate
//! absence of a bps pre-validation (invariant-style CPI passthrough).

mod common;

use common::*;
use ddcp_ddc::pda;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_program::instruction::{AccountMeta, InstructionError};
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::extension::transfer_fee::TransferFeeConfig;
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::Mint;

fn transfer_fee_config(svm: &LiteSVM, mint: &Pubkey) -> TransferFeeConfig {
    let acct = svm.get_account(mint).unwrap();
    let st = StateWithExtensions::<Mint>::unpack(&acct.data).unwrap();
    *st.get_extension::<TransferFeeConfig>().unwrap()
}

/// Both fee epochs still carry the genesis values (0 bps, 0 max) —
/// asserted after every failure that must not have reached the CPI's write.
fn assert_fee_config_at_launch_values(svm: &LiteSVM, mint: &Pubkey) {
    let tf = transfer_fee_config(svm, mint);
    assert_eq!(
        u16::from(tf.newer_transfer_fee.transfer_fee_basis_points),
        0
    );
    assert_eq!(u64::from(tf.newer_transfer_fee.maximum_fee), 0);
    assert_eq!(
        u16::from(tf.older_transfer_fee.transfer_fee_basis_points),
        0
    );
    assert_eq!(u64::from(tf.older_transfer_fee.maximum_fee), 0);
}

/// Correct metas for a ctx; negatives mutate the result.
/// Index map: 0 mint · 1 PDA-3 · 2 PDA-1 (writable) · 3 issuer · 4 operator ·
/// 5 token program.
fn metas_for(ctx: &TokenHandlerCtx) -> Vec<AccountMeta> {
    update_transfer_fee_metas(
        &ctx.fx.mint,
        &ctx.fx.pda3,
        &ctx.fx.pda1,
        &ctx.issuer.pubkey(),
        &ctx.operator.pubkey(),
    )
}

// ---------------------------------------------------------------------------
// Positives
// ---------------------------------------------------------------------------

#[test]
fn update_succeeds_sets_fee_and_preserves_mint_state() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);

    let ix = update_transfer_fee_ix(metas_for(&ctx), 25, 1_000_000, 100);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]).unwrap();

    // Epoch-delayed activation (Token-2022 semantics): the NEWER epoch
    // carries the new values; the OLDER epoch still holds the launch 0/0.
    let tf = transfer_fee_config(&ctx.svm, &ctx.fx.mint);
    assert_eq!(
        u16::from(tf.newer_transfer_fee.transfer_fee_basis_points),
        25
    );
    assert_eq!(u64::from(tf.newer_transfer_fee.maximum_fee), 1_000_000);
    assert_eq!(
        u16::from(tf.older_transfer_fee.transfer_fee_basis_points),
        0
    );
    assert_eq!(u64::from(tf.older_transfer_fee.maximum_fee), 0);

    // Field preservation: only minimum_fee changed; every other MintState
    // field is byte-identical to the pre-call read.
    let post = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert_eq!(post.minimum_fee, 100);
    assert_eq!(post.pause_active, pre.pause_active);
    assert_eq!(post.issuer_authority, pre.issuer_authority);
    assert_eq!(post.operator_authority, pre.operator_authority);
    assert_eq!(post.reserve_authority, pre.reserve_authority);
    assert_eq!(post.fee_ceiling_basis_points, pre.fee_ceiling_basis_points);
    assert_eq!(post.fee_ceiling_base_units, pre.fee_ceiling_base_units);
    assert_eq!(post.reserved, pre.reserved);
    assert_eq!(post.bump, pre.bump);
}

/// Boundary of the min <= max bound: `new_minimum_fee == new_maximum_fee` is valid.
#[test]
fn update_min_equal_max_succeeds() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let ix = update_transfer_fee_ix(metas_for(&ctx), 10, 500, 500);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]).unwrap();
    assert_eq!(read_mint_state(&ctx.svm, &ctx.fx.pda1).minimum_fee, 500);
}

/// The pause blocks I-2 only — I-6 has no pause gate. Precondition
/// proven: the seeded state reads back paused before the update succeeds.
#[test]
fn update_succeeds_while_paused() {
    let mut ctx = setup_token_handlers(true);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    assert!(
        read_mint_state(&ctx.svm, &ctx.fx.pda1).pause_active,
        "precondition: pause must actually be active"
    );

    let ix = update_transfer_fee_ix(metas_for(&ctx), 25, 1_000, 10);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]).unwrap();
    let post = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert_eq!(post.minimum_fee, 10);
    assert!(post.pause_active, "pause flag must survive the update");
}

// ---------------------------------------------------------------------------
// FeeBoundsInvalid (6002) — triggered, with atomicity evidence
// ---------------------------------------------------------------------------

#[test]
fn min_greater_than_max_is_fee_bounds_invalid() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);

    let ix = update_transfer_fee_ix(metas_for(&ctx), 25, 1_000, 1_001);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_custom(res, 6002); // FeeBoundsInvalid

    // Atomic: neither effect happened.
    assert_fee_config_at_launch_values(&ctx.svm, &ctx.fx.mint);
    assert_eq!(read_mint_state(&ctx.svm, &ctx.fx.pda1), pre);
}

/// Ladder pin: authority stage precedes business validation —
/// wrong signer AND bad bounds must fail 6001, not 6002.
#[test]
fn wrong_signer_with_bad_bounds_is_unauthorized_ladder_order() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let imposter = Keypair::new();

    let mut metas = metas_for(&ctx);
    metas[3] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 1_001);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &operator]);
    assert_custom(res, 6001);
}

// ---------------------------------------------------------------------------
// Signer matrix: Issuer + Operator 2-of-2
// ---------------------------------------------------------------------------

#[test]
fn wrong_issuer_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let imposter = Keypair::new();

    let mut metas = metas_for(&ctx);
    metas[3] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&imposter, &operator]);
    assert_custom(res, 6001);
}

#[test]
fn wrong_operator_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let imposter = Keypair::new();

    let mut metas = metas_for(&ctx);
    metas[4] = AccountMeta::new_readonly(imposter.pubkey(), true);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &imposter]);
    assert_custom(res, 6001);
}

#[test]
fn swapped_issuer_operator_slots_are_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[3] = AccountMeta::new_readonly(operator.pubkey(), true); // right keys,
    metas[4] = AccountMeta::new_readonly(issuer.pubkey(), true); // wrong slots
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_custom(res, 6001);
}

/// Tier pin: Reserve is a real authority on this mint but NOT in the I-6
/// tier — "Commercial decision; Reserve involvement isn't proportionate."
#[test]
fn reserve_in_operator_slot_is_unauthorized() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[4] = AccountMeta::new_readonly(reserve.pubkey(), true);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]);
    assert_custom(res, 6001);
}

#[test]
fn issuer_not_signer_is_missing_required_signature() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[3] = AccountMeta::new_readonly(ctx.issuer.pubkey(), false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&operator]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn operator_not_signer_is_missing_required_signature() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[4] = AccountMeta::new_readonly(ctx.operator.pubkey(), false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

// ---------------------------------------------------------------------------
// Structural negatives
// ---------------------------------------------------------------------------

#[test]
fn cross_mint_pda3_is_invalid_seeds() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mint_b = Pubkey::new_unique();
    let (pda3_b, _) = pda::find_fee_authority_address(&mint_b, &ddcp_ddc::id());
    let mut metas = metas_for(&ctx);
    metas[1] = AccountMeta::new_readonly(pda3_b, false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn cross_mint_pda1_is_invalid_seeds() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mint_b = Pubkey::new_unique();
    let pda1_b = seed_mint_state(
        &mut ctx.svm,
        &mint_b,
        &issuer.pubkey(),
        &operator.pubkey(),
        &ctx.reserve.pubkey(),
        false,
    );

    let mut metas = metas_for(&ctx);
    metas[2] = AccountMeta::new(pda1_b, false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn pda1_wrong_owner_is_invalid_account_owner() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    // Same address, same data — owner flipped to a foreign program.
    let mut account = ctx.svm.get_account(&ctx.fx.pda1).unwrap();
    account.owner = Pubkey::new_unique();
    ctx.svm.set_account(ctx.fx.pda1, account).unwrap();

    let ix = update_transfer_fee_ix(metas_for(&ctx), 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::InvalidAccountOwner));
}

/// PDA-1 is WRITABLE in I-6 (unlike I-2/I-3) — a read-only PDA-1 must fail.
#[test]
fn readonly_pda1_is_immutable() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[2] = AccountMeta::new_readonly(ctx.fx.pda1, false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn readonly_mint_is_immutable() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[0] = AccountMeta::new_readonly(ctx.fx.mint, false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn wrong_token_program_account_is_incorrect_program_id() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
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
    let operator = ctx.operator.insecure_clone();

    let mut metas = metas_for(&ctx);
    metas.pop(); // drop token_2022_program
    let ix = update_transfer_fee_ix(metas, 25, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
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
    let operator = ctx.operator.insecure_clone();

    let mut ix = update_transfer_fee_ix(metas_for(&ctx), 25, 1_000, 10);
    ix.data.push(0x00);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

#[test]
fn truncated_args_are_invalid_instruction_data() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();

    let mut ix = update_transfer_fee_ix(metas_for(&ctx), 25, 1_000, 10);
    ix.data.truncate(ix.data.len() - 3); // cut new_minimum_fee short mid-field
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

// ---------------------------------------------------------------------------
// CPI passthrough (invariant-style)
// ---------------------------------------------------------------------------

/// The program deliberately does NOT pre-validate `new_fee_basis_points`
/// (its own fee-bounds check is min <= max) — the bps <= 10_000 bound belongs to the
/// Token-2022 CPI. Asserted on the INVARIANT, not an upstream error name:
/// the instruction fails, the error is NOT a DDC custom code (6000–6007),
/// and neither effect was committed (the CPI precedes the PDA-1 write).
#[test]
fn bps_over_10000_fails_in_cpi_and_writes_nothing() {
    let mut ctx = setup_token_handlers(false);
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    // A ceiling above 10_000 bps cannot come from I-1; it is seeded here so
    // that the program's own ceiling check passes and the CPI's rate bound
    // is what refuses. Same keys and address, so the fixture's mint
    // authority is unchanged.
    seed_mint_state_with_ceilings(
        &mut ctx.svm,
        &ctx.fx.mint,
        &ctx.issuer.pubkey(),
        &ctx.operator.pubkey(),
        &ctx.reserve.pubkey(),
        false,
        65_535,
        u64::MAX,
    );
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert_eq!(pre.fee_ceiling_basis_points, 65_535);

    // min <= max holds and both ceilings hold, so a DDC code cannot be the
    // failure here.
    let ix = update_transfer_fee_ix(metas_for(&ctx), 10_001, 1_000, 10);
    let res = send(&mut ctx.svm, &payer, ix, &[&issuer, &operator]);
    match res {
        Ok(()) => panic!("bps over 10_000 must not succeed"),
        Err(InstructionError::Custom(code)) => assert!(
            !(6000..=6010).contains(&code),
            "failure must come from the Token-2022 CPI, not a DDC code ({code})"
        ),
        Err(_) => {} // any non-custom error is by definition not a DDC code
    }
    assert_fee_config_at_launch_values(&ctx.svm, &ctx.fx.mint);
    assert_eq!(read_mint_state(&ctx.svm, &ctx.fx.pda1), pre);
}

// ---------------------------------------------------------------------------
// Genesis-settled fee ceilings: accepted at the ceiling, refused one above,
// rate judged before maximum, 6002 judged before either, nothing written.
// ---------------------------------------------------------------------------

fn send_fee(
    ctx: &mut TokenHandlerCtx,
    bps: u16,
    max: u64,
    min: u64,
) -> Result<(), InstructionError> {
    let payer = ctx.payer.insecure_clone();
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let ix = update_transfer_fee_ix(metas_for(ctx), bps, max, min);
    send(&mut ctx.svm, &payer, ix, &[&issuer, &operator])
}

#[test]
fn fee_exactly_at_both_ceilings_succeeds() {
    let mut ctx = setup_token_handlers(false);
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert_eq!(
        pre.fee_ceiling_basis_points,
        DEFAULT_FEE_CEILING_BASIS_POINTS
    );
    assert_eq!(pre.fee_ceiling_base_units, DEFAULT_FEE_CEILING_BASE_UNITS);
    send_fee(
        &mut ctx,
        DEFAULT_FEE_CEILING_BASIS_POINTS,
        DEFAULT_FEE_CEILING_BASE_UNITS,
        DEFAULT_FEE_CEILING_BASE_UNITS,
    )
    .unwrap();
    let tf = transfer_fee_config(&ctx.svm, &ctx.fx.mint);
    assert_eq!(
        u16::from(tf.newer_transfer_fee.transfer_fee_basis_points),
        DEFAULT_FEE_CEILING_BASIS_POINTS
    );
    assert_eq!(
        u64::from(tf.newer_transfer_fee.maximum_fee),
        DEFAULT_FEE_CEILING_BASE_UNITS
    );
    let post = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert_eq!(post.minimum_fee, DEFAULT_FEE_CEILING_BASE_UNITS);
    assert_eq!(post.fee_ceiling_basis_points, pre.fee_ceiling_basis_points);
    assert_eq!(post.fee_ceiling_base_units, pre.fee_ceiling_base_units);
}

#[test]
fn rate_one_above_ceiling_is_fee_above_ceiling_and_writes_nothing() {
    let mut ctx = setup_token_handlers(false);
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    let res = send_fee(&mut ctx, DEFAULT_FEE_CEILING_BASIS_POINTS + 1, 1_000, 10);
    assert_custom(res, 6008); // FeeAboveCeiling
    assert_fee_config_at_launch_values(&ctx.svm, &ctx.fx.mint);
    assert_eq!(read_mint_state(&ctx.svm, &ctx.fx.pda1), pre);
}

#[test]
fn maximum_one_above_ceiling_is_maximum_fee_above_ceiling_and_writes_nothing() {
    let mut ctx = setup_token_handlers(false);
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    let res = send_fee(&mut ctx, 10, DEFAULT_FEE_CEILING_BASE_UNITS + 1, 10);
    assert_custom(res, 6009); // MaximumFeeAboveCeiling
    assert_fee_config_at_launch_values(&ctx.svm, &ctx.fx.mint);
    assert_eq!(read_mint_state(&ctx.svm, &ctx.fx.pda1), pre);
}

/// Both ceilings breached: the rate is judged first.
#[test]
fn both_above_ceiling_reports_rate_first() {
    let mut ctx = setup_token_handlers(false);
    let res = send_fee(
        &mut ctx,
        DEFAULT_FEE_CEILING_BASIS_POINTS + 1,
        DEFAULT_FEE_CEILING_BASE_UNITS + 1,
        10,
    );
    assert_custom(res, 6008);
}

/// The min <= max bound is judged before either ceiling: a breach of all three
/// still returns 6002, so the existing error stays reachable unchanged.
#[test]
fn min_above_max_is_still_fee_bounds_invalid_when_ceilings_also_breached() {
    let mut ctx = setup_token_handlers(false);
    let res = send_fee(
        &mut ctx,
        DEFAULT_FEE_CEILING_BASIS_POINTS + 1,
        DEFAULT_FEE_CEILING_BASE_UNITS + 1,
        DEFAULT_FEE_CEILING_BASE_UNITS + 2,
    );
    assert_custom(res, 6002);
}

/// Lowering stays free: from the ceiling down to zero, then a second call
/// at zero. Neither touches the ceilings.
#[test]
fn lowering_to_zero_succeeds_and_preserves_ceilings() {
    let mut ctx = setup_token_handlers(false);
    let pre = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    send_fee(
        &mut ctx,
        DEFAULT_FEE_CEILING_BASIS_POINTS,
        DEFAULT_FEE_CEILING_BASE_UNITS,
        0,
    )
    .unwrap();
    ctx.svm.expire_blockhash();
    send_fee(&mut ctx, 0, 0, 0).unwrap();
    let post = read_mint_state(&ctx.svm, &ctx.fx.pda1);
    assert_eq!(post.minimum_fee, 0);
    assert_eq!(post.fee_ceiling_basis_points, pre.fee_ceiling_basis_points);
    assert_eq!(post.fee_ceiling_base_units, pre.fee_ceiling_base_units);
}

/// Zero ceilings mean no fee is ever charged: any positive rate or maximum
/// is refused, and the zero schedule itself still passes.
#[test]
fn zero_ceilings_refuse_any_fee_but_accept_zero() {
    let mut ctx = setup_token_handlers(false);
    seed_mint_state_with_ceilings(
        &mut ctx.svm,
        &ctx.fx.mint,
        &ctx.issuer.pubkey(),
        &ctx.operator.pubkey(),
        &ctx.reserve.pubkey(),
        false,
        0,
        0,
    );
    assert_custom(send_fee(&mut ctx, 1, 0, 0), 6008);
    ctx.svm.expire_blockhash();
    assert_custom(send_fee(&mut ctx, 0, 1, 0), 6009);
    ctx.svm.expire_blockhash();
    send_fee(&mut ctx, 0, 0, 0).unwrap();
}
