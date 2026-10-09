//! I-8 rotate_signer integration suite (LiteSVM, real .so). Pins each of the
//! three fixed role mappings individually (a transposed map fails these),
//! proves the Issuer-excluded 2-of-2 tier positively and negatively, the
//! fixed pubkey-before-role validation order, strict/truncated args,
//! and self-rotation semantics.

mod common;

use common::*;
use ddcp_ddc::instruction::RotateSignerArgs;
use ddcp_ddc::state::MintState;
use solana_keypair::Keypair;
use solana_program::instruction::InstructionError;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;

fn args_bytes(role: u8, new_pubkey: Pubkey) -> Vec<u8> {
    borsh::to_vec(&RotateSignerArgs { role, new_pubkey }).unwrap()
}

// ---------------------------------------------------------------------------
// The three role mappings, pinned individually
// ---------------------------------------------------------------------------

#[test]
fn role_0_rotates_exactly_issuer_authority() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Pubkey::new_unique();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(0, new_key),
    );
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    )
    .unwrap();

    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert_eq!(after.issuer_authority, new_key); // the mapped field changed…
    assert_eq!(after.operator_authority, before.operator_authority); // …and only it
    assert_eq!(after.reserve_authority, before.reserve_authority);
    assert_eq!(after.pause_active, before.pause_active);
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
fn role_1_rotates_exactly_operator_authority() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Pubkey::new_unique();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(1, new_key),
    );
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    )
    .unwrap();

    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert_eq!(after.operator_authority, new_key);
    assert_eq!(after.issuer_authority, before.issuer_authority);
    assert_eq!(after.reserve_authority, before.reserve_authority);
    assert_eq!(
        after.fee_ceiling_basis_points,
        before.fee_ceiling_basis_points
    );
    assert_eq!(after.fee_ceiling_base_units, before.fee_ceiling_base_units);
    assert_eq!(after.reserved, [0u8; 54]);
}

#[test]
fn role_2_rotates_exactly_reserve_authority() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Pubkey::new_unique();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(2, new_key),
    );
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    )
    .unwrap();

    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert_eq!(after.reserve_authority, new_key);
    assert_eq!(after.issuer_authority, before.issuer_authority);
    assert_eq!(after.operator_authority, before.operator_authority);
    assert_eq!(
        after.fee_ceiling_basis_points,
        before.fee_ceiling_basis_points
    );
    assert_eq!(after.fee_ceiling_base_units, before.fee_ceiling_base_units);
    assert_eq!(after.reserved, [0u8; 54]);
}

// ---------------------------------------------------------------------------
// Tier negatives: the Issuer exclusion and positional matching
// ---------------------------------------------------------------------------

#[test]
fn issuer_in_operator_slot_is_unauthorized() {
    let mut ctx = setup(false);
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &issuer.pubkey(), // Issuer key where Operator must sign
        &reserve.pubkey(),
        args_bytes(0, Pubkey::new_unique()),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&issuer, &reserve],
    );
    assert_custom(res, 6001); // a compromised Issuer key can't authorize its own rotation
}

#[test]
fn issuer_in_reserve_slot_is_unauthorized() {
    let mut ctx = setup(false);
    let issuer = ctx.issuer.insecure_clone();
    let operator = ctx.operator.insecure_clone();
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &issuer.pubkey(), // Issuer key where Reserve must sign
        args_bytes(0, Pubkey::new_unique()),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &issuer],
    );
    assert_custom(res, 6001);
}

#[test]
fn swapped_operator_reserve_slots_are_unauthorized() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &reserve.pubkey(), // right keys, wrong slots
        &operator.pubkey(),
        args_bytes(1, Pubkey::new_unique()),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_custom(res, 6001);
}

// ---------------------------------------------------------------------------
// Business validation: fixed order (pubkey before role)
// ---------------------------------------------------------------------------

#[test]
fn role_3_is_invalid_role() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(3, Pubkey::new_unique()),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_custom(res, 6005); // InvalidRole
}

#[test]
fn default_pubkey_is_invalid_pubkey() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(1, Pubkey::default()),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_custom(res, 6004); // InvalidPubkey
}

#[test]
fn pubkey_check_precedes_role_check_spec_order() {
    // Both invalid: role = 7 AND new_pubkey = default. The order is fixed —
    // "new_pubkey != default → else InvalidPubkey; role <= 2 → else InvalidRole"
    // — so InvalidPubkey (6004) must win, not InvalidRole (6005).
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(7, Pubkey::default()),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_custom(res, 6004);
}

// ---------------------------------------------------------------------------
// Strict / truncated args (the plan's added negative)
// ---------------------------------------------------------------------------

