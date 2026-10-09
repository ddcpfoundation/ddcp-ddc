mod common;

use common::token;
use common::{Ctx, TokenHandlerCtx};
use ddcp_ddc::instruction as ix;
use ddcp_ddc::pda;
use ddcp_ddc::state::{MintState, MINT_STATE_LEN};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_program::instruction::{AccountMeta, Instruction, InstructionError};
use solana_program::program_option::COption;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use spl_token_2022_interface::extension::transfer_fee::TransferFeeConfig;
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::{Account as TokenAccount, Mint};

// ---------------------------------------------------------------- helpers

const E_PAUSED: u32 = 6000;
const E_UNAUTHORIZED: u32 = 6001;
const E_FEE_BOUNDS: u32 = 6002;
const E_URI: u32 = 6003;
const E_PUBKEY: u32 = 6004;
const E_ROLE: u32 = 6005;
const E_INSTRUCTION: u32 = 6006;
const E_MINT_MISMATCH: u32 = 6007;
const E_FEE_ABOVE: u32 = 6008;
const E_MAX_FEE_ABOVE: u32 = 6009;
const E_CEILING: u32 = 6010;
const E_CT_AUTH: u32 = 6011;
const E_NOT_DISTINCT: u32 = 6012;

/// Sends one instruction on a fresh blockhash so repeated identical
/// transactions are not deduplicated.
fn run(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    signers: &[&Keypair],
) -> Result<(), InstructionError> {
    svm.expire_blockhash();
    common::send(svm, payer, instruction, signers)
}

fn expect(result: Result<(), InstructionError>, err: InstructionError) {
    assert_eq!(result, Err(err));
}

/// NotEnoughAccountKeys; the runtime may surface it under its replacement
/// name MissingAccount, so both are accepted.
#[allow(deprecated)]
fn expect_not_enough_keys(result: Result<(), InstructionError>) {
    assert!(
        matches!(
            result,
            Err(InstructionError::NotEnoughAccountKeys) | Err(InstructionError::MissingAccount)
        ),
        "expected NotEnoughAccountKeys, got {result:?}"
    );
}

fn snapshot(svm: &LiteSVM, keys: &[Pubkey]) -> Vec<Option<Account>> {
    keys.iter().map(|k| svm.get_account(k)).collect()
}

fn absent(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key).is_none_or(|a| a.lamports == 0)
}

fn copy_account_to(svm: &mut LiteSVM, from: &Pubkey, to: Pubkey, owner: Option<Pubkey>) {
    let mut acct = svm.get_account(from).unwrap();
    if let Some(o) = owner {
        acct.owner = o;
    }
    svm.set_account(to, acct).unwrap();
}

fn set_owner(svm: &mut LiteSVM, key: &Pubkey, owner: Pubkey) {
    copy_account_to(svm, key, *key, Some(owner));
}

/// A valid off-curve address for (seed, mint) with a bump below the canonical one.
fn noncanonical_pda(seed: &[u8], mint: &Pubkey) -> (Pubkey, u8) {
    let program_id = ddcp_ddc::id();
    let (_, canonical) = Pubkey::find_program_address(&[seed, mint.as_ref()], &program_id);
    for bump in (0..canonical).rev() {
        if let Ok(addr) =
            Pubkey::create_program_address(&[seed, mint.as_ref(), &[bump]], &program_id)
        {
            return (addr, bump);
        }
    }
    panic!("no non-canonical bump found");
}

/// Seeds MintState at a non-canonical PDA-1 address of `mint`, copying the
/// canonical record and writing the non-canonical bump.
fn seed_noncanonical_mint_state(
    svm: &mut LiteSVM,
    mint: &Pubkey,
    canonical_pda1: &Pubkey,
) -> Pubkey {
    let (addr, bump) = noncanonical_pda(pda::MINT_STATE_SEED, mint);
    let mut state = common::read_mint_state(svm, canonical_pda1);
    state.bump = bump;
    let mut data = vec![0u8; MINT_STATE_LEN];
    state.save(&mut data).unwrap();
    svm.set_account(
        addr,
        Account {
            lamports: 10_000_000,
            data,
            owner: ddcp_ddc::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    addr
}

fn rotate_args(role: u8, new_pubkey: Pubkey) -> Vec<u8> {
    borsh::to_vec(&ix::RotateSignerArgs { role, new_pubkey }).unwrap()
}

fn publish_args(amount: u64, uri: &[u8]) -> Vec<u8> {
    borsh::to_vec(&ix::PublishAttestationArgs {
        attested_reserve_amount: amount,
        attestation_uri: uri.to_vec(),
    })
    .unwrap()
}

fn state(c: &Ctx) -> MintState {
    common::read_mint_state(&c.svm, &c.pda1)
}

fn supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let a = svm.get_account(mint).unwrap();
    StateWithExtensions::<Mint>::unpack(&a.data)
        .unwrap()
        .base
        .supply
}

fn balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let a = svm.get_account(account).unwrap();
    StateWithExtensions::<TokenAccount>::unpack(&a.data)
        .unwrap()
        .base
        .amount
}

fn newer_fee(svm: &LiteSVM, mint: &Pubkey) -> (u16, u64) {
    let a = svm.get_account(mint).unwrap();
    let st = StateWithExtensions::<Mint>::unpack(&a.data).unwrap();
    let tf = st.get_extension::<TransferFeeConfig>().unwrap();
    (
        u16::from(tf.newer_transfer_fee.transfer_fee_basis_points),
        u64::from(tf.newer_transfer_fee.maximum_fee),
    )
}

// -------- token-handler context (mint / burn / fee)

fn tctx(paused: bool) -> (TokenHandlerCtx, Pubkey) {
    let mut c = common::setup_token_handlers(paused);
    let dest = token::create_token_account(&mut c.svm, &c.payer, &c.fx.mint, &Pubkey::new_unique());
    (c, dest)
}

fn std_mint_metas(c: &TokenHandlerCtx, dest: &Pubkey) -> Vec<AccountMeta> {
    common::mint_tokens_metas(
        &c.fx.mint,
        dest,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    )
}

fn do_mint(c: &mut TokenHandlerCtx, dest: &Pubkey, amount: u64) -> Result<(), InstructionError> {
    let i = common::mint_tokens_ix(std_mint_metas(c, dest), amount);
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve])
}

/// Redemption-collection account (owner = PDA-5) holding `amount` tokens.
fn redemption_account(c: &mut TokenHandlerCtx, amount: u64) -> Pubkey {
    let acct = token::create_token_account(&mut c.svm, &c.payer, &c.fx.mint, &c.fx.pda5);
    do_mint(c, &acct, amount).expect("funding mint to redemption account must succeed");
    acct
}

fn std_burn_metas(c: &TokenHandlerCtx, source: &Pubkey) -> Vec<AccountMeta> {
    common::burn_tokens_metas(
        &c.fx.mint,
        source,
        &c.fx.pda1,
        &c.fx.pda5,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    )
}

fn std_fee_metas(c: &TokenHandlerCtx) -> Vec<AccountMeta> {
    common::update_transfer_fee_metas(
        &c.fx.mint,
        &c.fx.pda3,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
    )
}

fn do_fee(c: &mut TokenHandlerCtx, bps: u16, max: u64, min: u64) -> Result<(), InstructionError> {
    let i = common::update_transfer_fee_ix(std_fee_metas(c), bps, max, min);
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator])
}

// -------- initialize_mint context

struct InitCtx {
    svm: LiteSVM,
    payer: Keypair,
    mint: Keypair,
    pda1: Pubkey,
    pda2: Pubkey,
    mua: Pubkey,
    args: ix::InitializeMintArgs,
}

fn init_ctx() -> InitCtx {
    let token::TokenCtx { mut svm, payer } = token::setup_token();
    svm.add_program_from_file(ddcp_ddc::id(), common::SO_PATH)
        .expect("missing target/deploy/ddcp_ddc.so");
    let mint = Keypair::new();
    let (pda1, _) = pda::find_mint_state_address(&mint.pubkey(), &ddcp_ddc::id());
    let (pda2, _) = pda::find_attestation_address(&mint.pubkey(), &ddcp_ddc::id());
    let args = common::sample_initialize_mint_args(
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
    );
    InitCtx {
        svm,
        payer,
        mint,
        pda1,
        pda2,
        mua: Pubkey::new_unique(),
        args,
    }
}

fn init_metas(c: &InitCtx) -> Vec<AccountMeta> {
    common::initialize_mint_metas(
        &c.mint.pubkey(),
        &c.pda1,
        &c.pda2,
        &c.payer.pubkey(),
        &c.mua,
    )
}

