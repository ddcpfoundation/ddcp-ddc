//! I-8 rotate_signer integration suite (LiteSVM, real .so). Pins each of the
//! three fixed role mappings individually (a transposed map fails these),
//! proves the Issuer-excluded operator-and-reserve tier positively and
//! negatively, the incoming key's signature (D-210), the fixed
//! pubkey-before-role-before-new-key validation order, strict/truncated args,
//! and self-rotation semantics.

mod common;

use common::*;
use ddcp_ddc::instruction::RotateSignerArgs;
use ddcp_ddc::state::MintState;
use solana_keypair::Keypair;
use solana_program::instruction::{AccountMeta, InstructionError};
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;

fn args_bytes(role: u8, new_pubkey: Pubkey) -> Vec<u8> {
    borsh::to_vec(&RotateSignerArgs { role, new_pubkey }).unwrap()
}

/// I-8 with the incoming key's account present but NOT signing: for the
/// refusals the program makes before it judges that signature.
fn rotate_ix_new_unsigned(
    ctx: &Ctx,
    operator: &Pubkey,
    reserve: &Pubkey,
    new_key: &Pubkey,
    arg_bytes: Vec<u8>,
) -> solana_program::instruction::Instruction {
    let mut ix = rotate_ix(&ctx.mint, &ctx.pda1, operator, reserve, new_key, arg_bytes);
    ix.accounts[4] = AccountMeta::new_readonly(*new_key, false);
    ix
}

// ---------------------------------------------------------------------------
// The three role mappings, pinned individually
// ---------------------------------------------------------------------------

#[test]
fn role_0_rotates_exactly_issuer_authority() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Keypair::new();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        &new_key.pubkey(),
        args_bytes(0, new_key.pubkey()),
    );
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve, &new_key],
    )
    .unwrap();

    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert_eq!(after.issuer_authority, new_key.pubkey()); // the mapped field changed…
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
    let new_key = Keypair::new();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        &new_key.pubkey(),
        args_bytes(1, new_key.pubkey()),
    );
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve, &new_key],
    )
    .unwrap();

    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert_eq!(after.operator_authority, new_key.pubkey());
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
    let new_key = Keypair::new();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);

    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        &new_key.pubkey(),
        args_bytes(2, new_key.pubkey()),
    );
    send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve, &new_key],
    )
    .unwrap();

    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    assert_eq!(after.reserve_authority, new_key.pubkey());
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
// Tier negatives: the Issuer exclusion and positional matching. The incoming
// key's account is present and unsigned: these refusals come first.
// ---------------------------------------------------------------------------

