//! Token-2022 fixture layer for the integration suites: the VM is
//! constructed WITHOUT litesvm's
//! default program set, and the only Token-2022 that can execute is one of
//! two dumps, each pinned by SHA-256 against its committed provenance record:
//! mainnet-beta's (the default) or devnet's, chosen by `DDCP_TOKEN_2022`.
//! No fallback of any kind — a missing or mismatched binary panics, so tests
//! can never silently run against litesvm's bundled spl_token_2022-10.0.0.so.
//!
//! Mint and token accounts are ALLOCATED via `set_account` (zeroed,
//! Token-2022-owned, rent-exempt — in lieu of a System-program
//! dev-dependency) and then INITIALIZED by real Token-2022
//! instructions: every base-state and extension-TLV byte is written by the
//! pinned program itself, never hand-assembled by the harness.

use std::fs;

use agave_feature_set::FeatureSet;
use ddcp_ddc::pda;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program::instruction::{Instruction, InstructionError};
use solana_program::native_token::LAMPORTS_PER_SOL;
use solana_program::program_option::COption;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use solana_zk_sdk_pod::encryption::elgamal::PodElGamalPubkey;
use spl_token_2022_interface::extension::confidential_transfer::instruction::initialize_mint as initialize_confidential_transfer_mint;
use spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferMint;
use spl_token_2022_interface::extension::confidential_transfer_fee::instruction::initialize_confidential_transfer_fee_config;
use spl_token_2022_interface::extension::confidential_transfer_fee::ConfidentialTransferFeeConfig;
use spl_token_2022_interface::extension::transfer_fee::instruction::initialize_transfer_fee_config;
use spl_token_2022_interface::extension::transfer_fee::{TransferFeeAmount, TransferFeeConfig};
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022_interface::instruction::{initialize_account3, initialize_mint2};
use spl_token_2022_interface::state::{Account as TokenAccount, Mint};

/// The environment variable that chooses the pinned Token-2022 build:
/// `mainnet` (also when unset) or `devnet`. Any other value panics.
pub const TOKEN_2022_BUILD_VAR: &str = "DDCP_TOKEN_2022";

/// One pinned Token-2022 build: the cluster it was dumped from, the gitignored
/// binary and the committed provenance record that pins it.
pub struct Token2022Build {
    pub cluster: &'static str,
    pub cluster_url: &'static str,
    pub so_path: &'static str,
    pub provenance_path: &'static str,
}

pub const TOKEN_2022_MAINNET: Token2022Build = Token2022Build {
    cluster: "mainnet",
    cluster_url: "https://api.mainnet-beta.solana.com",
    so_path: concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/token_2022-mainnet.so"
    ),
    provenance_path: concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/token-2022-mainnet.provenance.txt"
    ),
};

pub const TOKEN_2022_DEVNET: Token2022Build = Token2022Build {
    cluster: "devnet",
    cluster_url: "https://api.devnet.solana.com",
    so_path: concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/token_2022.so"),
    provenance_path: concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/token-2022.provenance.txt"
    ),
};

/// The build this run loads, from `DDCP_TOKEN_2022`.
pub fn selected_token_2022_build() -> Token2022Build {
    match std::env::var(TOKEN_2022_BUILD_VAR) {
        Err(std::env::VarError::NotPresent) => TOKEN_2022_MAINNET,
        Ok(value) if value == "mainnet" => TOKEN_2022_MAINNET,
        Ok(value) if value == "devnet" => TOKEN_2022_DEVNET,
        other => panic!(
            "{TOKEN_2022_BUILD_VAR} must be `mainnet`, `devnet` or unset (mainnet); found {other:?}"
        ),
    }
}
/// Token-2022 canonical program address.
pub const TOKEN_2022_CANONICAL_ADDRESS: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// The three-extension set: ConfidentialTransferMint, TransferFeeConfig,
/// ConfidentialTransferFeeConfig. A two-extension variant exists only inside
/// `try_create_two_extension_mint` for the InvalidExtensionCombination negative.
pub const MINT_EXTENSIONS: [ExtensionType; 3] = [
    ExtensionType::ConfidentialTransferMint,
    ExtensionType::TransferFeeConfig,
    ExtensionType::ConfidentialTransferFeeConfig,
];