fn do_init(c: &mut InitCtx) -> Result<(), InstructionError> {
    let i = common::initialize_mint_ix(init_metas(c), &c.args);
    run(&mut c.svm, &c.payer, i, &[&c.mint])
}

fn assert_nothing_created(c: &InitCtx) {
    assert!(absent(&c.svm, &c.mint.pubkey()), "mint must not exist");
    assert!(absent(&c.svm, &c.pda1), "PDA-1 must not exist");
    assert!(absent(&c.svm, &c.pda2), "PDA-2 must not exist");
}

// ================================================================ dispatch

#[test]
fn adv_dispatch_unknown_discriminator() {
    // Unknown 8-byte discriminator: 6006, PDA-1 unchanged.
    let mut c = common::setup(false);
    let before = snapshot(&c.svm, &[c.pda1]);
    let mut i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    i.data = vec![0xAA; 8];
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_INSTRUCTION);
    assert_eq!(snapshot(&c.svm, &[c.pda1]), before);
}

#[test]
fn adv_dispatch_short_discriminator() {
    // 7 bytes of a valid discriminator: 6006, PDA-1 unchanged.
    let mut c = common::setup(false);
    let before = snapshot(&c.svm, &[c.pda1]);
    let mut i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    i.data = ix::PAUSE_ISSUANCE_DISCRIMINATOR[..7].to_vec();
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_INSTRUCTION);
    assert_eq!(snapshot(&c.svm, &[c.pda1]), before);
}

#[test]
fn adv_dispatch_empty_data() {
    // Empty instruction data: 6006.
    let mut c = common::setup(false);
    let mut i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    i.data = vec![];
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_INSTRUCTION);
    assert!(!state(&c).pause_active);
}

// ================================================================ I-1 initialize_mint

#[test]
fn adv_init_happy_path_then_reinit_refused() {
    // Genesis succeeds and records the three keys and ceilings; a second
    // initialize of the same mint fails (error not settled) and leaves all three accounts unchanged.
    let mut c = init_ctx();
    do_init(&mut c).unwrap();
    let st = common::read_mint_state(&c.svm, &c.pda1);
    assert_eq!(st.issuer_authority, c.args.issuer_authority);
    assert_eq!(st.operator_authority, c.args.operator_authority);
    assert_eq!(st.reserve_authority, c.args.reserve_authority);
    assert_eq!(st.fee_ceiling_basis_points, c.args.fee_ceiling_basis_points);
    assert_eq!(st.fee_ceiling_base_units, c.args.fee_ceiling_base_units);
    assert!(!st.pause_active);
    let p1 = c.svm.get_account(&c.pda1).unwrap();
    assert_eq!(p1.owner, ddcp_ddc::id());
    assert_eq!(p1.data.len(), 178);
    let p2 = c.svm.get_account(&c.pda2).unwrap();
    assert_eq!(p2.owner, ddcp_ddc::id());
    assert_eq!(p2.data.len(), 185);
    let m = c.svm.get_account(&c.mint.pubkey()).unwrap();
    assert_eq!(m.owner, spl_token_2022_interface::id());
    let ms = StateWithExtensions::<Mint>::unpack(&m.data).unwrap();
    assert_eq!(ms.base.mint_authority, COption::Some(c.pda1));
    assert_eq!(ms.base.freeze_authority, COption::None);

    let keys = [c.mint.pubkey(), c.pda1, c.pda2];
    let before = snapshot(&c.svm, &keys);
    c.args.name = "other".to_string();
    c.args.issuer_authority = Pubkey::new_unique();
    assert!(do_init(&mut c).is_err());
    assert_eq!(snapshot(&c.svm, &keys), before);
}

#[test]
fn adv_init_fee_ceiling_at_10000_accepted() {
    // fee_ceiling_basis_points == 10000 is accepted and stored.
    let mut c = init_ctx();
    c.args.fee_ceiling_basis_points = 10_000;
    do_init(&mut c).unwrap();
    assert_eq!(
        common::read_mint_state(&c.svm, &c.pda1).fee_ceiling_basis_points,
        10_000
    );
}