#[test]
fn issuer_in_operator_slot_is_unauthorized() {
    let mut ctx = setup(false);
    let issuer = ctx.issuer.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Pubkey::new_unique();
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &issuer.pubkey(), // Issuer key where Operator must sign
        &reserve.pubkey(),
        &new_key,
        args_bytes(0, new_key),
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
    let new_key = Pubkey::new_unique();
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &operator.pubkey(),
        &issuer.pubkey(), // Issuer key where Reserve must sign
        &new_key,
        args_bytes(0, new_key),
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
    let new_key = Pubkey::new_unique();
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &reserve.pubkey(), // right keys, wrong slots
        &operator.pubkey(),
        &new_key,
        args_bytes(1, new_key),
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
// Business validation: fixed order (pubkey, then role, then the new key's
// signature, then distinctness)
// ---------------------------------------------------------------------------

#[test]
fn role_3_is_invalid_role() {
    // The new key does not sign: the role is refused before its signature is judged.
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Pubkey::new_unique();
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &operator.pubkey(),
        &reserve.pubkey(),
        &new_key,
        args_bytes(3, new_key),
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
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &operator.pubkey(),
        &reserve.pubkey(),
        &Pubkey::default(),
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
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &operator.pubkey(),
        &reserve.pubkey(),
        &Pubkey::default(),
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
// The incoming key signs (D-210)
// ---------------------------------------------------------------------------

#[test]
fn rotation_to_a_key_that_does_not_sign_is_refused_and_writes_nothing() {
    // The case D-210 closes: an address with no secret, or one whose holder
    // did not sign, is never stored. Each role is tried.
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    for role in [0u8, 1, 2] {
        let nobody = Pubkey::new_unique();
        let before = read_mint_state(&ctx.svm, &ctx.pda1);
        let ix = rotate_ix_new_unsigned(
            &ctx,
            &operator.pubkey(),
            &reserve.pubkey(),
            &nobody,
            args_bytes(role, nobody),
        );
        let res = send(
            &mut ctx.svm,
            &ctx.payer.insecure_clone(),
            ix,
            &[&operator, &reserve],
        );
        assert_eq!(
            res,
            Err(InstructionError::MissingRequiredSignature),
            "role {role}"
        );
        assert_eq!(read_mint_state(&ctx.svm, &ctx.pda1), before, "role {role}");
    }
}

#[test]
fn signer_in_the_new_key_slot_other_than_new_pubkey_is_unauthorized() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let stranger = Keypair::new();
    let named = Pubkey::new_unique();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);
    let ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        &stranger.pubkey(), // signs, but is not the key the args store
        args_bytes(2, named),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve, &stranger],
    );
    assert_custom(res, 6001);
    assert_eq!(read_mint_state(&ctx.svm, &ctx.pda1), before);
}

#[test]
fn four_accounts_without_the_new_key_are_not_enough_account_keys() {
    // The pre-D-210 account list is refused before anything is read.
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Keypair::new();
    let before = read_mint_state(&ctx.svm, &ctx.pda1);
    let mut ix = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &reserve.pubkey(),
        &new_key.pubkey(),
        args_bytes(2, new_key.pubkey()),
    );
    ix.accounts.truncate(4);
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    #[allow(deprecated)]
    let not_enough = matches!(
        res,
        Err(InstructionError::NotEnoughAccountKeys) | Err(InstructionError::MissingAccount)
    );
    assert!(not_enough, "expected NotEnoughAccountKeys, got {res:?}");
    assert_eq!(read_mint_state(&ctx.svm, &ctx.pda1), before);
}

#[test]
fn new_key_signature_is_judged_before_distinctness() {
    // The operator role is given the issuer's key and the issuer does not
    // sign: the missing signature is reported, not CoSignersNotDistinct.
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let issuer = ctx.issuer.pubkey();
    let ix = rotate_ix_new_unsigned(
        &ctx,
        &operator.pubkey(),
        &reserve.pubkey(),
        &issuer,
        args_bytes(1, issuer),
    );
    let res = send(
        &mut ctx.svm,
        &ctx.payer.insecure_clone(),
        ix,
        &[&operator, &reserve],
    );
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

// ---------------------------------------------------------------------------
// Strict / truncated args (the plan's added negative)
// ---------------------------------------------------------------------------

#[test]
fn truncated_new_pubkey_is_invalid_instruction_data() {
    let mut ctx = setup(false);
    let operator = ctx.operator.insecure_clone();
    let reserve = ctx.reserve.insecure_clone();
    let new_key = Pubkey::new_unique();
    let mut bytes = args_bytes(1, new_key);
    bytes.truncate(bytes.len() - 5); // cut new_pubkey short mid-field
    let ix = rotate_ix_new_unsigned(&ctx, &operator.pubkey(), &reserve.pubkey(), &new_key, bytes);
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
    let new_key = Pubkey::new_unique();
    let mut bytes = args_bytes(1, new_key);
    bytes.push(0x00);
    let ix = rotate_ix_new_unsigned(&ctx, &operator.pubkey(), &reserve.pubkey(), &new_key, bytes);
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
        &new_reserve.pubkey(),
        args_bytes(2, new_reserve.pubkey()),
    );
    send(
        &mut ctx.svm,
        &payer,
        ix,
        &[&operator, &old_reserve, &new_reserve],
    )
    .unwrap();
    assert_eq!(
        read_mint_state(&ctx.svm, &ctx.pda1).reserve_authority,
        new_reserve.pubkey()
    );

    // Old Reserve key in the reserve slot now fails.
    let next = Keypair::new();
    let stale = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &operator.pubkey(),
        &old_reserve.pubkey(),
        &next.pubkey(),
        args_bytes(2, next.pubkey()),
    );
    let res = send(
        &mut ctx.svm,
        &payer,
        stale,
        &[&operator, &old_reserve, &next],
    );
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
        &new_operator.pubkey(),
        args_bytes(1, new_operator.pubkey()),
    );
    send(
        &mut ctx.svm,
        &payer,
        ix,
        &[&old_operator, &reserve, &new_operator],
    )
    .unwrap();

    // The new Operator key co-signs a subsequent rotation successfully.
    let new_issuer = Keypair::new();
    let next = rotate_ix(
        &ctx.mint,
        &ctx.pda1,
        &new_operator.pubkey(),
        &reserve.pubkey(),
        &new_issuer.pubkey(),
        args_bytes(0, new_issuer.pubkey()),
    );
    send(
        &mut ctx.svm,
        &payer,
        next,
        &[&new_operator, &reserve, &new_issuer],
    )
    .unwrap();
}

