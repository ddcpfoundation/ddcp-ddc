//! I-4 pause_issuance / I-5 resume_issuance integration suite (LiteSVM, real
//! .so). Covers the signer tiers positively and negatively, idempotency,
//! strict-args, the byte-fidelity locks, and the shared structural negatives.

mod common;

use common::*;
use ddcp_ddc::state::{MINT_STATE_DISCRIMINATOR, MINT_STATE_LEN};
use solana_account::Account;
use solana_program::instruction::InstructionError;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::extension::StateWithExtensions;
use spl_token_2022_interface::state::Account as TokenAccount;

// ---------------------------------------------------------------------------
// Byte-fidelity locks (plan-mandated)
// ---------------------------------------------------------------------------

#[test]
fn seeded_bytes_match_hand_assembled_reference_vector() {
    let ctx = setup(false);
    let seeded = ctx.svm.get_account(&ctx.pda1).unwrap().data;

    let state = read_mint_state(&ctx.svm, &ctx.pda1);
    let mut expected = Vec::with_capacity(MINT_STATE_LEN);
    expected.extend_from_slice(&MINT_STATE_DISCRIMINATOR);
    expected.push(0u8); // pause_active: false
    expected.extend_from_slice(&ctx.issuer.pubkey().to_bytes());
    expected.extend_from_slice(&ctx.operator.pubkey().to_bytes());
    expected.extend_from_slice(&ctx.reserve.pubkey().to_bytes());
    expected.extend_from_slice(&0u64.to_le_bytes()); // minimum_fee
    expected.extend_from_slice(&DEFAULT_FEE_CEILING_BASIS_POINTS.to_le_bytes()); // fee_ceiling_basis_points
    expected.extend_from_slice(&DEFAULT_FEE_CEILING_BASE_UNITS.to_le_bytes()); // fee_ceiling_base_units
    expected.extend_from_slice(&[0u8; 54]); // reserved
    expected.push(state.bump);

    assert_eq!(expected.len(), MINT_STATE_LEN);
    assert_eq!(
        seeded, expected,
        "fixture bytes diverge from reference vector"
    );
}

#[test]
fn all_zero_pda1_is_rejected_by_load_guard() {
    let mut ctx = setup(false);
    // Overwrite PDA-1 with 178 zero bytes: correct length/owner, no discriminator.
    ctx.svm
        .set_account(
            ctx.pda1,
            Account {
                lamports: 10_000_000,
                data: vec![0u8; MINT_STATE_LEN],
                owner: ddcp_ddc::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let ix = pause_ix(&ctx.mint, &ctx.pda1, &ctx.issuer.pubkey(), true);
    let issuer = ctx.issuer.insecure_clone();
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::InvalidAccountData));
}

// ---------------------------------------------------------------------------
// I-4: any 1-of-3, positive
// ---------------------------------------------------------------------------

fn pause_succeeds_for(authority_pick: fn(&Ctx) -> solana_keypair::Keypair) {
    let mut ctx = setup(false);
    let authority = authority_pick(&ctx);
    let before = read_mint_state(&ctx.svm, &ctx.pda1);
    let ix = pause_ix(&ctx.mint, &ctx.pda1, &authority.pubkey(), true);
    send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&authority]).unwrap();
    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert!(after.pause_active);
    // Every non-flag field byte-preserved.
    assert_eq!(after.issuer_authority, before.issuer_authority);
    assert_eq!(after.operator_authority, before.operator_authority);
    assert_eq!(after.reserve_authority, before.reserve_authority);
    assert_eq!(after.minimum_fee, before.minimum_fee);
    assert_eq!(
        after.fee_ceiling_basis_points,
        before.fee_ceiling_basis_points
    );
    assert_eq!(after.fee_ceiling_base_units, before.fee_ceiling_base_units);
    assert_eq!(after.reserved, [0u8; 54]);
    assert_eq!(after.bump, before.bump);
}

#[test]
fn pause_by_issuer_alone() {
    pause_succeeds_for(|c| c.issuer.insecure_clone());
}

#[test]
fn pause_by_operator_alone() {
    pause_succeeds_for(|c| c.operator.insecure_clone());
}

#[test]
fn pause_by_reserve_alone() {
    pause_succeeds_for(|c| c.reserve.insecure_clone());
}

// ---------------------------------------------------------------------------
// I-4: negatives
// ---------------------------------------------------------------------------

#[test]
fn pause_unknown_signer_unauthorized() {
    let mut ctx = setup(false);
    let imposter = solana_keypair::Keypair::new();
    let ix = pause_ix(&ctx.mint, &ctx.pda1, &imposter.pubkey(), true);
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&imposter]);
    assert_custom(res, 6001); // Unauthorized
    assert!(!read_mint_state(&ctx.svm, &ctx.pda1).pause_active);
}