#[test]
fn adv_init_fee_ceiling_10001_refused() {
    // fee_ceiling_basis_points == 10001: 6010, nothing created.
    let mut c = init_ctx();
    c.args.fee_ceiling_basis_points = 10_001;
    common::assert_custom(do_init(&mut c), E_CEILING);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_fee_ceiling_u16_max_refused() {
    // fee_ceiling_basis_points == u16::MAX: 6010, nothing created.
    let mut c = init_ctx();
    c.args.fee_ceiling_basis_points = u16::MAX;
    common::assert_custom(do_init(&mut c), E_CEILING);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_ct_mint_authority_some_refused() {
    // confidential_transfer_mint_authority = Some(key): 6011, nothing created.
    let mut c = init_ctx();
    c.args.confidential_transfer_mint_authority = Some(Pubkey::new_unique());
    common::assert_custom(do_init(&mut c), E_CT_AUTH);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_ct_mint_authority_some_default_refused() {
    // confidential_transfer_mint_authority = Some(all-zero key): 6011, nothing created.
    let mut c = init_ctx();
    c.args.confidential_transfer_mint_authority = Some(Pubkey::default());
    common::assert_custom(do_init(&mut c), E_CT_AUTH);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_issuer_equals_operator_refused() {
    // issuer == operator: 6012, nothing created.
    let mut c = init_ctx();
    c.args.operator_authority = c.args.issuer_authority;
    common::assert_custom(do_init(&mut c), E_NOT_DISTINCT);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_operator_equals_reserve_refused() {
    // operator == reserve: 6012, nothing created.
    let mut c = init_ctx();
    c.args.reserve_authority = c.args.operator_authority;
    common::assert_custom(do_init(&mut c), E_NOT_DISTINCT);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_issuer_equals_reserve_refused() {
    // issuer == reserve: 6012, nothing created.
    let mut c = init_ctx();
    c.args.reserve_authority = c.args.issuer_authority;
    common::assert_custom(do_init(&mut c), E_NOT_DISTINCT);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_all_three_keys_equal_refused() {
    // issuer == operator == reserve: 6012, nothing created.
    let mut c = init_ctx();
    c.args.operator_authority = c.args.issuer_authority;
    c.args.reserve_authority = c.args.issuer_authority;
    common::assert_custom(do_init(&mut c), E_NOT_DISTINCT);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_default_metadata_update_authority_refused() {
    // All-zero metadata update authority account: 6004, nothing created.
    let mut c = init_ctx();
    c.mua = Pubkey::default();
    common::assert_custom(do_init(&mut c), E_PUBKEY);
    assert_nothing_created(&c);
}

#[test]
fn adv_init_mint_not_signer() {
    // Mint keypair not signing: MissingRequiredSignature, nothing created.
    let mut c = init_ctx();
    let mut metas = init_metas(&c);
    metas[0] = AccountMeta::new(c.mint.pubkey(), false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[]),
        InstructionError::MissingRequiredSignature,
    );
    assert_nothing_created(&c);
}

#[test]
fn adv_init_payer_slot_not_signer() {
    // A funded account in the payer slot that does not sign: MissingRequiredSignature, nothing created.
    let mut c = init_ctx();
    let other = Keypair::new();
    c.svm.airdrop(&other.pubkey(), 10_000_000_000).unwrap();
    let mut metas = init_metas(&c);
    metas[3] = AccountMeta::new(other.pubkey(), false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::MissingRequiredSignature,
    );
    assert_nothing_created(&c);
}

#[test]
fn adv_init_pda1_not_writable() {
    // PDA-1 passed read-only: Immutable, nothing created.
    let mut c = init_ctx();
    let mut metas = init_metas(&c);
    metas[1] = AccountMeta::new_readonly(c.pda1, false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::Immutable,
    );
    assert_nothing_created(&c);
}

#[test]
fn adv_init_wrong_pda1_address() {
    // PDA-1 slot holds a non-canonical PDA-1 address of this mint: InvalidSeeds, nothing created.
    let mut c = init_ctx();
    let (bad, _) = noncanonical_pda(pda::MINT_STATE_SEED, &c.mint.pubkey());
    let mut metas = init_metas(&c);
    metas[1] = AccountMeta::new(bad, false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::InvalidSeeds,
    );
    assert_nothing_created(&c);
    assert!(absent(&c.svm, &bad));
}

#[test]
fn adv_init_pda2_of_another_mint() {
    // PDA-2 slot holds another mint's canonical PDA-2: InvalidSeeds, nothing created.
    let mut c = init_ctx();
    let (bad, _) = pda::find_attestation_address(&Pubkey::new_unique(), &ddcp_ddc::id());
    let mut metas = init_metas(&c);
    metas[2] = AccountMeta::new(bad, false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::InvalidSeeds,
    );
    assert_nothing_created(&c);
    assert!(absent(&c.svm, &bad));
}

#[test]
fn adv_init_fake_token_program() {
    // Token-2022 slot holds another key: IncorrectProgramId, nothing created.
    let mut c = init_ctx();
    let mut metas = init_metas(&c);
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::IncorrectProgramId,
    );
    assert_nothing_created(&c);
}

#[test]
fn adv_init_fake_system_program() {
    // System program slot holds another key: IncorrectProgramId, nothing created.
    let mut c = init_ctx();
    let mut metas = init_metas(&c);
    metas[4] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let i = common::initialize_mint_ix(metas, &c.args);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::IncorrectProgramId,
    );
    assert_nothing_created(&c);
}

#[test]
fn adv_init_pda1_preexisting() {
    // PDA-1 already holds a MintState for this fresh mint: fails (error not settled), PDA-1 unchanged, mint and PDA-2 not created.
    let mut c = init_ctx();
    let mint = c.mint.pubkey();
    common::seed_mint_state(
        &mut c.svm,
        &mint,
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
        false,
    );
    let before = snapshot(&c.svm, &[c.pda1]);
    assert!(do_init(&mut c).is_err());
    assert_eq!(snapshot(&c.svm, &[c.pda1]), before);
    assert!(absent(&c.svm, &mint));
    assert!(absent(&c.svm, &c.pda2));
}

#[test]
fn adv_init_trailing_byte() {
    // One trailing byte after the args: InvalidInstructionData, nothing created.
    let mut c = init_ctx();
    let mut i = common::initialize_mint_ix(init_metas(&c), &c.args);
    i.data.push(0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.mint]),
        InstructionError::InvalidInstructionData,
    );
    assert_nothing_created(&c);
}

#[test]
fn adv_init_too_few_accounts() {
    // Metadata update authority omitted: NotEnoughAccountKeys, nothing created.
    let mut c = init_ctx();
    let mut metas = init_metas(&c);
    metas.pop();
    let i = common::initialize_mint_ix(metas, &c.args);
    expect_not_enough_keys(run(&mut c.svm, &c.payer, i, &[&c.mint]));
    assert_nothing_created(&c);
}

// ================================================================ I-2 mint_tokens

#[test]
fn adv_mint_happy_path() {
    // Issuer + reserve mint 1_000 to a token account of this mint.
    let (mut c, dest) = tctx(false);
    do_mint(&mut c, &dest, 1_000).unwrap();
    assert_eq!(balance(&c.svm, &dest), 1_000);
    assert_eq!(supply(&c.svm, &c.fx.mint), 1_000);
}

#[test]
fn adv_mint_while_paused() {
    // Paused: 6000, supply unchanged.
    let (mut c, dest) = tctx(true);
    common::assert_custom(do_mint(&mut c, &dest, 1_000), E_PAUSED);
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_issuer_not_signer() {
    // Issuer slot not signed: MissingRequiredSignature.
    let (mut c, dest) = tctx(false);
    let mut metas = std_mint_metas(&c, &dest);
    metas[3] = AccountMeta::new_readonly(c.issuer.pubkey(), false);
    let i = common::mint_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_reserve_not_signer() {
    // Reserve slot not signed: MissingRequiredSignature.
    let (mut c, dest) = tctx(false);
    let mut metas = std_mint_metas(&c, &dest);
    metas[4] = AccountMeta::new_readonly(c.reserve.pubkey(), false);
    let i = common::mint_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_operator_in_reserve_slot() {
    // Operator signs in the reserve slot: 6001.
    let (mut c, dest) = tctx(false);
    let metas = common::mint_tokens_metas(
        &c.fx.mint,
        &dest,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
    );
    let i = common::mint_tokens_ix(metas, 1);
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        E_UNAUTHORIZED,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_issuer_in_both_slots() {
    // Issuer key in both issuer and reserve slots: 6001.
    let (mut c, dest) = tctx(false);
    let metas = common::mint_tokens_metas(
        &c.fx.mint,
        &dest,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.issuer.pubkey(),
    );
    let i = common::mint_tokens_ix(metas, 1);
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_UNAUTHORIZED);
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_stranger_as_issuer() {
    // Unrelated signer in the issuer slot: 6001.
    let (mut c, dest) = tctx(false);
    let stranger = Keypair::new();
    let metas = common::mint_tokens_metas(
        &c.fx.mint,
        &dest,
        &c.fx.pda1,
        &stranger.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::mint_tokens_ix(metas, 1);
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&stranger, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_destination_of_other_mint() {
    // Destination token account of a second mint: 6007, both supplies unchanged.
    let (mut c, _) = tctx(false);
    let other = token::create_three_extension_mint(&mut c.svm, &c.payer);
    let foreign =
        token::create_token_account(&mut c.svm, &c.payer, &other.mint, &Pubkey::new_unique());
    common::assert_custom(do_mint(&mut c, &foreign, 1), E_MINT_MISMATCH);
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
    assert_eq!(supply(&c.svm, &other.mint), 0);
}

#[test]
fn adv_mint_mint_wrong_owner() {
    // Mint account re-owned by a foreign program: InvalidAccountOwner.
    let (mut c, dest) = tctx(false);
    let mint = c.fx.mint;
    set_owner(&mut c.svm, &mint, Pubkey::new_unique());
    expect(
        do_mint(&mut c, &dest, 1),
        InstructionError::InvalidAccountOwner,
    );
    assert_eq!(balance(&c.svm, &dest), 0);
}

#[test]
fn adv_mint_destination_wrong_owner() {
    // Destination re-owned by a foreign program: InvalidAccountOwner.
    let (mut c, dest) = tctx(false);
    set_owner(&mut c.svm, &dest, Pubkey::new_unique());
    expect(
        do_mint(&mut c, &dest, 1),
        InstructionError::InvalidAccountOwner,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_pda1_wrong_owner() {
    // PDA-1 re-owned by a foreign program: InvalidAccountOwner.
    let (mut c, dest) = tctx(false);
    let p = c.fx.pda1;
    set_owner(&mut c.svm, &p, Pubkey::new_unique());
    expect(
        do_mint(&mut c, &dest, 1),
        InstructionError::InvalidAccountOwner,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_fake_token_program() {
    // Token-2022 slot holds another key: IncorrectProgramId.
    let (mut c, dest) = tctx(false);
    let mut metas = std_mint_metas(&c, &dest);
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let i = common::mint_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::IncorrectProgramId,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_noncanonical_pda1() {
    // PDA-1 at a non-canonical bump with valid data: InvalidSeeds.
    let (mut c, dest) = tctx(false);
    let (mint, p1) = (c.fx.mint, c.fx.pda1);
    let bad = seed_noncanonical_mint_state(&mut c.svm, &mint, &p1);
    let metas = common::mint_tokens_metas(&mint, &dest, &bad, &c.issuer.pubkey(), &c.reserve.pubkey());
    let i = common::mint_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(supply(&c.svm, &mint), 0);
}

#[test]
fn adv_mint_pda1_of_other_mint() {
    // PDA-1 of a second mint with the same signers, passed for this mint: InvalidSeeds.
    let (mut c, dest) = tctx(false);
    let other = token::create_three_extension_mint(&mut c.svm, &c.payer);
    let other_pda1 = common::seed_mint_state(
        &mut c.svm,
        &other.mint,
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        false,
    );
    let metas = common::mint_tokens_metas(
        &c.fx.mint,
        &dest,
        &other_pda1,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::mint_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_destination_is_mint() {
    // Mint account passed as destination too: fails (error not settled), supply unchanged.
    let (mut c, _) = tctx(false);
    let mint = c.fx.mint;
    let before = snapshot(&c.svm, &[mint]);
    assert!(do_mint(&mut c, &mint, 1).is_err());
    assert_eq!(snapshot(&c.svm, &[mint]), before);
}

#[test]
fn adv_mint_zero_amount_no_supply_change() {
    // amount 0: outcome not settled; supply and balance stay 0 whatever the result.
    let (mut c, dest) = tctx(false);
    let _ = do_mint(&mut c, &dest, 0);
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
    assert_eq!(balance(&c.svm, &dest), 0);
}

#[test]
fn adv_mint_u64_max_then_overflow() {
    // u64::MAX into an empty supply succeeds; one more fails (error not settled) with supply unchanged.
    let (mut c, dest) = tctx(false);
    do_mint(&mut c, &dest, u64::MAX).unwrap();
    assert_eq!(supply(&c.svm, &c.fx.mint), u64::MAX);
    assert!(do_mint(&mut c, &dest, 1).is_err());
    assert_eq!(supply(&c.svm, &c.fx.mint), u64::MAX);
    assert_eq!(balance(&c.svm, &dest), u64::MAX);
}

#[test]
fn adv_mint_trailing_byte() {
    // One trailing byte: InvalidInstructionData.
    let (mut c, dest) = tctx(false);
    let mut i = common::mint_tokens_ix(std_mint_metas(&c, &dest), 1);
    i.data.push(0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_short_args() {
    // Amount truncated to 7 bytes: InvalidInstructionData.
    let (mut c, dest) = tctx(false);
    let mut i = common::mint_tokens_ix(std_mint_metas(&c, &dest), 1);
    i.data.pop();
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_mint_after_issuer_rotation_old_key_refused() {
    // Issuer rotated to a new key: old issuer + reserve get 6001; new issuer + reserve succeed.
    let (mut c, dest) = tctx(false);
    let new_issuer = Keypair::new();
    let (mint, p1) = (c.fx.mint, c.fx.pda1);
    let r = common::rotate_ix(
        &mint,
        &p1,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, new_issuer.pubkey()),
    );
    run(&mut c.svm, &c.payer, r, &[&c.operator, &c.reserve]).unwrap();
    common::assert_custom(do_mint(&mut c, &dest, 1), E_UNAUTHORIZED);
    assert_eq!(supply(&c.svm, &mint), 0);
    let metas = common::mint_tokens_metas(&mint, &dest, &p1, &new_issuer.pubkey(), &c.reserve.pubkey());
    let i = common::mint_tokens_ix(metas, 5);
    run(&mut c.svm, &c.payer, i, &[&new_issuer, &c.reserve]).unwrap();
    assert_eq!(supply(&c.svm, &mint), 5);
}

// ================================================================ I-3 burn_tokens

#[test]
fn adv_burn_happy_path() {
    // Burn 400 of 1_000 from the PDA-5 redemption account.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 1_000);
    let i = common::burn_tokens_ix(std_burn_metas(&c, &src), 400);
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]).unwrap();
    assert_eq!(balance(&c.svm, &src), 600);
    assert_eq!(supply(&c.svm, &c.fx.mint), 600);
}

#[test]
fn adv_burn_while_paused_allowed() {
    // Paused after funding: burn still succeeds.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 1_000);
    let (mint, p1) = (c.fx.mint, c.fx.pda1);
    let p = common::pause_ix(&mint, &p1, &c.issuer.pubkey(), true);
    run(&mut c.svm, &c.payer, p, &[&c.issuer]).unwrap();
    let i = common::burn_tokens_ix(std_burn_metas(&c, &src), 1_000);
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]).unwrap();
    assert_eq!(supply(&c.svm, &mint), 0);
}

#[test]
fn adv_burn_source_not_owned_by_pda5() {
    // Source of this mint whose owner field is not PDA-5: 6001, balance unchanged.
    let (mut c, dest) = tctx(false);
    do_mint(&mut c, &dest, 1_000).unwrap();
    let i = common::burn_tokens_ix(std_burn_metas(&c, &dest), 1);
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert_eq!(balance(&c.svm, &dest), 1_000);
}

#[test]
fn adv_burn_source_of_other_mint() {
    // Source of a second mint (owner field = this mint's PDA-5): 6007.
    let (mut c, _) = tctx(false);
    let other = token::create_three_extension_mint(&mut c.svm, &c.payer);
    let pda5 = c.fx.pda5;
    let foreign = token::create_token_account(&mut c.svm, &c.payer, &other.mint, &pda5);
    let i = common::burn_tokens_ix(std_burn_metas(&c, &foreign), 0);
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        E_MINT_MISMATCH,
    );
}

#[test]
fn adv_burn_issuer_not_signer() {
    // Issuer not signed: MissingRequiredSignature.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let mut metas = std_burn_metas(&c, &src);
    metas[4] = AccountMeta::new_readonly(c.issuer.pubkey(), false);
    let i = common::burn_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_reserve_not_signer() {
    // Reserve not signed: MissingRequiredSignature.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let mut metas = std_burn_metas(&c, &src);
    metas[5] = AccountMeta::new_readonly(c.reserve.pubkey(), false);
    let i = common::burn_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_operator_in_issuer_slot() {
    // Operator signs in the issuer slot: 6001.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let metas = common::burn_tokens_metas(
        &c.fx.mint,
        &src,
        &c.fx.pda1,
        &c.fx.pda5,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::burn_tokens_ix(metas, 1);
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.operator, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_reserve_in_both_slots() {
    // Reserve key in both issuer and reserve slots: 6001.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let metas = common::burn_tokens_metas(
        &c.fx.mint,
        &src,
        &c.fx.pda1,
        &c.fx.pda5,
        &c.reserve.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::burn_tokens_ix(metas, 1);
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.reserve]), E_UNAUTHORIZED);
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_noncanonical_pda5() {
    // PDA-5 slot at a non-canonical bump: InvalidSeeds.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let (bad, _) = noncanonical_pda(pda::REDEMPTION_AUTHORITY_SEED, &c.fx.mint);
    let metas = common::burn_tokens_metas(
        &c.fx.mint,
        &src,
        &c.fx.pda1,
        &bad,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::burn_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_pda5_of_other_mint() {
    // PDA-5 of another mint, with a source owned by that PDA-5: fails (error not settled), balance unchanged.
    let (mut c, _) = tctx(false);
    let (other_pda5, _) =
        pda::find_redemption_authority_address(&Pubkey::new_unique(), &ddcp_ddc::id());
    let mint = c.fx.mint;
    let src = token::create_token_account(&mut c.svm, &c.payer, &mint, &other_pda5);
    do_mint(&mut c, &src, 10).unwrap();
    let metas = common::burn_tokens_metas(
        &mint,
        &src,
        &c.fx.pda1,
        &other_pda5,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::burn_tokens_ix(metas, 1);
    assert!(run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]).is_err());
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_fake_token_program() {
    // Token-2022 slot holds another key: IncorrectProgramId.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let mut metas = std_burn_metas(&c, &src);
    metas[6] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let i = common::burn_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::IncorrectProgramId,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_pda1_lookalike() {
    // Program-owned copy of PDA-1 at an arbitrary address: InvalidSeeds.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let p1 = c.fx.pda1;
    let look = common::seed_lookalike_mint_state(&mut c.svm, &p1);
    let metas = common::burn_tokens_metas(
        &c.fx.mint,
        &src,
        &look,
        &c.fx.pda5,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::burn_tokens_ix(metas, 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

#[test]
fn adv_burn_source_wrong_owner() {
    // Source re-owned by a foreign program: InvalidAccountOwner.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    set_owner(&mut c.svm, &src, Pubkey::new_unique());
    let i = common::burn_tokens_ix(std_burn_metas(&c, &src), 1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidAccountOwner,
    );
    assert_eq!(supply(&c.svm, &c.fx.mint), 10);
}

#[test]
fn adv_burn_u64_max_exceeds_balance() {
    // u64::MAX against a balance of 10: fails (error not settled), balance and supply unchanged.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let i = common::burn_tokens_ix(std_burn_metas(&c, &src), u64::MAX);
    assert!(run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]).is_err());
    assert_eq!(balance(&c.svm, &src), 10);
    assert_eq!(supply(&c.svm, &c.fx.mint), 10);
}

#[test]
fn adv_burn_exact_balance() {
    // Burning exactly the full balance succeeds and leaves zero.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 77);
    let i = common::burn_tokens_ix(std_burn_metas(&c, &src), 77);
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]).unwrap();
    assert_eq!(balance(&c.svm, &src), 0);
    assert_eq!(supply(&c.svm, &c.fx.mint), 0);
}

#[test]
fn adv_burn_trailing_byte() {
    // One trailing byte: InvalidInstructionData.
    let (mut c, _) = tctx(false);
    let src = redemption_account(&mut c, 10);
    let mut i = common::burn_tokens_ix(std_burn_metas(&c, &src), 1);
    i.data.push(0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(balance(&c.svm, &src), 10);
}

// ================================================================ I-4 pause / I-5 resume

#[test]
fn adv_pause_by_each_role() {
    // Each of issuer, operator, reserve can pause alone.
    for who in 0..3 {
        let mut c = common::setup(false);
        let k = match who {
            0 => c.issuer.insecure_clone(),
            1 => c.operator.insecure_clone(),
            _ => c.reserve.insecure_clone(),
        };
        let i = common::pause_ix(&c.mint, &c.pda1, &k.pubkey(), true);
        run(&mut c.svm, &c.payer, i, &[&k]).unwrap();
        assert!(state(&c).pause_active, "role {who}");
    }
}

#[test]
fn adv_pause_already_paused_succeeds() {
    // Pausing an already-paused mint succeeds and it stays paused.
    let mut c = common::setup(true);
    let i = common::pause_ix(&c.mint, &c.pda1, &c.operator.pubkey(), true);
    run(&mut c.svm, &c.payer, i, &[&c.operator]).unwrap();
    assert!(state(&c).pause_active);
}

#[test]
fn adv_pause_stranger_refused() {
    // Unrelated signer: 6001, not paused.
    let mut c = common::setup(false);
    let s = Keypair::new();
    let i = common::pause_ix(&c.mint, &c.pda1, &s.pubkey(), true);
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&s]), E_UNAUTHORIZED);
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_payer_as_authority_refused() {
    // Fee payer in the authority slot: 6001.
    let mut c = common::setup(false);
    let i = common::pause_ix(&c.mint, &c.pda1, &c.payer.pubkey(), true);
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[]), E_UNAUTHORIZED);
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_authority_not_signer() {
    // Issuer key present but not signing: MissingRequiredSignature.
    let mut c = common::setup(false);
    let i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), false);
    expect(
        run(&mut c.svm, &c.payer, i, &[]),
        InstructionError::MissingRequiredSignature,
    );
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_pda1_not_writable() {
    // PDA-1 read-only: Immutable.
    let mut c = common::setup(false);
    let mut i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    i.accounts[1] = AccountMeta::new_readonly(c.pda1, false);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::Immutable,
    );
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_pda1_wrong_owner() {
    // PDA-1 owned by a foreign program: InvalidAccountOwner.
    let mut c = common::setup(false);
    let p = c.pda1;
    set_owner(&mut c.svm, &p, Pubkey::new_unique());
    let i = common::pause_ix(&c.mint, &p, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidAccountOwner,
    );
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_pda1_lookalike() {
    // Program-owned copy of PDA-1 at an arbitrary address: InvalidSeeds; lookalike and real PDA-1 unchanged.
    let mut c = common::setup(false);
    let look = common::seed_lookalike_mint_state(&mut c.svm, &c.pda1);
    let before = snapshot(&c.svm, &[look, c.pda1]);
    let i = common::pause_ix(&c.mint, &look, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[look, c.pda1]), before);
}

#[test]
fn adv_pause_noncanonical_pda1() {
    // PDA-1 at a non-canonical bump: InvalidSeeds.
    let mut c = common::setup(false);
    let (m, p) = (c.mint, c.pda1);
    let bad = seed_noncanonical_mint_state(&mut c.svm, &m, &p);
    let i = common::pause_ix(&m, &bad, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidSeeds,
    );
    assert!(!common::read_mint_state(&c.svm, &bad).pause_active);
}

#[test]
fn adv_pause_pda1_of_other_mint() {
    // PDA-1 of another mint (same signers) passed with this mint: InvalidSeeds, neither paused.
    let mut c = common::setup(false);
    let other_mint = Pubkey::new_unique();
    let other = common::seed_mint_state(
        &mut c.svm,
        &other_mint,
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        false,
    );
    let i = common::pause_ix(&c.mint, &other, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidSeeds,
    );
    assert!(!common::read_mint_state(&c.svm, &other).pause_active);
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_pda1_in_mint_slot() {
    // PDA-1 passed in both the mint and PDA-1 slots: InvalidSeeds.
    let mut c = common::setup(false);
    let i = common::pause_ix(&c.pda1, &c.pda1, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidSeeds,
    );
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_pda1_malformed() {
    // Canonical PDA-1, program-owned, zeroed data: InvalidAccountData, data unchanged.
    let mut c = common::setup(false);
    let mut acct = c.svm.get_account(&c.pda1).unwrap();
    acct.data = vec![0u8; MINT_STATE_LEN];
    c.svm.set_account(c.pda1, acct).unwrap();
    let before = snapshot(&c.svm, &[c.pda1]);
    let i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidAccountData,
    );
    assert_eq!(snapshot(&c.svm, &[c.pda1]), before);
}

#[test]
fn adv_pause_pda1_short_data() {
    // Canonical PDA-1 with a valid record truncated by one byte: InvalidAccountData.
    let mut c = common::setup(false);
    let mut acct = c.svm.get_account(&c.pda1).unwrap();
    acct.data.pop();
    c.svm.set_account(c.pda1, acct).unwrap();
    let i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidAccountData,
    );
}

#[test]
fn adv_pause_too_few_accounts() {
    // Authority omitted: NotEnoughAccountKeys.
    let mut c = common::setup(false);
    let mut i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    i.accounts.pop();
    expect_not_enough_keys(run(&mut c.svm, &c.payer, i, &[]));
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_pause_trailing_byte() {
    // One byte after the no-arg discriminator: InvalidInstructionData.
    let mut c = common::setup(false);
    let mut i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    i.data.push(0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::InvalidInstructionData,
    );
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_resume_with_both() {
    // Issuer + reserve resume a paused mint.
    let mut c = common::setup(true);
    let i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.reserve.pubkey());
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]).unwrap();
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_resume_reserve_not_signer() {
    // Reserve present but not signing: MissingRequiredSignature, stays paused.
    let mut c = common::setup(true);
    let mut i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.reserve.pubkey());
    i.accounts[3] = AccountMeta::new_readonly(c.reserve.pubkey(), false);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::MissingRequiredSignature,
    );
    assert!(state(&c).pause_active);
}

#[test]
fn adv_resume_issuer_not_signer() {
    // Issuer present but not signing: MissingRequiredSignature, stays paused.
    let mut c = common::setup(true);
    let mut i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.reserve.pubkey());
    i.accounts[2] = AccountMeta::new_readonly(c.issuer.pubkey(), false);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::MissingRequiredSignature,
    );
    assert!(state(&c).pause_active);
}

#[test]
fn adv_resume_operator_in_reserve_slot() {
    // Issuer + operator (operator in reserve slot): 6001, stays paused.
    let mut c = common::setup(true);
    let i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.operator.pubkey());
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        E_UNAUTHORIZED,
    );
    assert!(state(&c).pause_active);
}

#[test]
fn adv_resume_slots_swapped() {
    // Reserve in issuer slot and issuer in reserve slot: 6001, stays paused.
    let mut c = common::setup(true);
    let i = common::resume_ix(&c.mint, &c.pda1, &c.reserve.pubkey(), &c.issuer.pubkey());
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert!(state(&c).pause_active);
}

#[test]
fn adv_resume_issuer_in_both_slots() {
    // Issuer key in both slots: 6001, stays paused.
    let mut c = common::setup(true);
    let i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.issuer.pubkey());
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_UNAUTHORIZED);
    assert!(state(&c).pause_active);
}

#[test]
fn adv_resume_pda1_lookalike() {
    // Lookalike PDA-1: InvalidSeeds, real PDA-1 stays paused.
    let mut c = common::setup(true);
    let look = common::seed_lookalike_mint_state(&mut c.svm, &c.pda1);
    let i = common::resume_ix(&c.mint, &look, &c.issuer.pubkey(), &c.reserve.pubkey());
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert!(state(&c).pause_active);
    assert!(common::read_mint_state(&c.svm, &look).pause_active);
}

#[test]
fn adv_resume_trailing_byte() {
    // One byte after the no-arg discriminator: InvalidInstructionData.
    let mut c = common::setup(true);
    let mut i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.reserve.pubkey());
    i.data.push(1);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert!(state(&c).pause_active);
}

// ================================================================ I-6 update_transfer_fee

#[test]
fn adv_fee_at_ceiling_accepted() {
    // bps and maximum exactly at the ceilings: accepted; mint fee and stored minimum updated.
    let (mut c, _) = tctx(false);
    do_fee(
        &mut c,
        common::DEFAULT_FEE_CEILING_BASIS_POINTS,
        common::DEFAULT_FEE_CEILING_BASE_UNITS,
        500,
    )
    .unwrap();
    assert_eq!(
        newer_fee(&c.svm, &c.fx.mint),
        (
            common::DEFAULT_FEE_CEILING_BASIS_POINTS,
            common::DEFAULT_FEE_CEILING_BASE_UNITS
        )
    );
    assert_eq!(common::read_mint_state(&c.svm, &c.fx.pda1).minimum_fee, 500);
}

#[test]
fn adv_fee_bps_one_above_ceiling() {
    // bps = ceiling + 1: 6008, mint and PDA-1 unchanged.
    let (mut c, _) = tctx(false);
    let keys = [c.fx.mint, c.fx.pda1];
    let before = snapshot(&c.svm, &keys);
    common::assert_custom(
        do_fee(&mut c, common::DEFAULT_FEE_CEILING_BASIS_POINTS + 1, 10, 0),
        E_FEE_ABOVE,
    );
    assert_eq!(snapshot(&c.svm, &keys), before);
}

#[test]
fn adv_fee_max_one_above_ceiling() {
    // maximum = ceiling + 1: 6009, mint and PDA-1 unchanged.
    let (mut c, _) = tctx(false);
    let keys = [c.fx.mint, c.fx.pda1];
    let before = snapshot(&c.svm, &keys);
    common::assert_custom(
        do_fee(&mut c, 10, common::DEFAULT_FEE_CEILING_BASE_UNITS + 1, 0),
        E_MAX_FEE_ABOVE,
    );
    assert_eq!(snapshot(&c.svm, &keys), before);
}

#[test]
fn adv_fee_max_u64_max() {
    // maximum = u64::MAX under the default ceiling: 6009.
    let (mut c, _) = tctx(false);
    let keys = [c.fx.mint, c.fx.pda1];
    let before = snapshot(&c.svm, &keys);
    common::assert_custom(do_fee(&mut c, 10, u64::MAX, 0), E_MAX_FEE_ABOVE);
    assert_eq!(snapshot(&c.svm, &keys), before);
}

#[test]
fn adv_fee_min_above_max() {
    // minimum = maximum + 1: 6002, unchanged.
    let (mut c, _) = tctx(false);
    let keys = [c.fx.mint, c.fx.pda1];
    let before = snapshot(&c.svm, &keys);
    common::assert_custom(do_fee(&mut c, 10, 100, 101), E_FEE_BOUNDS);
    assert_eq!(snapshot(&c.svm, &keys), before);
}

#[test]
fn adv_fee_min_equals_max_accepted() {
    // minimum == maximum: accepted, minimum stored.
    let (mut c, _) = tctx(false);
    do_fee(&mut c, 10, 100, 100).unwrap();
    assert_eq!(common::read_mint_state(&c.svm, &c.fx.pda1).minimum_fee, 100);
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (10, 100));
}

#[test]
fn adv_fee_all_zero_accepted() {
    // bps 0, max 0, min 0: accepted.
    let (mut c, _) = tctx(false);
    do_fee(&mut c, 0, 0, 0).unwrap();
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
    assert_eq!(common::read_mint_state(&c.svm, &c.fx.pda1).minimum_fee, 0);
}

#[test]
fn adv_fee_ceiling_10000_and_u64_max_accepted() {
    // PDA-1 ceilings 10000 / u64::MAX: bps 10000 with maximum u64::MAX accepted.
    let (mut c, _) = tctx(false);
    let (i, o, r, m) = (
        c.issuer.pubkey(),
        c.operator.pubkey(),
        c.reserve.pubkey(),
        c.fx.mint,
    );
    common::seed_mint_state_with_ceilings(&mut c.svm, &m, &i, &o, &r, false, 10_000, u64::MAX);
    do_fee(&mut c, 10_000, u64::MAX, 0).unwrap();
    assert_eq!(newer_fee(&c.svm, &m), (10_000, u64::MAX));
}

#[test]
fn adv_fee_zero_ceilings_refuse_one() {
    // PDA-1 ceilings 0 / 0: bps 1 gives 6008; bps 0 with maximum 1 gives 6009; zeros accepted.
    let (mut c, _) = tctx(false);
    let (i, o, r, m) = (
        c.issuer.pubkey(),
        c.operator.pubkey(),
        c.reserve.pubkey(),
        c.fx.mint,
    );
    common::seed_mint_state_with_ceilings(&mut c.svm, &m, &i, &o, &r, false, 0, 0);
    common::assert_custom(do_fee(&mut c, 1, 0, 0), E_FEE_ABOVE);
    common::assert_custom(do_fee(&mut c, 0, 1, 0), E_MAX_FEE_ABOVE);
    do_fee(&mut c, 0, 0, 0).unwrap();
}

#[test]
fn adv_fee_operator_not_signer() {
    // Operator present but not signing: MissingRequiredSignature.
    let (mut c, _) = tctx(false);
    let mut metas = std_fee_metas(&c);
    metas[4] = AccountMeta::new_readonly(c.operator.pubkey(), false);
    let i = common::update_transfer_fee_ix(metas, 10, 10, 0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

#[test]
fn adv_fee_reserve_in_operator_slot() {
    // Issuer + reserve (reserve in operator slot): 6001.
    let (mut c, _) = tctx(false);
    let metas = common::update_transfer_fee_metas(
        &c.fx.mint,
        &c.fx.pda3,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
    );
    let i = common::update_transfer_fee_ix(metas, 10, 10, 0);
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

#[test]
fn adv_fee_operator_in_both_slots() {
    // Operator key in both issuer and operator slots: 6001.
    let (mut c, _) = tctx(false);
    let metas = common::update_transfer_fee_metas(
        &c.fx.mint,
        &c.fx.pda3,
        &c.fx.pda1,
        &c.operator.pubkey(),
        &c.operator.pubkey(),
    );
    let i = common::update_transfer_fee_ix(metas, 10, 10, 0);
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.operator]), E_UNAUTHORIZED);
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

#[test]
fn adv_fee_noncanonical_pda3() {
    // PDA-3 at a non-canonical bump: InvalidSeeds.
    let (mut c, _) = tctx(false);
    let (bad, _) = noncanonical_pda(pda::FEE_AUTHORITY_SEED, &c.fx.mint);
    let metas = common::update_transfer_fee_metas(
        &c.fx.mint,
        &bad,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
    );
    let i = common::update_transfer_fee_ix(metas, 10, 10, 0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

#[test]
fn adv_fee_pda3_of_other_mint() {
    // PDA-3 of another mint: InvalidSeeds.
    let (mut c, _) = tctx(false);
    let (bad, _) = pda::find_fee_authority_address(&Pubkey::new_unique(), &ddcp_ddc::id());
    let metas = common::update_transfer_fee_metas(
        &c.fx.mint,
        &bad,
        &c.fx.pda1,
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
    );
    let i = common::update_transfer_fee_ix(metas, 10, 10, 0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

#[test]
fn adv_fee_pda1_not_writable() {
    // PDA-1 read-only: Immutable.
    let (mut c, _) = tctx(false);
    let mut metas = std_fee_metas(&c);
    metas[2] = AccountMeta::new_readonly(c.fx.pda1, false);
    let i = common::update_transfer_fee_ix(metas, 10, 10, 5);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        InstructionError::Immutable,
    );
    assert_eq!(common::read_mint_state(&c.svm, &c.fx.pda1).minimum_fee, 0);
}

#[test]
fn adv_fee_mint_not_writable() {
    // Mint read-only: Immutable.
    let (mut c, _) = tctx(false);
    let mut metas = std_fee_metas(&c);
    metas[0] = AccountMeta::new_readonly(c.fx.mint, false);
    let i = common::update_transfer_fee_ix(metas, 10, 10, 5);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        InstructionError::Immutable,
    );
    assert_eq!(common::read_mint_state(&c.svm, &c.fx.pda1).minimum_fee, 0);
}

#[test]
fn adv_fee_fake_token_program() {
    // Token-2022 slot holds another key: IncorrectProgramId.
    let (mut c, _) = tctx(false);
    let mut metas = std_fee_metas(&c);
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let i = common::update_transfer_fee_ix(metas, 10, 10, 5);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        InstructionError::IncorrectProgramId,
    );
    assert_eq!(common::read_mint_state(&c.svm, &c.fx.pda1).minimum_fee, 0);
}

#[test]
fn adv_fee_pda1_of_other_mint() {
    // PDA-1 of another mint whose ceilings are higher: InvalidSeeds, nothing changed.
    let (mut c, _) = tctx(false);
    let other_mint = Pubkey::new_unique();
    let (i, o, r) = (c.issuer.pubkey(), c.operator.pubkey(), c.reserve.pubkey());
    let other = common::seed_mint_state_with_ceilings(
        &mut c.svm,
        &other_mint,
        &i,
        &o,
        &r,
        false,
        10_000,
        u64::MAX,
    );
    let metas = common::update_transfer_fee_metas(&c.fx.mint, &c.fx.pda3, &other, &i, &o);
    let ix_ = common::update_transfer_fee_ix(metas, 5_000, 5_000_000, 0);
    expect(
        run(&mut c.svm, &c.payer, ix_, &[&c.issuer, &c.operator]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

#[test]
fn adv_fee_trailing_byte() {
    // One trailing byte: InvalidInstructionData.
    let (mut c, _) = tctx(false);
    let mut i = common::update_transfer_fee_ix(std_fee_metas(&c), 10, 10, 0);
    i.data.push(0);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.operator]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(newer_fee(&c.svm, &c.fx.mint), (0, 0));
}

// ================================================================ I-7 publish_attestation

fn pctx(paused: bool) -> (Ctx, Pubkey) {
    let mut c = common::setup(paused);
    let m = c.mint;
    let pda2 = common::seed_attestation_zeroed(&mut c.svm, &m);
    (c, pda2)
}

#[test]
fn adv_publish_happy_path_and_overwrite() {
    // Reserve publishes; a second publish overwrites amount, attestor and URI.
    let (mut c, pda2) = pctx(false);
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(500, &[b'a'; 40]),
    );
    run(&mut c.svm, &c.payer, i, &[&c.reserve]).unwrap();
    let rec = common::read_attestation(&c.svm, &pda2);
    assert_eq!(rec.attested_reserve_amount, 500);
    assert_eq!(rec.attestor_pubkey, c.reserve.pubkey());
    assert_eq!(&rec.attestation_uri[..40], &[b'a'; 40][..]);

    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(7, b"b"),
    );
    run(&mut c.svm, &c.payer, i, &[&c.reserve]).unwrap();
    let rec = common::read_attestation(&c.svm, &pda2);
    assert_eq!(rec.attested_reserve_amount, 7);
    assert_eq!(rec.attestation_uri[0], b'b');
    assert!(rec.attestation_uri[1..].iter().all(|b| *b == 0));
}

#[test]
fn adv_publish_uri_exactly_128() {
    // 128-byte URI and u64::MAX amount: accepted.
    let (mut c, pda2) = pctx(false);
    let uri = [b'x'; 128];
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(u64::MAX, &uri),
    );
    run(&mut c.svm, &c.payer, i, &[&c.reserve]).unwrap();
    let rec = common::read_attestation(&c.svm, &pda2);
    assert_eq!(rec.attestation_uri, uri);
    assert_eq!(rec.attested_reserve_amount, u64::MAX);
}

#[test]
fn adv_publish_uri_129_refused() {
    // 129-byte URI: 6003, PDA-2 unchanged.
    let (mut c, pda2) = pctx(false);
    let before = snapshot(&c.svm, &[pda2]);
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, &[b'x'; 129]),
    );
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.reserve]), E_URI);
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_issuer_refused() {
    // Issuer in the reserve slot: 6001, PDA-2 unchanged.
    let (mut c, pda2) = pctx(false);
    let before = snapshot(&c.svm, &[pda2]);
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.issuer.pubkey(),
        publish_args(1, b"u"),
    );
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_UNAUTHORIZED);
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_reserve_not_signer() {
    // Reserve present but not signing: MissingRequiredSignature.
    let (mut c, pda2) = pctx(false);
    let before = snapshot(&c.svm, &[pda2]);
    let mut i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    i.accounts[3] = AccountMeta::new_readonly(c.reserve.pubkey(), false);
    expect(
        run(&mut c.svm, &c.payer, i, &[]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_pda2_lookalike() {
    // Program-owned copy of PDA-2 at an arbitrary address: InvalidSeeds.
    let (mut c, pda2) = pctx(false);
    let look = Pubkey::new_unique();
    copy_account_to(&mut c.svm, &pda2, look, None);
    let before = snapshot(&c.svm, &[look, pda2]);
    let i = common::publish_ix(
        &c.mint,
        &look,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[look, pda2]), before);
}

#[test]
fn adv_publish_pda2_of_other_mint() {
    // Seeded PDA-2 of another mint: InvalidSeeds.
    let (mut c, pda2) = pctx(false);
    let other = common::seed_attestation_zeroed(&mut c.svm, &Pubkey::new_unique());
    let before = snapshot(&c.svm, &[other, pda2]);
    let i = common::publish_ix(
        &c.mint,
        &other,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[other, pda2]), before);
}

#[test]
fn adv_publish_pda2_wrong_owner() {
    // PDA-2 owned by a foreign program: InvalidAccountOwner.
    let (mut c, pda2) = pctx(false);
    set_owner(&mut c.svm, &pda2, Pubkey::new_unique());
    let before = snapshot(&c.svm, &[pda2]);
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidAccountOwner,
    );
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_pda2_not_writable() {
    // PDA-2 read-only: Immutable.
    let (mut c, pda2) = pctx(false);
    let before = snapshot(&c.svm, &[pda2]);
    let mut i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    i.accounts[1] = AccountMeta::new_readonly(pda2, false);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::Immutable,
    );
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_pda1_in_pda2_slot() {
    // PDA-1 passed in both the PDA-2 and PDA-1 slots: InvalidSeeds, PDA-1 unchanged.
    let (mut c, _) = pctx(false);
    let before = snapshot(&c.svm, &[c.pda1]);
    let i = common::publish_ix(
        &c.mint,
        &c.pda1,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[c.pda1]), before);
}

