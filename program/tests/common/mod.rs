//! Shared LiteSVM fixtures for the integration suites.
//!
//! Two invariants this module is responsible for:
//! 1. The program is registered under `ddcp_ddc::id()` — the
//!    `declare_id!` key — NOT the auto-generated
//!    `target/deploy/ddcp_ddc-keypair.json`. In-program
//!    `find_program_address` uses `crate::id()`; loading under any other key
//!    would make every derivation check fail against mismatched PDAs.
//! 2. Seeded accounts are serialized by `state.rs`'s own `save` (single source
//!    of serialization truth), owned by the program id, canonical bump. The
//!    byte-fidelity locks (reference-vector comparison, all-zero negative) live
//!    in the pause_resume suite.

#![allow(dead_code)] // each integration binary uses a subset of these helpers

// Token-2022 fixture layer. Separate no-defaults LiteSVM constructor — the
// `setup()` below, which loads no Token-2022, is deliberately separate.
pub mod token;

use ddcp_ddc::instruction as ix;
use ddcp_ddc::pda;
use ddcp_ddc::state::{
    AttestationRecord, MintState, ATTESTATION_RECORD_LEN, MINT_STATE_LEN,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program::instruction::{AccountMeta, Instruction, InstructionError};
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub const SO_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/deploy/ddcp_ddc.so"
);

pub struct Ctx {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub mint: Pubkey,
    pub issuer: Keypair,
    pub operator: Keypair,
    pub reserve: Keypair,
    pub pda1: Pubkey,
}

pub fn setup(paused: bool) -> Ctx {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ddcp_ddc::id(), SO_PATH)
        .expect("missing target/deploy/ddcp_ddc.so — run `cargo build-sbf` in program/ before `cargo test`");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let mint = Pubkey::new_unique();
    let issuer = Keypair::new();
    let operator = Keypair::new();
    let reserve = Keypair::new();
    let pda1 = seed_mint_state(
        &mut svm,
        &mint,
        &issuer.pubkey(),
        &operator.pubkey(),
        &reserve.pubkey(),
        paused,
    );

    Ctx {
        svm,
        payer,
        mint,
        issuer,
        operator,
        reserve,
        pda1,
    }
}

/// Handler-suite context: the pinned-binary Token-2022 fixture layer
/// (no-defaults VM) composed with the program load and PDA-1
/// seeding. `operator` is unused by I-2 but part of the seeded three-authority
/// state (I-6 uses it).
pub struct TokenHandlerCtx {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub issuer: Keypair,
    pub operator: Keypair,
    pub reserve: Keypair,
    pub fx: token::TokenFixture,
}

/// Composes, in order: `setup_token()` (identity assertions 1–3 run inside) →
/// program load under `ddcp_ddc::id()` (invariant 1 above) →
/// `create_three_extension_mint` → `seed_mint_state` at the address the mint
/// fixture already designated as its mint authority (PDA-1 dual role).
pub fn setup_token_handlers(paused: bool) -> TokenHandlerCtx {
    let token::TokenCtx { mut svm, payer } = token::setup_token();
    svm.add_program_from_file(ddcp_ddc::id(), SO_PATH)
        .expect("missing target/deploy/ddcp_ddc.so — run `cargo build-sbf` in program/ before `cargo test`");
    let fx = token::create_three_extension_mint(&mut svm, &payer);
    let issuer = Keypair::new();
    let operator = Keypair::new();
    let reserve = Keypair::new();
    let pda1 = seed_mint_state(
        &mut svm,
        &fx.mint,
        &issuer.pubkey(),
        &operator.pubkey(),
        &reserve.pubkey(),
        paused,
    );
    assert_eq!(
        pda1, fx.pda1,
        "seeded PDA-1 must be the address the mint fixture set as mint authority"
    );
    TokenHandlerCtx {
        svm,
        payer,
        issuer,
        operator,
        reserve,
        fx,
    }
}

/// The reference genesis defaults for the two fee ceilings: 100 basis points
/// and one whole unit (1_000_000 base units at six decimals).
pub const DEFAULT_FEE_CEILING_BASIS_POINTS: u16 = 100;
pub const DEFAULT_FEE_CEILING_BASE_UNITS: u64 = 1_000_000;