#[test]
fn pause_authority_present_but_not_signing() {
    let mut ctx = setup(false);
    // Authority in the metas with is_signer = false, and not signing the tx.
    let ix = pause_ix(&ctx.mint, &ctx.pda1, &ctx.issuer.pubkey(), false);
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn pause_trailing_args_rejected_strict() {
    let mut ctx = setup(false);
    let mut ix = pause_ix(&ctx.mint, &ctx.pda1, &ctx.issuer.pubkey(), true);
    ix.data.push(0xAA); // one trailing byte after the discriminator
    let issuer = ctx.issuer.insecure_clone();
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

#[test]
fn pause_wrong_owner_pda1() {
    let mut ctx = setup(false);
    let data = ctx.svm.get_account(&ctx.pda1).unwrap().data;
    ctx.svm
        .set_account(
            ctx.pda1,
            Account {
                lamports: 10_000_000,
                data,
                owner: solana_program::pubkey::Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let ix = pause_ix(&ctx.mint, &ctx.pda1, &ctx.issuer.pubkey(), true);
    let issuer = ctx.issuer.insecure_clone();
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::InvalidAccountOwner));
}

#[test]
fn pause_noncanonical_pda1_invalid_seeds() {
    let mut ctx = setup(false);
    let lookalike = seed_lookalike_mint_state(&mut ctx.svm, &ctx.pda1);
    let ix = pause_ix(&ctx.mint, &lookalike, &ctx.issuer.pubkey(), true);
    let issuer = ctx.issuer.insecure_clone();
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn pause_readonly_pda1_immutable() {
    let mut ctx = setup(false);
    let mut ix = pause_ix(&ctx.mint, &ctx.pda1, &ctx.issuer.pubkey(), true);
    ix.accounts[1].is_writable = false; // PDA-1 slot demoted to read-only
    let issuer = ctx.issuer.insecure_clone();
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::Immutable));
}

// ---------------------------------------------------------------------------
// I-4/I-5 idempotency and sequencing
// ---------------------------------------------------------------------------

#[test]
fn pause_is_idempotent() {
    let mut ctx = setup(false);
    let issuer = ctx.issuer.insecure_clone();
    let payer = ctx.payer.insecure_clone();
    let ix = pause_ix(&ctx.mint, &ctx.pda1, &issuer.pubkey(), true);
    send(&mut ctx.svm, &payer, ix.clone(), &[&issuer]).unwrap();
    assert!(read_mint_state(&ctx.svm, &ctx.pda1).pause_active);
    ctx.svm.expire_blockhash(); // avoid duplicate-transaction dedup
    send(&mut ctx.svm, &payer, ix, &[&issuer]).unwrap();
    assert!(read_mint_state(&ctx.svm, &ctx.pda1).pause_active);
}

#[test]
fn resume_is_idempotent() {
    let mut ctx = setup(false); // not paused
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let payer = ctx.payer.insecure_clone();
    let ix = resume_ix(&ctx.mint, &ctx.pda1, &issuer.pubkey(), &reserve.pubkey());
    send(&mut ctx.svm, &payer, ix.clone(), &[&issuer, &reserve]).unwrap();
    assert!(!read_mint_state(&ctx.svm, &ctx.pda1).pause_active);
    ctx.svm.expire_blockhash();
    send(&mut ctx.svm, &payer, ix, &[&issuer, &reserve]).unwrap();
    assert!(!read_mint_state(&ctx.svm, &ctx.pda1).pause_active);
}

#[test]
fn pause_resume_resume_sequence() {
    let mut ctx = setup(false);
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let payer = ctx.payer.insecure_clone();

    let p = pause_ix(&ctx.mint, &ctx.pda1, &operator.pubkey(), true);
    send(&mut ctx.svm, &payer, p, &[&operator]).unwrap();
    assert!(read_mint_state(&ctx.svm, &ctx.pda1).pause_active);

    let r = resume_ix(&ctx.mint, &ctx.pda1, &issuer.pubkey(), &reserve.pubkey());
    send(&mut ctx.svm, &payer, r.clone(), &[&issuer, &reserve]).unwrap();
    assert!(!read_mint_state(&ctx.svm, &ctx.pda1).pause_active);

    ctx.svm.expire_blockhash();
    send(&mut ctx.svm, &payer, r, &[&issuer, &reserve]).unwrap();
    assert!(!read_mint_state(&ctx.svm, &ctx.pda1).pause_active);
}

// ---------------------------------------------------------------------------
// I-5: Issuer + Reserve 2-of-2, positive and negative
// ---------------------------------------------------------------------------

#[test]
fn resume_by_issuer_and_reserve() {
    let mut ctx = setup(true); // paused
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);
    let ix = resume_ix(&ctx.mint, &ctx.pda1, &issuer.pubkey(), &reserve.pubkey());
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&issuer, &reserve],
    )
    .unwrap();
    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert!(!after.pause_active);
    assert_eq!(after.issuer_authority, before.issuer_authority);
    assert_eq!(after.operator_authority, before.operator_authority);
    assert_eq!(after.reserve_authority, before.reserve_authority);
    assert_eq!(after.minimum_fee, before.minimum_fee);
    assert_eq!(
        after.fee_ceiling_basis_points,
        before.fee_ceiling_basis_points
    );
    assert_eq!(after.fee_ceiling_base_units, before.fee_ceiling_base_units);
    assert_eq!(after.reserved, [0u8; 54]);
}

