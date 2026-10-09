//! I-1 initialize_mint integration suite (the five-extension genesis incl.
//! on-mint TokenMetadata + PDA-1 + PDA-2, plus the metadata mutability
//! pins). Positive path
//! starts from an UNALLOCATED fresh mint keypair and exercises the real
//! handler end to end — deliberately NOT `create_three_extension_mint`, which
//! pre-does exactly the work I-1 must perform itself. Negatives follow the
//! established validation ladder; PDA-2's byte oracle is the "zeroed"
//! convention (same construction as `seed_attestation_zeroed`).

mod common;

use common::token;
use common::*;
use ddcp_ddc::instruction as ix;
use ddcp_ddc::pda;
use ddcp_ddc::state::{AttestationRecord, MintState, ATTESTATION_RECORD_LEN};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program::instruction::{AccountMeta, InstructionError};
use solana_program::program_option::COption;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_zk_sdk_pod::encryption::elgamal::PodElGamalPubkey;
use spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferMint;
use spl_token_2022_interface::extension::confidential_transfer_fee::ConfidentialTransferFeeConfig;
use spl_token_2022_interface::extension::metadata_pointer::MetadataPointer;
use spl_token_2022_interface::extension::transfer_fee::TransferFeeConfig;
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022_interface::state::Mint;
use spl_token_metadata_interface::instruction::{
    update_authority as tm_update_authority, update_field as tm_update_field,
};
use spl_token_metadata_interface::state::{Field, TokenMetadata};

/// Pinned Token-2022 + the program under `ddcp_ddc::id()`, NO mint —
/// I-1 builds it. Returns the funded payer.
fn setup() -> (LiteSVM, Keypair) {
    let token::TokenCtx { mut svm, payer } = token::setup_token();
    svm.add_program_from_file(ddcp_ddc::id(), SO_PATH)
        .expect("missing target/deploy/ddcp_ddc.so — run `cargo build-sbf` in program/ before `cargo test`");
    (svm, payer)
}

struct I1 {
    mint_kp: Keypair,
    pda1: Pubkey,
    pda2: Pubkey,
    /// Account #7 (CONTENT authority) — account identity, not an arg.
    metadata_update_authority: Pubkey,
    args: ix::InitializeMintArgs,
}

fn i1_fixture(issuer: &Pubkey, operator: &Pubkey, reserve: &Pubkey) -> I1 {
    let mint_kp = Keypair::new();
    let program_id = ddcp_ddc::id();
    let (pda1, _) = pda::find_mint_state_address(&mint_kp.pubkey(), &program_id);
    let (pda2, _) = pda::find_attestation_address(&mint_kp.pubkey(), &program_id);
    let args = sample_initialize_mint_args(issuer, operator, reserve);
    I1 {
        mint_kp,
        pda1,
        pda2,
        metadata_update_authority: Pubkey::new_unique(),
        args,
    }
}

fn i1_default_fixture() -> I1 {
    i1_fixture(
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
    )
}