/// Seed PDA-1 with byte-faithful MintState data at the canonical address,
/// the fee ceilings at the reference defaults.
pub fn seed_mint_state(
    svm: &mut LiteSVM,
    mint: &Pubkey,
    issuer: &Pubkey,
    operator: &Pubkey,
    reserve: &Pubkey,
    paused: bool,
) -> Pubkey {
    seed_mint_state_with_ceilings(
        svm,
        mint,
        issuer,
        operator,
        reserve,
        paused,
        DEFAULT_FEE_CEILING_BASIS_POINTS,
        DEFAULT_FEE_CEILING_BASE_UNITS,
    )
}

/// `seed_mint_state` with explicit fee ceilings. A ceiling above 10_000
/// basis points cannot come from I-1 (`FeeCeilingInvalid`); seeding one is
/// how a test reaches the Token-2022 CPI's own rate bound through I-6.
#[allow(clippy::too_many_arguments)]
pub fn seed_mint_state_with_ceilings(
    svm: &mut LiteSVM,
    mint: &Pubkey,
    issuer: &Pubkey,
    operator: &Pubkey,
    reserve: &Pubkey,
    paused: bool,
    fee_ceiling_basis_points: u16,
    fee_ceiling_base_units: u64,
) -> Pubkey {
    let (pda1, bump) = pda::find_mint_state_address(mint, &ddcp_ddc::id());
    let state = MintState {
        pause_active: paused,
        issuer_authority: *issuer,
        operator_authority: *operator,
        reserve_authority: *reserve,
        minimum_fee: 0,
        fee_ceiling_basis_points,
        fee_ceiling_base_units,
        reserved: [0u8; 54],
        bump,
    };
    let mut data = vec![0u8; MINT_STATE_LEN];
    state.save(&mut data).unwrap();
    svm.set_account(
        pda1,
        Account {
            lamports: 10_000_000,
            data,
            owner: ddcp_ddc::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    pda1
}

/// Seed PDA-2 in its I-1 "zeroed" convention: discriminator + zero-valued
/// fields + canonical bump; `attestor_pubkey == default` is the
/// no-attestation-yet sentinel.
pub fn seed_attestation_zeroed(svm: &mut LiteSVM, mint: &Pubkey) -> Pubkey {
    let (pda2, bump) = pda::find_attestation_address(mint, &ddcp_ddc::id());
    let record = AttestationRecord {
        attested_reserve_amount: 0,
        attestation_timestamp: 0,
        attestor_pubkey: Pubkey::default(),
        attestation_uri: [0u8; 128],
        bump,
    };
    let mut data = vec![0u8; ATTESTATION_RECORD_LEN];
    record.save(&mut data).unwrap();
    svm.set_account(
        pda2,
        Account {
            lamports: 10_000_000,
            data,
            owner: ddcp_ddc::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    pda2
}

/// Seed a program-owned account with valid-looking MintState bytes at a
/// NON-canonical address — the InvalidSeeds structural negative.
pub fn seed_lookalike_mint_state(svm: &mut LiteSVM, ctx_state_source: &Pubkey) -> Pubkey {
    let lookalike = Pubkey::new_unique();
    let account = svm.get_account(ctx_state_source).unwrap();
    svm.set_account(
        lookalike,
        Account {
            lamports: 10_000_000,
            data: account.data,
            owner: ddcp_ddc::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    lookalike
}

pub fn read_mint_state(svm: &LiteSVM, pda1: &Pubkey) -> MintState {
    MintState::load(&svm.get_account(pda1).unwrap().data).unwrap()
}

pub fn read_attestation(svm: &LiteSVM, pda2: &Pubkey) -> AttestationRecord {
    AttestationRecord::load(&svm.get_account(pda2).unwrap().data).unwrap()
}

pub fn build_ix(disc: [u8; 8], metas: Vec<AccountMeta>, arg_bytes: Vec<u8>) -> Instruction {
    Instruction {
        program_id: ddcp_ddc::id(),
        accounts: metas,
        data: [disc.to_vec(), arg_bytes].concat(),
    }
}

/// The correct I-2 account metas, in instruction order. Negative tests mutate entries
/// before building the instruction.
pub fn mint_tokens_metas(
    mint: &Pubkey,
    destination: &Pubkey,
    pda1: &Pubkey,
    issuer: &Pubkey,
    reserve: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*mint, false),
        AccountMeta::new(*destination, false),
        AccountMeta::new_readonly(*pda1, false),
        AccountMeta::new_readonly(*issuer, true),
        AccountMeta::new_readonly(*reserve, true),
        AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
    ]
}

pub fn mint_tokens_ix(metas: Vec<AccountMeta>, amount: u64) -> Instruction {
    build_ix(
        ix::MINT_TOKENS_DISCRIMINATOR,
        metas,
        borsh::to_vec(&ix::MintTokensArgs { amount }).unwrap(),
    )
}

/// The correct I-3 account metas, in instruction order. Negative tests mutate entries
/// before building the instruction.
pub fn burn_tokens_metas(
    mint: &Pubkey,
    source: &Pubkey,
    pda1: &Pubkey,
    pda5: &Pubkey,
    issuer: &Pubkey,
    reserve: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*mint, false),
        AccountMeta::new(*source, false),
        AccountMeta::new_readonly(*pda1, false),
        AccountMeta::new_readonly(*pda5, false),
        AccountMeta::new_readonly(*issuer, true),
        AccountMeta::new_readonly(*reserve, true),
        AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
    ]
}

pub fn burn_tokens_ix(metas: Vec<AccountMeta>, amount: u64) -> Instruction {
    build_ix(
        ix::BURN_TOKENS_DISCRIMINATOR,
        metas,
        borsh::to_vec(&ix::BurnTokensArgs { amount }).unwrap(),
    )
}

/// The correct I-6 account metas, in instruction order. PDA-1 is WRITABLE here —
/// distinct from I-2/I-3, which read it.
pub fn update_transfer_fee_metas(
    mint: &Pubkey,
    pda3: &Pubkey,
    pda1: &Pubkey,
    issuer: &Pubkey,
    operator: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*mint, false),
        AccountMeta::new_readonly(*pda3, false),
        AccountMeta::new(*pda1, false),
        AccountMeta::new_readonly(*issuer, true),
        AccountMeta::new_readonly(*operator, true),
        AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
    ]
}