#[test]
fn resume_rejects_operator_in_issuer_slot() {
    let mut ctx = setup(true);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let ix = resume_ix(&ctx.mint, &ctx.pda1, &operator.pubkey(), &reserve.pubkey());
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_custom(res, 6001);
    assert!(read_mint_state(&ctx.svm, &ctx.pda1).pause_active); // still paused
}

#[test]
fn resume_rejects_operator_in_reserve_slot() {
    let mut ctx = setup(true);
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let ix = resume_ix(&ctx.mint, &ctx.pda1, &issuer.pubkey(), &operator.pubkey());
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&issuer, &operator],
    );
    assert_custom(res, 6001);
}

#[test]
fn resume_rejects_swapped_issuer_reserve_slots() {
    let mut ctx = setup(true);
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    // Reserve key in the issuer slot, issuer key in the reserve slot: positional match
    // is enforced, not any-two-of-three.
    let ix = resume_ix(&ctx.mint, &ctx.pda1, &reserve.pubkey(), &issuer.pubkey());
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&issuer, &reserve],
    );
    assert_custom(res, 6001);
}

#[test]
fn resume_missing_reserve_signature() {
    let mut ctx = setup(true);
    let issuer = ctx.issuer.insecure_clone();
    let mut ix = resume_ix(&ctx.mint, &ctx.pda1, &issuer.pubkey(), &ctx.reserve.pubkey());
    ix.accounts[3].is_signer = false; // reserve slot present but unsigned
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

// ---------------------------------------------------------------------------
// Isolation: the pause belongs to one mint
// ---------------------------------------------------------------------------

/// Two mints on one deployment of the program, each with its own PDA-1 and its
/// own three co-signers. Pausing the first through I-4 refuses I-2 on the first
/// (6000) and leaves I-2 on the second working: the flag lives in a PDA-1
/// derived from its own mint, and no instruction reads another mint's.
#[test]
fn pausing_one_mint_leaves_minting_on_another_mint_working() {
    let mut a = setup_token_handlers(false);
    let payer = a.payer.insecure_clone();

    // A second mint in the same VM, with its own co-signers.
    let fx_b = token::create_three_extension_mint(&mut a.svm, &payer);
    let issuer_b = solana_keypair::Keypair::new();
    let operator_b = solana_keypair::Keypair::new();
    let reserve_b = solana_keypair::Keypair::new();
    let pda1_b = seed_mint_state(
        &mut a.svm,
        &fx_b.mint,
        &issuer_b.pubkey(),
        &operator_b.pubkey(),
        &reserve_b.pubkey(),
        false,
    );
    assert_eq!(pda1_b, fx_b.pda1);
    assert_ne!(fx_b.mint, a.fx.mint);
    assert_ne!(fx_b.pda1, a.fx.pda1);

    // Pause the first mint, signed by its operator alone.
    let operator_a = a.operator.insecure_clone();
    let ix = pause_ix(&a.fx.mint, &a.fx.pda1, &operator_a.pubkey(), true);
    send(&mut a.svm, &payer, ix, &[&operator_a]).unwrap();
    assert!(read_mint_state(&a.svm, &a.fx.pda1).pause_active);
    assert!(!read_mint_state(&a.svm, &fx_b.pda1).pause_active);

    // The second mint still mints.
    let destination_b =
        token::create_token_account(&mut a.svm, &payer, &fx_b.mint, &Pubkey::new_unique());
    let ix = mint_tokens_ix(
        mint_tokens_metas(
            &fx_b.mint,
            &destination_b,
            &fx_b.pda1,
            &issuer_b.pubkey(),
            &reserve_b.pubkey(),
        ),
        7,
    );
    send(&mut a.svm, &payer, ix, &[&issuer_b, &reserve_b]).unwrap();
    let account_b = a.svm.get_account(&destination_b).unwrap();
    let amount_b = StateWithExtensions::<TokenAccount>::unpack(&account_b.data)
        .unwrap()
        .base
        .amount;
    assert_eq!(amount_b, 7);

    // The first mint refuses, with the authorized signers.
    let issuer_a = a.issuer.insecure_clone();
    let reserve_a = a.reserve.insecure_clone();
    let destination_a =
        token::create_token_account(&mut a.svm, &payer, &a.fx.mint, &Pubkey::new_unique());
    let ix = mint_tokens_ix(
        mint_tokens_metas(
            &a.fx.mint,
            &destination_a,
            &a.fx.pda1,
            &issuer_a.pubkey(),
            &reserve_a.pubkey(),
        ),
        7,
    );
    let res = send(&mut a.svm, &payer, ix, &[&issuer_a, &reserve_a]);
    assert_custom(res, 6000); // MintPaused
}