// ---------------------------------------------------------------------------
// Distinct co-signers: a replacement may not give one role another role's
// current key (CoSignersNotDistinct, 6012); replacing a key with itself stays
// permitted. Each refused send leaves PDA-1 byte-for-byte unchanged.
// ---------------------------------------------------------------------------

/// Sends one rotation of `role` to `new_key`, co-signed by the live Operator and
/// Reserve and signed by `new_key`, and returns the result with PDA-1 before and after.
fn rotate_to(
    ctx: &mut Ctx,
    role: u8,
    new_key: &Keypair,
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
        &new_key.pubkey(),
        args_bytes(role, new_key.pubkey()),
    );
    let res = send(&mut ctx.svm, &payer, ix, &[&operator, &reserve, new_key]);
    let after = read_mint_state(&ctx.svm, &ctx.pda1);
    (res, before, after)
}

#[test]
fn rotation_giving_the_issuer_another_roles_key_is_refused() {
    let mut ctx = setup(false);
    for other in [ctx.operator.insecure_clone(), ctx.reserve.insecure_clone()] {
        let (res, before, after) = rotate_to(&mut ctx, 0, &other);
        assert_custom(res, 6012);
        assert_eq!(after, before);
    }
}

#[test]
fn rotation_giving_the_operator_another_roles_key_is_refused() {
    let mut ctx = setup(false);
    for other in [ctx.issuer.insecure_clone(), ctx.reserve.insecure_clone()] {
        let (res, before, after) = rotate_to(&mut ctx, 1, &other);
        assert_custom(res, 6012);
        assert_eq!(after, before);
    }
}

#[test]
fn rotation_giving_the_reserve_another_roles_key_is_refused() {
    let mut ctx = setup(false);
    for other in [ctx.issuer.insecure_clone(), ctx.operator.insecure_clone()] {
        let (res, before, after) = rotate_to(&mut ctx, 2, &other);
        assert_custom(res, 6012);
        assert_eq!(after, before);
    }
}

#[test]
fn rotation_of_each_role_to_its_own_current_key_is_permitted() {
    let mut ctx = setup(false);
    for (role, own) in [
        (0u8, ctx.issuer.insecure_clone()),
        (1, ctx.operator.insecure_clone()),
        (2, ctx.reserve.insecure_clone()),
    ] {
        ctx.svm.expire_blockhash();
        let (res, before, after) = rotate_to(&mut ctx, role, &own);
        res.unwrap();
        assert_eq!(after, before);
    }
}