pub fn update_transfer_fee_ix(
    metas: Vec<AccountMeta>,
    new_fee_basis_points: u16,
    new_maximum_fee: u64,
    new_minimum_fee: u64,
) -> Instruction {
    build_ix(
        ix::UPDATE_TRANSFER_FEE_DISCRIMINATOR,
        metas,
        borsh::to_vec(&ix::UpdateTransferFeeArgs {
            new_fee_basis_points,
            new_maximum_fee,
            new_minimum_fee,
        })
        .unwrap(),
    )
}

pub fn pause_ix(mint: &Pubkey, pda1: &Pubkey, authority: &Pubkey, signed: bool) -> Instruction {
    build_ix(
        ix::PAUSE_ISSUANCE_DISCRIMINATOR,
        vec![
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*pda1, false),
            AccountMeta::new_readonly(*authority, signed),
        ],
        vec![],
    )
}

pub fn resume_ix(mint: &Pubkey, pda1: &Pubkey, issuer: &Pubkey, reserve: &Pubkey) -> Instruction {
    build_ix(
        ix::RESUME_ISSUANCE_DISCRIMINATOR,
        vec![
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*pda1, false),
            AccountMeta::new_readonly(*issuer, true),
            AccountMeta::new_readonly(*reserve, true),
        ],
        vec![],
    )
}

pub fn publish_ix(
    mint: &Pubkey,
    pda2: &Pubkey,
    pda1: &Pubkey,
    reserve: &Pubkey,
    arg_bytes: Vec<u8>,
) -> Instruction {
    build_ix(
        ix::PUBLISH_ATTESTATION_DISCRIMINATOR,
        vec![
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*pda2, false),
            AccountMeta::new_readonly(*pda1, false),
            AccountMeta::new_readonly(*reserve, true),
        ],
        arg_bytes,
    )
}