#[test]
fn adv_publish_pda1_of_other_mint() {
    // PDA-1 of another mint naming the same reserve: InvalidSeeds.
    let (mut c, pda2) = pctx(false);
    let other = common::seed_mint_state(
        &mut c.svm,
        &Pubkey::new_unique(),
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        false,
    );
    let before = snapshot(&c.svm, &[pda2]);
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &other,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_trailing_byte() {
    // One trailing byte after the URI: InvalidInstructionData.
    let (mut c, pda2) = pctx(false);
    let before = snapshot(&c.svm, &[pda2]);
    let mut data = publish_args(1, b"u");
    data.push(0);
    let i = common::publish_ix(&c.mint, &pda2, &c.pda1, &c.reserve.pubkey(), data);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_uri_length_prefix_overstated() {
    // URI length prefix 10 with only 3 bytes following: InvalidInstructionData.
    let (mut c, pda2) = pctx(false);
    let before = snapshot(&c.svm, &[pda2]);
    let mut data = 1u64.to_le_bytes().to_vec();
    data.extend_from_slice(&10u32.to_le_bytes());
    data.extend_from_slice(b"abc");
    let i = common::publish_ix(&c.mint, &pda2, &c.pda1, &c.reserve.pubkey(), data);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(snapshot(&c.svm, &[pda2]), before);
}

#[test]
fn adv_publish_after_reserve_rotation_old_key_refused() {
    // Reserve rotated: old reserve gets 6001; new reserve publishes and is recorded as attestor.
    let (mut c, pda2) = pctx(false);
    let new_reserve = Keypair::new();
    let r = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(2, new_reserve.pubkey()),
    );
    run(&mut c.svm, &c.payer, r, &[&c.operator, &c.reserve]).unwrap();
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &c.reserve.pubkey(),
        publish_args(1, b"u"),
    );
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.reserve]), E_UNAUTHORIZED);
    let i = common::publish_ix(
        &c.mint,
        &pda2,
        &c.pda1,
        &new_reserve.pubkey(),
        publish_args(2, b"v"),
    );
    run(&mut c.svm, &c.payer, i, &[&new_reserve]).unwrap();
    assert_eq!(
        common::read_attestation(&c.svm, &pda2).attestor_pubkey,
        new_reserve.pubkey()
    );
}