fn metas_for(f: &I1, payer: &Pubkey) -> Vec<AccountMeta> {
    initialize_mint_metas(
        &f.mint_kp.pubkey(),
        &f.pda1,
        &f.pda2,
        payer,
        &f.metadata_update_authority,
    )
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

#[test]
fn initialize_mint_builds_full_genesis_state() {
    let (mut svm, payer) = setup();
    let issuer = Pubkey::new_unique();
    let operator = Pubkey::new_unique();
    let reserve = Pubkey::new_unique();
    let f = i1_fixture(&issuer, &operator, &reserve);
    let program_id = ddcp_ddc::id();

    let ix1 = initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args);
    let msg = Message::new(&[ix1], Some(&payer.pubkey()));
    let tx = Transaction::new(&[&payer, &f.mint_kp], msg, svm.latest_blockhash());

    // Legacy wire size: 1-byte signature-count shortvec (2 sigs) + 64 per
    // signature + serialized message. Must fit the 1,232-byte packet limit.
    let wire_size = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
    assert!(
        wire_size <= 1232,
        "I-1 transaction exceeds the packet limit: {wire_size} bytes"
    );

    let meta = svm
        .send_transaction(tx)
        .map_err(|e| e.err)
        .expect("I-1 positive path must succeed");
    // Recorded into TEST_COVERAGE (compute-unit assessment).
    println!(
        "I-1 five-extension CU consumed: {} (tx wire size: {wire_size} bytes)",
        meta.compute_units_consumed
    );

    // Mint: base params — owner, decimals, authority PDA-1, freeze
    // None (hard constraint), zero supply.
    let acct = svm.get_account(&f.mint_kp.pubkey()).unwrap();
    assert_eq!(acct.owner, spl_token_2022_interface::id());
    // Five-extension final state: allocated at 548 (the four fixed
    // extensions), realloc'd to 677 by the TokenMetadata Initialize; funded
    // at allocation to exactly the 677-byte rent-exempt minimum (5,602,800
    // lamports).
    assert_eq!(acct.data.len(), 677);
    assert_eq!(acct.lamports, 5_602_800);
    assert_eq!(
        acct.lamports,
        svm.minimum_balance_for_rent_exemption(acct.data.len())
    );
    let st = StateWithExtensions::<Mint>::unpack(&acct.data).unwrap();
    assert_eq!(st.base.decimals, 6);
    assert_eq!(st.base.supply, 0);
    assert!(st.base.is_initialized);
    assert_eq!(st.base.mint_authority, COption::Some(f.pda1));
    assert_eq!(st.base.freeze_authority, COption::None);

    // Extension set is exactly the FIVE-extension genesis layout —
    // written out independently: deliberately neither GENESIS_MINT_EXTENSIONS
    // nor token::MINT_EXTENSIONS (asserting against the constant the handler
    // allocated from would pass vacuously).
    let mut ext = st.get_extension_types().unwrap();
    let mut expected = vec![
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::TransferFeeConfig,
        ExtensionType::ConfidentialTransferFeeConfig,
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
    ];
    ext.sort_unstable_by_key(|e| u16::from(*e));
    expected.sort_unstable_by_key(|e| u16::from(*e));
    assert_eq!(ext, expected);

    // ConfidentialTransfer init values, from args. The sample args
    // carry the conforming None: no authority, so no auditor
    // key can ever be set and auto-approval can never be switched off.
    let ct = st.get_extension::<ConfidentialTransferMint>().unwrap();
    assert_eq!(f.args.confidential_transfer_mint_authority, None);
    assert_eq!(
        Option::<Pubkey>::from(ct.authority),
        f.args.confidential_transfer_mint_authority
    );
    assert!(bool::from(ct.auto_approve_new_accounts));
    assert_eq!(
        Option::<PodElGamalPubkey>::from(ct.auditor_elgamal_pubkey),
        None
    );

    // TransferFeeConfig init values: PDA-3 fee authority, withdraw-withheld
    // authority from args, all-zero fee schedule.
    let (pda3, _) = pda::find_fee_authority_address(&f.mint_kp.pubkey(), &program_id);
    let tf = st.get_extension::<TransferFeeConfig>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(tf.transfer_fee_config_authority),
        Some(pda3)
    );
    assert_eq!(
        Option::<Pubkey>::from(tf.withdraw_withheld_authority),
        Some(f.args.withdraw_withheld_authority)
    );
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

    // ConfidentialTransferFeeConfig: authority + the NONZERO ElGamal key
    // round-tripped from args.
    let ctf = st.get_extension::<ConfidentialTransferFeeConfig>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(ctf.authority),
        Some(f.args.confidential_transfer_fee_authority)
    );
    assert_eq!(
        ctf.withdraw_withheld_authority_elgamal_pubkey,
        PodElGamalPubkey(f.args.withdraw_withheld_authority_elgamal_pubkey)
    );

    // MetadataPointer: authority = the arg (LOCATION role),
    // metadata_address = the mint itself.
    let mp = st.get_extension::<MetadataPointer>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(mp.authority),
        Some(f.args.metadata_pointer_authority)
    );
    assert_eq!(
        Option::<Pubkey>::from(mp.metadata_address),
        Some(f.mint_kp.pubkey())
    );

    // On-mint TokenMetadata: values round-trip from args; update
    // authority = account #7 (CONTENT role); self-referential mint field.
    let tm = st.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(tm.name, f.args.name);
    assert_eq!(tm.symbol, f.args.symbol);
    assert_eq!(tm.uri, f.args.uri);
    assert_eq!(
        Option::<Pubkey>::from(tm.update_authority),
        Some(f.metadata_update_authority)
    );
    assert_eq!(tm.mint, f.mint_kp.pubkey());
    assert!(tm.additional_metadata.is_empty());

    // PDA-1: program-owned, field-exact MintState, canonical bump.
    let pda1_acct = svm.get_account(&f.pda1).unwrap();
    assert_eq!(pda1_acct.owner, program_id);
    let (_, bump1) = pda::find_mint_state_address(&f.mint_kp.pubkey(), &program_id);
    assert_eq!(
        read_mint_state(&svm, &f.pda1),
        MintState {
            pause_active: false,
            issuer_authority: issuer,
            operator_authority: operator,
            reserve_authority: reserve,
            minimum_fee: 0,
            fee_ceiling_basis_points: DEFAULT_FEE_CEILING_BASIS_POINTS,
            fee_ceiling_base_units: DEFAULT_FEE_CEILING_BASE_UNITS,
            reserved: [0u8; 54],
            bump: bump1,
        }
    );

    // PDA-2: program-owned and BYTE-EQUAL to the zeroed
    // convention (same construction as seed_attestation_zeroed's).
    let pda2_acct = svm.get_account(&f.pda2).unwrap();
    assert_eq!(pda2_acct.owner, program_id);
    let (_, bump2) = pda::find_attestation_address(&f.mint_kp.pubkey(), &program_id);
    let mut expected = vec![0u8; ATTESTATION_RECORD_LEN];
    AttestationRecord {
        attested_reserve_amount: 0,
        attestation_timestamp: 0,
        attestor_pubkey: Pubkey::default(),
        attestation_uri: [0u8; 128],
        bump: bump2,
    }
    .save(&mut expected)
    .unwrap();
    assert_eq!(pda2_acct.data, expected);
}