pub fn rotate_ix(
    mint: &Pubkey,
    pda1: &Pubkey,
    operator: &Pubkey,
    reserve: &Pubkey,
    arg_bytes: Vec<u8>,
) -> Instruction {
    build_ix(
        ix::ROTATE_SIGNER_DISCRIMINATOR,
        vec![
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*pda1, false),
            AccountMeta::new_readonly(*operator, true),
            AccountMeta::new_readonly(*reserve, true),
        ],
        arg_bytes,
    )
}

/// The correct I-1 account metas: the first six accounts plus #7 — the
/// `TokenMetadata` update authority (readonly, identity-only). Negative tests
/// mutate entries before building the instruction.
pub fn initialize_mint_metas(
    mint: &Pubkey,
    pda1: &Pubkey,
    pda2: &Pubkey,
    payer: &Pubkey,
    metadata_update_authority: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*mint, true),
        AccountMeta::new(*pda1, false),
        AccountMeta::new(*pda2, false),
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(
            ddcp_ddc::processor::initialize_mint::SYSTEM_PROGRAM_ID,
            false,
        ),
        AccountMeta::new_readonly(spl_token_2022_interface::id(), false),
        AccountMeta::new_readonly(*metadata_update_authority, false),
    ]
}

pub fn initialize_mint_ix(metas: Vec<AccountMeta>, args: &ix::InitializeMintArgs) -> Instruction {
    build_ix(
        ix::INITIALIZE_MINT_DISCRIMINATOR,
        metas,
        borsh::to_vec(args).unwrap(),
    )
}

/// I-1 args with placeholder metadata values and fresh per-test keys for every
/// authority the creator chooses.
/// The ElGamal key bytes are deliberately NONZERO so the positive path proves
/// a value round-trip, not a zero-default coincidence.
pub fn sample_initialize_mint_args(
    issuer: &Pubkey,
    operator: &Pubkey,
    reserve: &Pubkey,
) -> ix::InitializeMintArgs {
    ix::InitializeMintArgs {
        issuer_authority: *issuer,
        operator_authority: *operator,
        reserve_authority: *reserve,
        confidential_transfer_mint_authority: None,
        confidential_transfer_fee_authority: Pubkey::new_unique(),
        withdraw_withheld_authority_elgamal_pubkey: [9u8; 32],
        withdraw_withheld_authority: Pubkey::new_unique(),
        name: "ddc".to_string(),
        symbol: "DDC".to_string(),
        uri: "https://example.org/token-metadata.json".to_string(),
        metadata_pointer_authority: Pubkey::new_unique(),
        fee_ceiling_basis_points: DEFAULT_FEE_CEILING_BASIS_POINTS,
        fee_ceiling_base_units: DEFAULT_FEE_CEILING_BASE_UNITS,
    }
}

/// Send one instruction; on failure return the (index, InstructionError) pair.
pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    extra_signers: &[&Keypair],
) -> Result<(), InstructionError> {
    // Distinct blockhashes per send are handled by callers via expire_blockhash
    // where identical transactions repeat (idempotency tests).
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(_) => Ok(()),
        Err(failed) => match failed.err {
            TransactionError::InstructionError(_, e) => Err(e),
            other => panic!("non-instruction transaction failure: {other:?}"),
        },
    }
}

pub fn assert_custom(result: Result<(), InstructionError>, code: u32) {
    assert_eq!(result, Err(InstructionError::Custom(code)));
}

/// `send`, but a failure surfaces the runtime's full `meta.logs` (every
/// "Program log:" line, CU-consumed lines, and any panic/abort message) on
/// stderr before returning the error. The plain `send`'s
/// `TransactionError::InstructionError(_, e) => Err(e)` arm discards those
/// logs, which makes aborts like `ProgramFailedToComplete` undiagnosable —
/// use this variant when a failure needs a post-mortem.
pub fn send_with_logs_on_failure(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    extra_signers: &[&Keypair],
) -> Result<(), InstructionError> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(_) => Ok(()),
        Err(failed) => {
            eprintln!(
                "=== transaction failed: {:?} — meta.logs ({} lines) ===",
                failed.err,
                failed.meta.logs.len()
            );
            for line in &failed.meta.logs {
                eprintln!("{line}");
            }
            eprintln!("=== end meta.logs ===");
            match failed.err {
                TransactionError::InstructionError(_, e) => Err(e),
                other => panic!("non-instruction transaction failure: {other:?}"),
            }
        }
    }
}