// ================================================================ I-8 rotate_signer

fn do_rotate(c: &mut Ctx, role: u8, new_pubkey: Pubkey) -> Result<(), InstructionError> {
    let i = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(role, new_pubkey),
    );
    run(&mut c.svm, &c.payer, i, &[&c.operator, &c.reserve])
}

#[test]
fn adv_rotate_issuer_old_key_refused() {
    // Issuer rotated: old issuer cannot pause (6001); new issuer can.
    let mut c = common::setup(false);
    let new_issuer = Keypair::new();
    do_rotate(&mut c, 0, new_issuer.pubkey()).unwrap();
    assert_eq!(state(&c).issuer_authority, new_issuer.pubkey());
    let i = common::pause_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), true);
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.issuer]), E_UNAUTHORIZED);
    assert!(!state(&c).pause_active);
    let i = common::pause_ix(&c.mint, &c.pda1, &new_issuer.pubkey(), true);
    run(&mut c.svm, &c.payer, i, &[&new_issuer]).unwrap();
    assert!(state(&c).pause_active);
}

#[test]
fn adv_rotate_operator_old_key_refused() {
    // Operator rotated: old operator + reserve rotate gets 6001; new operator + reserve succeeds.
    let mut c = common::setup(false);
    let new_operator = Keypair::new();
    do_rotate(&mut c, 1, new_operator.pubkey()).unwrap();
    assert_eq!(state(&c).operator_authority, new_operator.pubkey());
    let before = state(&c);
    common::assert_custom(do_rotate(&mut c, 0, Pubkey::new_unique()), E_UNAUTHORIZED);
    assert_eq!(state(&c), before);
    let k = Pubkey::new_unique();
    let i = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &new_operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, k),
    );
    run(&mut c.svm, &c.payer, i, &[&new_operator, &c.reserve]).unwrap();
    assert_eq!(state(&c).issuer_authority, k);
}