/// The reference genesis refuses a ConfidentialTransferMint authority other
/// than none, before any account is created: a fork that keeps one changes
/// this check in its own code.
#[test]
fn initialize_mint_refuses_some_ct_authority_and_creates_nothing() {
    let (mut svm, payer) = setup();
    let mut f = i1_default_fixture();
    f.args.confidential_transfer_mint_authority = Some(Pubkey::new_unique());

    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args),
        &[&f.mint_kp],
    );
    assert_custom(res, 6011); // ConfidentialTransferAuthorityNotNone
    assert!(
        svm.get_account(&f.mint_kp.pubkey()).is_none(),
        "the mint must not exist after a refused genesis"
    );
    assert!(
        svm.get_account(&f.pda1).is_none(),
        "PDA-1 must not exist after a refused genesis"
    );
}

/// One genesis with two co-signer roles on one key: refused with
/// CoSignersNotDistinct before any account is created.
fn i1_refused_for_shared_key(issuer: &Pubkey, operator: &Pubkey, reserve: &Pubkey) {
    let (mut svm, payer) = setup();
    let f = i1_fixture(issuer, operator, reserve);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args),
        &[&f.mint_kp],
    );
    assert_custom(res, 6012); // CoSignersNotDistinct
    assert!(
        svm.get_account(&f.mint_kp.pubkey()).is_none(),
        "the mint must not exist after a refused genesis"
    );
    assert!(
        svm.get_account(&f.pda1).is_none(),
        "PDA-1 must not exist after a refused genesis"
    );
}

#[test]
fn shared_issuer_and_operator_key_is_refused_and_creates_nothing() {
    let (shared, other) = (Pubkey::new_unique(), Pubkey::new_unique());
    i1_refused_for_shared_key(&shared, &shared, &other);
}