#[test]
fn truncated_new_pubkey_is_invalid_instruction_data() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let mut bytes = args_bytes(1, Pubkey::new_unique());
    bytes.truncate(bytes.len() - 5); // cut new_pubkey short mid-field
    let ix = rotate_ix(&ctx.mint, &ctx.pda1, &operator.pubkey(), &reserve.pubkey(), bytes);
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

#[test]
fn trailing_args_are_invalid_instruction_data() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let mut bytes = args_bytes(1, Pubkey::new_unique());
    bytes.push(0x00);
    let ix = rotate_ix(&ctx.mint, &ctx.pda1, &operator.pubkey(), &reserve.pubkey(), bytes);
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

// ---------------------------------------------------------------------------
// Self-rotation and post-rotation functionality
// ---------------------------------------------------------------------------

#[test]
fn reserve_self_rotation_ok_and_old_key_rejected_after() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let old_reserve = ctx.reserve.insecure_clone();
    let new_reserve = Keypair::new();
    let payer = ctx.payer.insecure_clone();

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &old_reserve.pubkey(),
        args_bytes(2, new_reserve.pubkey()),
    );
    send(&mut ctx.svm, &payer, ix, &[&operator, &old_reserve]).unwrap();
    assert_eq!(
        read_mint_state(&ctx.svm, &ctx.pda1).reserve_authority,
        new_reserve.pubkey()
    );

    // Old Reserve key in the reserve slot now fails.
    let stale = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &old_reserve.pubkey(),
        args_bytes(2, Pubkey::new_unique()),
    );
    let res = send(&mut ctx.svm, &payer, stale, &[&operator, &old_reserve]);
    assert_custom(res, 6001);
}

#[test]
fn post_rotation_new_operator_key_is_functional() {
    let mut ctx = setup(false);
    let old_operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_operator = Keypair::new();
    let payer = ctx.payer.insecure_clone();

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &old_operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(1, new_operator.pubkey()),
    );
    send(&mut ctx.svm, &payer, ix, &[&old_operator, &reserve]).unwrap();

    // The new Operator key co-signs a subsequent rotation successfully.
    let next = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &new_operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(0, Pubkey::new_unique()),
    );
    send(&mut ctx.svm, &payer, next, &[&new_operator, &reserve]).unwrap();
}

// ---------------------------------------------------------------------------
// Distinct co-signers: a replacement may not give one role another role's
// current key (CoSignersNotDistinct, 6012); replacing a key with itself stays
// permitted. Each refused send leaves PDA-1 byte-for-byte unchanged.
// ---------------------------------------------------------------------------

/// Sends one rotation of `role` to `new_key`, co-signed by the live Operator and
/// Reserve, and returns the result with PDA-1 before and after.
fn rotate_to(
    ctx: &mut Ctx,
    role: u8,
    new_key: Pubkey,
) -> (Result<(), InstructionError>, MintState, MintState) {
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let payer = ctx.payer.insecure_clone();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        args_bytes(role, new_key),
    );
    let res = send(&mut ctx.svm, &payer, ix, &[&operator, &reserve]);
    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    (res, before, after)
}

#[test]
fn rotation_giving_the_issuer_another_roles_key_is_refused() {
    let mut ctx = setup(false);
    for other in [ctx.operator.pubkey(), ctx.reserve.pubkey()] {
        let (res, before, after) = rotate_to(&mut ctx, 0, other);
        assert_custom(res, 6012);
        assert_eq!(after, before);
    }
}

#[test]
fn rotation_giving_the_operator_another_roles_key_is_refused() {
    let mut ctx = setup(false);
    for other in [ctx.issuer.pubkey(), ctx.reserve.pubkey()] {
        let (res, before, after) = rotate_to(&mut ctx, 1, other);
        assert_custom(res, 6012);
        assert_eq!(after, before);
    }
}

#[test]
fn rotation_giving_the_reserve_another_roles_key_is_refused() {
    let mut ctx = setup(false);
    for other in [ctx.issuer.pubkey(), ctx.operator.pubkey()] {
        let (res, before, after) = rotate_to(&mut ctx, 2, other);
        assert_custom(res, 6012);
        assert_eq!(after, before);
    }
}

#[test]
fn rotation_of_each_role_to_its_own_current_key_is_permitted() {
    let mut ctx = setup(false);
    for (role, own) in [
        (0u8, ctx.issuer.pubkey()),
        (1, ctx.operator.pubkey()),
        (2, ctx.reserve.pubkey()),
    ] {
        ctx.svm.expire_blockhash();
        let (res, before, after) = rotate_to(&mut ctx, role, own);
        res.unwrap();
        assert_eq!(after, before);
    }
}