#[test]
fn adv_rotate_reserve_old_key_cannot_resume() {
    // Reserve rotated on a paused mint: issuer + old reserve resume gets 6001; issuer + new reserve succeeds.
    let mut c = common::setup(true);
    let new_reserve = Keypair::new();
    do_rotate(&mut c, 2, new_reserve.pubkey()).unwrap();
    let i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &c.reserve.pubkey());
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert!(state(&c).pause_active);
    let i = common::resume_ix(&c.mint, &c.pda1, &c.issuer.pubkey(), &new_reserve.pubkey());
    run(&mut c.svm, &c.payer, i, &[&c.issuer, &new_reserve]).unwrap();
    assert!(!state(&c).pause_active);
}

#[test]
fn adv_rotate_while_paused() {
    // Rotation while paused succeeds and leaves the mint paused; other fields unchanged.
    let mut c = common::setup(true);
    let before = state(&c);
    let k = Pubkey::new_unique();
    do_rotate(&mut c, 0, k).unwrap();
    let after = state(&c);
    assert!(after.pause_active);
    assert_eq!(
        after,
        MintState {
            issuer_authority: k,
            ..before
        }
    );
}

#[test]
fn adv_rotate_to_current_key() {
    // Each role rotated to its own current key: accepted, state unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let keys = [c.issuer.pubkey(), c.operator.pubkey(), c.reserve.pubkey()];
    for (role, k) in keys.iter().enumerate() {
        do_rotate(&mut c, role as u8, *k).unwrap();
    }
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_issuer_to_operator_key() {
    // Issuer set to operator's key: 6012, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let k = c.operator.pubkey();
    common::assert_custom(do_rotate(&mut c, 0, k), E_NOT_DISTINCT);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_reserve_to_issuer_key() {
    // Reserve set to issuer's key: 6012, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let k = c.issuer.pubkey();
    common::assert_custom(do_rotate(&mut c, 2, k), E_NOT_DISTINCT);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_operator_to_reserve_key() {
    // Operator set to reserve's key: 6012, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let k = c.reserve.pubkey();
    common::assert_custom(do_rotate(&mut c, 1, k), E_NOT_DISTINCT);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_default_pubkey() {
    // Default new_pubkey for role 0: 6004, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    common::assert_custom(do_rotate(&mut c, 0, Pubkey::default()), E_PUBKEY);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_default_pubkey_checked_before_role() {
    // Default new_pubkey with role 7: 6004 (pubkey check precedes role check).
    let mut c = common::setup(false);
    let before = state(&c);
    common::assert_custom(do_rotate(&mut c, 7, Pubkey::default()), E_PUBKEY);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_role_3() {
    // Role 3 with a valid key: 6005, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    common::assert_custom(do_rotate(&mut c, 3, Pubkey::new_unique()), E_ROLE);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_role_255() {
    // Role 255 with a valid key: 6005, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    common::assert_custom(do_rotate(&mut c, 255, Pubkey::new_unique()), E_ROLE);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_issuer_in_operator_slot() {
    // Issuer + reserve (issuer in operator slot): 6001, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let i = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &c.issuer.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, Pubkey::new_unique()),
    );
    common::assert_custom(
        run(&mut c.svm, &c.payer, i, &[&c.issuer, &c.reserve]),
        E_UNAUTHORIZED,
    );
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_operator_in_both_slots() {
    // Operator key in both operator and reserve slots: 6001, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let i = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &c.operator.pubkey(),
        &c.operator.pubkey(),
        rotate_args(2, Pubkey::new_unique()),
    );
    common::assert_custom(run(&mut c.svm, &c.payer, i, &[&c.operator]), E_UNAUTHORIZED);
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_reserve_not_signer() {
    // Reserve present but not signing: MissingRequiredSignature, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let mut i = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, Pubkey::new_unique()),
    );
    i.accounts[3] = AccountMeta::new_readonly(c.reserve.pubkey(), false);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.operator]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_operator_not_signer() {
    // Operator present but not signing: MissingRequiredSignature, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let mut i = common::rotate_ix(
        &c.mint,
        &c.pda1,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, Pubkey::new_unique()),
    );
    i.accounts[2] = AccountMeta::new_readonly(c.operator.pubkey(), false);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.reserve]),
        InstructionError::MissingRequiredSignature,
    );
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_noncanonical_pda1() {
    // PDA-1 at a non-canonical bump: InvalidSeeds, both records unchanged.
    let mut c = common::setup(false);
    let (m, p) = (c.mint, c.pda1);
    let bad = seed_noncanonical_mint_state(&mut c.svm, &m, &p);
    let before = snapshot(&c.svm, &[bad, p]);
    let i = common::rotate_ix(
        &m,
        &bad,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, Pubkey::new_unique()),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.operator, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[bad, p]), before);
}