#[test]
fn shared_issuer_and_reserve_key_is_refused_and_creates_nothing() {
    let (shared, other) = (Pubkey::new_unique(), Pubkey::new_unique());
    i1_refused_for_shared_key(&shared, &other, &shared);
}

#[test]
fn shared_operator_and_reserve_key_is_refused_and_creates_nothing() {
    let (shared, other) = (Pubkey::new_unique(), Pubkey::new_unique());
    i1_refused_for_shared_key(&other, &shared, &shared);
}

#[test]
fn wrong_system_program_fails_incorrect_program_id() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[4] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::IncorrectProgramId));
}

#[test]
fn wrong_token_program_fails_incorrect_program_id() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::IncorrectProgramId));
}

#[test]
fn program_id_check_precedes_derivation_ladder_order() {
    // Wrong token program AND non-canonical PDA-1: the program-id stage must
    // fire first (program ids before derivation).
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[1] = AccountMeta::new(Pubkey::new_unique(), false);
    metas[5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::IncorrectProgramId));
}

#[test]
fn non_canonical_pda1_fails_invalid_seeds() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[1] = AccountMeta::new(Pubkey::new_unique(), false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn non_canonical_pda2_fails_invalid_seeds() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[2] = AccountMeta::new(Pubkey::new_unique(), false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn cross_mint_pda_pairing_fails_invalid_seeds() {
    // Mint A's I-1 given mint B's (canonical) PDA-1: derivation against the
    // supplied mint account must reject it.
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let other_mint = Pubkey::new_unique();
    let (foreign_pda1, _) = pda::find_mint_state_address(&other_mint, &ddcp_ddc::id());
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[1] = AccountMeta::new(foreign_pda1, false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
}

#[test]
fn readonly_pda1_fails_immutable() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[1] = AccountMeta::new_readonly(f.pda1, false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn readonly_mint_fails_immutable() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[0] = AccountMeta::new_readonly(f.mint_kp.pubkey(), true);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::Immutable));
}

#[test]
fn mint_not_signer_fails_missing_signature() {
    let (mut svm, payer) = setup();
    // No keypair needed: the mint never signs in this negative.
    let mint = Pubkey::new_unique();
    let program_id = ddcp_ddc::id();
    let (pda1, _) = pda::find_mint_state_address(&mint, &program_id);
    let (pda2, _) = pda::find_attestation_address(&mint, &program_id);
    let args = sample_initialize_mint_args(
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
        &Pubkey::new_unique(),
    );
    let mut metas =
        initialize_mint_metas(&mint, &pda1, &pda2, &payer.pubkey(), &Pubkey::new_unique());
    metas[0] = AccountMeta::new(mint, false);
    let res = send(&mut svm, &payer, initialize_mint_ix(metas, &args), &[]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn payer_account_not_signer_fails_missing_signature() {
    // The fee payer signs the transaction, but the account passed in the
    // I-1 payer slot is a different, non-signing key.
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let non_signing_payer = Pubkey::new_unique();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas[3] = AccountMeta::new(non_signing_payer, false);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn trailing_arg_bytes_fail_invalid_instruction_data() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut arg_bytes = borsh::to_vec(&f.args).unwrap();
    arg_bytes.push(0);
    let ix1 = build_ix(
        ix::INITIALIZE_MINT_DISCRIMINATOR,
        metas_for(&f, &payer.pubkey()),
        arg_bytes,
    );
    let res = send(&mut svm, &payer, ix1, &[&f.mint_kp]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

#[test]
fn truncated_args_fail_invalid_instruction_data() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut arg_bytes = borsh::to_vec(&f.args).unwrap();
    arg_bytes.pop();
    let ix1 = build_ix(
        ix::INITIALIZE_MINT_DISCRIMINATOR,
        metas_for(&f, &payer.pubkey()),
        arg_bytes,
    );
    let res = send(&mut svm, &payer, ix1, &[&f.mint_kp]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

// solana-instruction 3.x deprecates NotEnoughAccountKeys in favor of
// MissingAccount, but the runtime still maps ProgramError::NotEnoughAccountKeys
// to it — this assert pins actual runtime behavior.
#[allow(deprecated)]
#[test]
fn short_account_list_fails_not_enough_account_keys() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let mut metas = metas_for(&f, &payer.pubkey());
    metas.truncate(5);
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    assert_eq!(res, Err(InstructionError::NotEnoughAccountKeys));
}

#[test]
fn reinvocation_on_same_mint_fails() {
    let (mut svm, payer) = setup();
    let f = i1_default_fixture();
    let ix1 = initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args);
    // Logs-surfacing send: an unexpected failure HERE (the must-succeed leg)
    // is precisely the post-mortem case — an earlier f64 abort was
    // undiagnosable until meta.logs were surfaced.
    send_with_logs_on_failure(&mut svm, &payer, ix1.clone(), &[&f.mint_kp])
        .expect("first I-1 must succeed");

    // One-time by construction: the second run fails inside the first System
    // CreateAccount CPI (the mint account already exists) with
    // SystemError::AccountAlreadyInUse = Custom(0).
    svm.expire_blockhash();
    let res = send(&mut svm, &payer, ix1, &[&f.mint_kp]);
    assert_eq!(res, Err(InstructionError::Custom(0)));
}

// ---------------------------------------------------------------------------
// Metadata mutability pins — post-init client-side Token-2022 ops against
// the I-1-built mint (mutable under the update authority + one-way latch)
// ---------------------------------------------------------------------------

#[test]
fn update_field_succeeds_under_update_authority() {
    let (mut svm, payer) = setup();
    let update_auth = Keypair::new();
    let mut f = i1_default_fixture();
    f.metadata_update_authority = update_auth.pubkey();
    let ix1 = initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args);
    send_with_logs_on_failure(&mut svm, &payer, ix1, &[&f.mint_kp]).expect("I-1 must succeed");

    // Growth case: a longer uri makes the processor realloc the mint again —
    // top up the mint's lamports test-side first (rent for the larger size).
    svm.airdrop(&f.mint_kp.pubkey(), 1_000_000_000).unwrap();
    let new_uri = "https://example.org/token-metadata-v2.json".to_string();
    let ix2 = tm_update_field(
        &spl_token_2022_interface::id(),
        &f.mint_kp.pubkey(),
        &update_auth.pubkey(),
        Field::Uri,
        new_uri.clone(),
    );
    send(&mut svm, &payer, ix2, &[&update_auth])
        .expect("UpdateField under the live update authority must succeed");

    let acct = svm.get_account(&f.mint_kp.pubkey()).unwrap();
    let st = StateWithExtensions::<Mint>::unpack(&acct.data).unwrap();
    let tm = st.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(tm.uri, new_uri);
    assert_eq!(tm.name, f.args.name, "unrelated fields must be untouched");
    assert_eq!(
        Option::<Pubkey>::from(tm.update_authority),
        Some(update_auth.pubkey()),
        "authority itself must be unchanged by a field update"
    );
}

#[test]
fn update_field_fails_after_update_authority_nulled() {
    let (mut svm, payer) = setup();
    let update_auth = Keypair::new();
    let mut f = i1_default_fixture();
    f.metadata_update_authority = update_auth.pubkey();
    let ix1 = initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args);
    send_with_logs_on_failure(&mut svm, &payer, ix1, &[&f.mint_kp]).expect("I-1 must succeed");

    // The one-way immutability latch: null the CONTENT authority.
    // The null argument is MaybeNull's None (solana-nullable 1.2.0
    // maybe_null.rs:122 — infallible for None, hence the safe unwrap).
    let null_ix = tm_update_authority(
        &spl_token_2022_interface::id(),
        &f.mint_kp.pubkey(),
        &update_auth.pubkey(),
        None::<Pubkey>.try_into().unwrap(),
    );
    send(&mut svm, &payer, null_ix, &[&update_auth]).expect("UpdateAuthority -> None must succeed");

    // The same update that succeeds pre-latch must now fail. Funded and
    // signed identically, so the ONLY difference is the nulled authority.
    // Pin: errored AND not a DDC 6000..=6007 code (the
    // upstream variant name is not asserted), and the metadata is unchanged.
    svm.airdrop(&f.mint_kp.pubkey(), 1_000_000_000).unwrap();
    let ix2 = tm_update_field(
        &spl_token_2022_interface::id(),
        &f.mint_kp.pubkey(),
        &update_auth.pubkey(),
        Field::Uri,
        "https://example.org/token-metadata-v2.json".to_string(),
    );
    let err = send(&mut svm, &payer, ix2, &[&update_auth])
        .expect_err("UpdateField after the null latch must fail");
    if let InstructionError::Custom(code) = err {
        assert!(
            !(6000..=6007).contains(&code),
            "failure must not be a DDC custom code: {code}"
        );
    }
    let acct = svm.get_account(&f.mint_kp.pubkey()).unwrap();
    let st = StateWithExtensions::<Mint>::unpack(&acct.data).unwrap();
    let tm = st.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(
        tm.uri, f.args.uri,
        "metadata must be unchanged after the failed update"
    );
    assert_eq!(
        Option::<Pubkey>::from(tm.update_authority),
        None,
        "the latch is one-way: authority stays nulled"
    );
}

#[test]
fn default_metadata_update_authority_is_invalid_pubkey() {
    let (mut svm, payer) = setup();
    let mut f = i1_default_fixture();
    // Account #7 (TokenMetadata CONTENT authority) defaulted to the zero
    // pubkey. The handler's checked try_into on Some(*key) rejects it with
    // InvalidPubkey (6004) rather than silently nulling the CONTENT authority —
    // which would leave metadata immutable from genesis.
    // The account slot is well-formed (identity-only: no signer/writable/
    // derivation row); only its key is default, so every upstream ladder check
    // passes and 6004 is the returned error, not a structural rejection.
    f.metadata_update_authority = Pubkey::default();
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas_for(&f, &payer.pubkey()), &f.args),
        &[&f.mint_kp],
    );
    assert_custom(res, 6004); // InvalidPubkey
}