/// LiteSVM mirroring `into_basic()` minus `with_default_programs()`:
/// builtins/sysvars/feature-accounts keep the System program present;
/// `FeatureSet::all_enabled()` replaces litesvm's frozen mainnet snapshot —
/// a workaround for the litesvm-0.12 / platform-tools-v1.52 f64 opcode
/// mismatch (I-1's `Rent::minimum_balance` aborted "unsupported BPF
/// instruction" under the snapshot), NOT a cluster-parity proxy: this suite
/// checks logic/state correctness; cluster correctness is established on
/// devnet. Applied before `with_builtins()` so builtin
/// registration sees the same set (probe-proven ordering). `with_lamports`
/// funds the airdrop faucet; sigverify and blockhash checks stay as in the
/// handler suites. None of these loads SPL programs — assertion 1 verifies that on
/// every `setup_token()`.
pub fn svm_without_default_programs() -> LiteSVM {
    LiteSVM::default()
        .with_feature_set(FeatureSet::all_enabled())
        .with_builtins()
        .with_sysvars()
        .with_feature_accounts()
        .with_lamports(1_000_000 * LAMPORTS_PER_SOL)
        .with_sigverify(true)
        .with_blockhash_check(true)
}

pub struct PinnedToken2022 {
    pub sha256_hex: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Binary-identity assertion 1 — negative control: the no-defaults VM holds no
/// executable at the canonical Token-2022 address before the pinned load. If
/// the construction ever silently regains default programs, this fails loudly.
pub fn assert_no_ambient_token_2022(svm: &LiteSVM) {
    let ambient = svm.get_account(&spl_token_2022_interface::id());
    assert!(
        ambient
            .as_ref()
            .is_none_or(|a| !a.executable && a.data.is_empty()),
        "ambient Token-2022 present before the pinned load — VM construction \
         is not default-program-free: {ambient:?}"
    );
}

/// Binary-identity assertion 2 — checksum gate and sole injection point:
/// loads the build `DDCP_TOKEN_2022` selects, and refuses a `.so` whose
/// SHA-256 does not match that build's committed provenance record, written
/// by scripts/fetch-fixture-programs.sh, or a record of another cluster.
pub fn load_pinned_token_2022(svm: &mut LiteSVM) -> PinnedToken2022 {
    assert_eq!(
        spl_token_2022_interface::id().to_string(),
        TOKEN_2022_CANONICAL_ADDRESS,
        "interface crate id() is not the canonical Token-2022 address"
    );
    let build = selected_token_2022_build();
    let (cluster, so_path, provenance_path) = (build.cluster, build.so_path, build.provenance_path);
    let provenance = fs::read_to_string(provenance_path).unwrap_or_else(|e| {
        panic!(
            "missing provenance record {provenance_path} ({e}) — \
             scripts/fetch-fixture-programs.sh must be run first (a network \
             fetch of the {cluster} Token-2022 program)"
        )
    });
    let cluster_line = format!("cluster_url={}", build.cluster_url);
    assert!(
        provenance.lines().any(|l| l.trim() == cluster_line),
        "{provenance_path} does not record {cluster_line} — refusing to load"
    );
    let recorded = provenance
        .lines()
        .find_map(|l| l.strip_prefix("sha256="))
        .unwrap_or_else(|| panic!("no sha256= line in {provenance_path}"))
        .trim()
        .to_string();
    let bytes = fs::read(so_path).unwrap_or_else(|e| {
        panic!(
            "missing {so_path} ({e}) — scripts/fetch-fixture-programs.sh \
             must be run first (a network fetch)"
        )
    });
    let actual = sha256_hex(&bytes);
    assert_eq!(
        actual, recorded,
        "{so_path} SHA-256 does not match the committed provenance record — \
         refusing to load; re-run scripts/fetch-fixture-programs.sh"
    );
    svm.add_program(spl_token_2022_interface::id(), &bytes)
        .unwrap_or_else(|e| panic!("LiteSVM rejected the checksum-verified {so_path}: {e:?}"));
    PinnedToken2022 { sha256_hex: actual }
}

/// Binary-identity assertion 3 — REDUCED to a shallow registration check:
/// the account at the canonical address is executable and loader-owned. Byte-identity
/// rests on assertions 1 + 2 — no ambient binary exists, and the
/// checksum-gated loader is the sole injection point.
pub fn assert_token_2022_program_registered(svm: &LiteSVM) {
    let program_account = svm
        .get_account(&spl_token_2022_interface::id())
        .expect("no account at the Token-2022 address after the pinned load");
    assert!(
        program_account.executable,
        "Token-2022 program account is not executable"
    );
    assert_ne!(
        program_account.owner,
        Pubkey::default(),
        "Token-2022 program account has no loader owner"
    );
}

pub struct TokenCtx {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

/// Every Token-2022 suite starts here: identity assertions 1–3 run before any
/// fixture is built, so no test can execute against an unproven binary.
pub fn setup_token() -> TokenCtx {
    let mut svm = svm_without_default_programs();
    assert_no_ambient_token_2022(&svm);
    let _pinned = load_pinned_token_2022(&mut svm);
    assert_token_2022_program_registered(&svm);
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    TokenCtx { svm, payer }
}

/// Allocation-only `set_account` (no System-program dev-dependency): zeroed, Token-2022-owned,
/// rent-exempt. Every subsequent byte is written by the pinned program.
/// If a Token-2022 init ever rejects an account allocated this way, that is
/// the STOP condition for the solana-system-interface fallback — report
/// before touching Cargo.toml.
fn allocate_token_2022_owned(svm: &mut LiteSVM, address: &Pubkey, space: usize) {
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    svm.set_account(
        *address,
        Account {
            lamports,
            data: vec![0u8; space],
            owner: spl_token_2022_interface::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub struct TokenFixture {
    pub mint: Pubkey,
    pub pda1: Pubkey,
    pub pda3: Pubkey,
    pub pda5: Pubkey,
    /// TransferFeeConfig withdraw_withheld_authority — per-test random.
    pub withdraw_withheld_authority: Pubkey,
    /// ConfidentialTransferMint authority — per-test random. This fixture
    /// builds the mint directly with Token-2022, not through I-1.
    pub ct_mint_authority: Pubkey,
    /// ConfidentialTransferFeeConfig authority — per-test random.
    pub ctfee_authority: Pubkey,
    /// Withheld-fee ElGamal key — zeroed placeholder.
    pub ctfee_elgamal: PodElGamalPubkey,
}

/// Build the three-extension mint: allocate, then one transaction of real
/// Token-2022 instructions — the three extension inits, `initialize_mint2`
/// last (extensions before mint init). Fee values 0 bps and 0 max fee; mint
/// authority PDA-1, freeze authority None (asserted in the fidelity proof).
pub fn create_three_extension_mint(svm: &mut LiteSVM, payer: &Keypair) -> TokenFixture {
    let token_id = spl_token_2022_interface::id();
    let program_id = ddcp_ddc::id();
    let mint = Pubkey::new_unique();
    let (pda1, _) = pda::find_mint_state_address(&mint, &program_id);
    let (pda3, _) = pda::find_fee_authority_address(&mint, &program_id);
    let (pda5, _) = pda::find_redemption_authority_address(&mint, &program_id);
    let withheld = Pubkey::new_unique();
    let ct_auth = Pubkey::new_unique();
    let ctfee_authority = Pubkey::new_unique();
    let ctfee_elgamal = PodElGamalPubkey::default();

    let space = ExtensionType::try_calculate_account_len::<Mint>(&MINT_EXTENSIONS).unwrap();
    allocate_token_2022_owned(svm, &mint, space);
    let ixs = [
        initialize_confidential_transfer_mint(&token_id, &mint, Some(ct_auth), true, None).unwrap(),
        initialize_transfer_fee_config(&token_id, &mint, Some(&pda3), Some(&withheld), 0, 0)
            .unwrap(),
        initialize_confidential_transfer_fee_config(
            &token_id,
            &mint,
            Some(ctfee_authority),
            &ctfee_elgamal,
        )
        .unwrap(),
        initialize_mint2(&token_id, &mint, &pda1, None, 6).unwrap(),
    ];
    send_ixs(svm, payer, &ixs, &[])
        .expect("three-extension mint init must succeed against the pinned program");

    TokenFixture {
        mint,
        pda1,
        pda3,
        pda5,
        withdraw_withheld_authority: withheld,
        ct_mint_authority: ct_auth,
        ctfee_authority,
        ctfee_elgamal,
    }
}

/// Negative only: ConfidentialTransferMint + TransferFeeConfig WITHOUT
/// ConfidentialTransferFeeConfig. The pinned program must reject this at the
/// `initialize_mint2` instruction (index 2). Never use outside that negative
/// test.
pub fn try_create_two_extension_mint(
    svm: &mut LiteSVM,
    payer: &Keypair,
) -> Result<(), (u8, InstructionError)> {
    let token_id = spl_token_2022_interface::id();
    let mint = Pubkey::new_unique();
    let (pda3, _) = pda::find_fee_authority_address(&mint, &ddcp_ddc::id());
    let withheld = Pubkey::new_unique();
    let two = [
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::TransferFeeConfig,
    ];
    let space = ExtensionType::try_calculate_account_len::<Mint>(&two).unwrap();
    allocate_token_2022_owned(svm, &mint, space);
    let ixs = [
        initialize_confidential_transfer_mint(
            &token_id,
            &mint,
            Some(Pubkey::new_unique()),
            true,
            None,
        )
        .unwrap(),
        initialize_transfer_fee_config(&token_id, &mint, Some(&pda3), Some(&withheld), 0, 0)
            .unwrap(),
        initialize_mint2(&token_id, &mint, &Pubkey::new_unique(), None, 6).unwrap(),
    ];
    send_ixs(svm, payer, &ixs, &[])
}

/// Public-path token account (transfer-fee footprint): space includes TransferFeeAmount,
/// the required account extension paired with the mint's TransferFeeConfig.
/// ConfidentialTransferFeeAmount arrives only at ConfigureAccount (ZK proof
/// generation); the accounts here are public-path only.
pub fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let token_id = spl_token_2022_interface::id();
    let account = Pubkey::new_unique();
    let space = ExtensionType::try_calculate_account_len::<TokenAccount>(&[
        ExtensionType::TransferFeeAmount,
    ])
    .unwrap();
    allocate_token_2022_owned(svm, &account, space);
    let ixs = [initialize_account3(&token_id, &account, mint, owner).unwrap()];
    send_ixs(svm, payer, &ixs, &[]).expect("token account init must succeed");
    account
}

/// Fixture fidelity proof: deserialized via the interface crate's own types.
/// Handler suites call this in setup; the token_fixture suite pins it standalone.
pub fn assert_mint_fixture_valid(svm: &LiteSVM, fx: &TokenFixture) {
    let acct = svm.get_account(&fx.mint).expect("mint account missing");
    assert_eq!(acct.owner, spl_token_2022_interface::id());
    let st = StateWithExtensions::<Mint>::unpack(&acct.data)
        .expect("mint must unpack via interface-crate types");

    assert_eq!(st.base.decimals, 6, "decimals");
    assert_eq!(st.base.supply, 0);
    assert!(st.base.is_initialized);
    assert_eq!(
        st.base.mint_authority,
        COption::Some(fx.pda1),
        "mint authority must be PDA-1"
    );
    assert_eq!(
        st.base.freeze_authority,
        COption::None,
        "hard constraint: freeze authority permanently None"
    );

    let mut ext = st.get_extension_types().unwrap();
    let mut expected = MINT_EXTENSIONS.to_vec();
    ext.sort_unstable_by_key(|e| u16::from(*e));
    expected.sort_unstable_by_key(|e| u16::from(*e));
    assert_eq!(
        ext, expected,
        "extension set must be exactly the three-extension set"
    );

    let tf = st.get_extension::<TransferFeeConfig>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(tf.transfer_fee_config_authority),
        Some(fx.pda3),
        "fee authority must be PDA-3"
    );
    assert_eq!(
        Option::<Pubkey>::from(tf.withdraw_withheld_authority),
        Some(fx.withdraw_withheld_authority)
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

    let ct = st.get_extension::<ConfidentialTransferMint>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(ct.authority),
        Some(fx.ct_mint_authority)
    );
    assert!(
        bool::from(ct.auto_approve_new_accounts),
        "auto_approve_new_accounts true at init"
    );
    assert_eq!(
        Option::<PodElGamalPubkey>::from(ct.auditor_elgamal_pubkey),
        None,
        "no auditor key at launch"
    );

    let ctf = st.get_extension::<ConfidentialTransferFeeConfig>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(ctf.authority),
        Some(fx.ctfee_authority)
    );
    assert_eq!(
        ctf.withdraw_withheld_authority_elgamal_pubkey,
        fx.ctfee_elgamal
    );
}

pub fn assert_token_account_fixture_valid(
    svm: &LiteSVM,
    token_account: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) {
    let acct = svm
        .get_account(token_account)
        .expect("token account missing");
    assert_eq!(acct.owner, spl_token_2022_interface::id());
    let st = StateWithExtensions::<TokenAccount>::unpack(&acct.data)
        .expect("token account must unpack via interface-crate types");
    assert_eq!(st.base.mint, *mint);
    assert_eq!(st.base.owner, *owner);
    assert_eq!(st.base.amount, 0);
    let ext = st.get_extension_types().unwrap();
    assert!(
        ext.contains(&ExtensionType::TransferFeeAmount),
        "TransferFeeAmount required on every account of this mint"
    );
    let tfa = st.get_extension::<TransferFeeAmount>().unwrap();
    assert_eq!(u64::from(tfa.withheld_amount), 0);
}

/// Multi-instruction send; failures return (instruction index, error).
pub fn send_ixs(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ixs: &[Instruction],
    extra_signers: &[&Keypair],
) -> Result<(), (u8, InstructionError)> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(_) => Ok(()),
        Err(failed) => match failed.err {
            TransactionError::InstructionError(i, e) => Err((i, e)),
            other => panic!("non-instruction transaction failure: {other:?}"),
        },
    }
}