#[test]
fn adv_rotate_pda1_wrong_owner() {
    // PDA-1 owned by a foreign program: InvalidAccountOwner.
    let mut c = common::setup(false);
    let p = c.pda1;
    set_owner(&mut c.svm, &p, Pubkey::new_unique());
    let before = snapshot(&c.svm, &[p]);
    expect(
        do_rotate(&mut c, 0, Pubkey::new_unique()),
        InstructionError::InvalidAccountOwner,
    );
    assert_eq!(snapshot(&c.svm, &[p]), before);
}

#[test]
fn adv_rotate_pda1_of_other_mint() {
    // PDA-1 of another mint with the same signers: InvalidSeeds, both unchanged.
    let mut c = common::setup(false);
    let other = common::seed_mint_state(
        &mut c.svm,
        &Pubkey::new_unique(),
        &c.issuer.pubkey(),
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        false,
    );
    let before = snapshot(&c.svm, &[other, c.pda1]);
    let i = common::rotate_ix(
        &c.mint,
        &other,
        &c.operator.pubkey(),
        &c.reserve.pubkey(),
        rotate_args(0, Pubkey::new_unique()),
    );
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.operator, &c.reserve]),
        InstructionError::InvalidSeeds,
    );
    assert_eq!(snapshot(&c.svm, &[other, c.pda1]), before);
}