// ---------------------------------------------------------------------------
// Genesis-settled fee ceilings (PDA-1 `fee_ceiling_basis_points` /
// `fee_ceiling_base_units`): stored from args, bounded at 10_000 bps, zero
// permitted.
// ---------------------------------------------------------------------------

fn i1_send_with_ceilings(
    bps: u16,
    base_units: u64,
) -> (Result<(), InstructionError>, Option<MintState>) {
    let (mut svm, payer) = setup();
    let mut f = i1_default_fixture();
    f.args.fee_ceiling_basis_points = bps;
    f.args.fee_ceiling_base_units = base_units;
    let metas = metas_for(&f, &payer.pubkey());
    let res = send(
        &mut svm,
        &payer,
        initialize_mint_ix(metas, &f.args),
        &[&f.mint_kp],
    );
    let state = svm
        .get_account(&f.pda1)
        .map(|_| read_mint_state(&svm, &f.pda1));
    (res, state)
}

#[test]
fn ceiling_at_10000_bps_is_accepted_and_stored() {
    let (res, state) = i1_send_with_ceilings(10_000, 7);
    res.unwrap();
    let state = state.unwrap();
    assert_eq!(state.fee_ceiling_basis_points, 10_000);
    assert_eq!(state.fee_ceiling_base_units, 7);
    assert_eq!(state.reserved, [0u8; 54]);
}

#[test]
fn zero_ceilings_are_accepted_and_stored() {
    let (res, state) = i1_send_with_ceilings(0, 0);
    res.unwrap();
    let state = state.unwrap();
    assert_eq!(state.fee_ceiling_basis_points, 0);
    assert_eq!(state.fee_ceiling_base_units, 0);
}

#[test]
fn ceiling_above_10000_bps_is_fee_ceiling_invalid_and_creates_nothing() {
    let (res, state) = i1_send_with_ceilings(10_001, 1_000_000);
    assert_custom(res, 6010); // FeeCeilingInvalid
    assert!(
        state.is_none(),
        "PDA-1 must not exist after a refused genesis"
    );
}