#[test]
fn adv_rotate_trailing_byte() {
    // One trailing byte: InvalidInstructionData, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let mut data = rotate_args(0, Pubkey::new_unique());
    data.push(0);
    let i = common::rotate_ix(&c.mint, &c.pda1, &c.operator.pubkey(), &c.reserve.pubkey(), data);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.operator, &c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_short_args() {
    // Pubkey truncated by one byte: InvalidInstructionData, unchanged.
    let mut c = common::setup(false);
    let before = state(&c);
    let mut data = rotate_args(0, Pubkey::new_unique());
    data.pop();
    let i = common::rotate_ix(&c.mint, &c.pda1, &c.operator.pubkey(), &c.reserve.pubkey(), data);
    expect(
        run(&mut c.svm, &c.payer, i, &[&c.operator, &c.reserve]),
        InstructionError::InvalidInstructionData,
    );
    assert_eq!(state(&c), before);
}

#[test]
fn adv_rotate_sequential_swap_refused_midway() {
    // Rotating issuer to reserve's key midway through a swap: 6012; a fresh key then succeeds.
    let mut c = common::setup(false);
    let r = c.reserve.pubkey();
    common::assert_custom(do_rotate(&mut c, 0, r), E_NOT_DISTINCT);
    let k = Pubkey::new_unique();
    do_rotate(&mut c, 0, k).unwrap();
    let st = state(&c);
    assert_eq!(st.issuer_authority, k);
    assert_eq!(st.reserve_authority, r);
}
