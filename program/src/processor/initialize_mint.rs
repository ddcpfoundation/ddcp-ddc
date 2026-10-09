//! I-1 `initialize_mint`: the five-extension genesis in one instruction. Four
//! fixed-size extensions at allocation (incl. the self-referential
//! MetadataPointer), PDA-1, PDA-2, then the on-mint TokenMetadata Initialize
//! — Token-2022 reallocs the mint to the final size; rent for it is
//! pre-funded at allocation.
//!
//! **Signing tier: deployer — mint keypair + payer.** MintState does not
//! exist before this instruction, so the authority-match checks are
//! structurally N/A here: the three authority args are STORED into PDA-1,
//! never matched against signers. This is the one instruction where that is
//! correct — documented rather than silently skipped.
//!
//! **One-time by construction:** re-invocation fails inside the System
//! `CreateAccount` CPIs (the mint and both PDAs are already funded/owned).
//! No custom re-initialization error exists.
//!
//! **Pre-funded-PDA residual:** System
//! `CreateAccount` fails if the target already holds lamports, so an attacker
//! who pre-funds PDA-1/PDA-2 could brick I-1 *for that mint keypair*. Accepted
//! as near-nil risk: the PDA addresses are not derivable before the mint
//! keypair exists, and the mint keypair is deployer-held until I-1 runs. No
//! create-or-assign fallback is built.
//!
//! Passed through unchanged from the arguments: the
//! ConfidentialTransferFeeConfig authority, the genesis-permanent
//! `withdraw_withheld_authority_elgamal_pubkey` and the
//! `withdraw_withheld_authority`, each chosen by the creator.

use borsh::BorshDeserialize;
use core::mem::size_of;

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    borsh1::get_instance_packed_len,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_zk_sdk_pod::encryption::elgamal::PodElGamalPubkey;
use spl_token_2022_interface::extension::confidential_transfer::instruction::initialize_mint as initialize_confidential_transfer_mint;
use spl_token_2022_interface::extension::confidential_transfer_fee::instruction::initialize_confidential_transfer_fee_config;
use spl_token_2022_interface::extension::metadata_pointer::instruction::initialize as initialize_metadata_pointer;
use spl_token_2022_interface::extension::transfer_fee::instruction::initialize_transfer_fee_config;
use spl_token_2022_interface::extension::{ExtensionType, Length};
use spl_token_2022_interface::instruction::initialize_mint2;
use spl_token_2022_interface::state::Mint;
use spl_token_metadata_interface::instruction::initialize as initialize_token_metadata;
use spl_token_metadata_interface::state::TokenMetadata;

use crate::{
    error::DdcError,
    instruction::InitializeMintArgs,
    pda,
    state::{AttestationRecord, MintState, ATTESTATION_RECORD_LEN, MINT_STATE_LEN},
    validation,
};

/// System program id — 32 zero bytes ("11111111111111111111111111111111").
pub const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// 1 DDC = 1,000,000 base units. Immutable post-initialization.
const DECIMALS: u8 = 6;

/// The four fixed-size genesis extensions (presence immutable): the
/// confidential/fee set plus `MetadataPointer`. Sizes the I-1
/// allocation only — on-mint `TokenMetadata` is variable-length and arrives
/// via the processor realloc at the in-handler Initialize, never in this
/// constant. Distinct from the 3-ext
/// test-fixture constant `token::MINT_EXTENSIONS` — never merge them.
const GENESIS_MINT_EXTENSIONS: [ExtensionType; 4] = [
    ExtensionType::ConfidentialTransferMint,
    ExtensionType::TransferFeeConfig,
    ExtensionType::ConfidentialTransferFeeConfig,
    ExtensionType::MetadataPointer,
];

/// System `CreateAccount`, hand-encoded: `system_instruction` is not reachable
/// from the solana-program 4.0 umbrella and no dependency is
/// added for it. Wire layout is the System program's bincode enum:
/// u32 LE discriminant 0 + `lamports: u64` LE + `space: u64` LE + `owner` 32
/// bytes = 52 bytes; metas `[payer (s, w), new (s, w)]`. Byte-verified against
/// solana-system-interface 3.2.0's own builder.
fn system_create_account_ix(
    payer: &Pubkey,
    new_account: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*new_account, true),
        ],
        data,
    }
}

/// I-1 — accounts: `mint` (writable, signer) · `PDA-1` (init,
/// writable) · `PDA-2` (init, writable) · `payer` (writable, signer) ·
/// `system_program` · `token_2022_program` · `metadata_update_authority`
/// (readonly, identity-only: its key becomes the `TokenMetadata` CONTENT
/// authority; a default pubkey fails `InvalidPubkey` — see the funding
/// literal).
pub fn process_initialize_mint(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: borsh must consume the remainder exactly.
    let args = InitializeMintArgs::try_from_slice(args)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let pda2 = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    // Account #7 — identity-only (no signer, writable or derivation check
    // applies); its key becomes the TokenMetadata CONTENT authority.
    let metadata_update_authority = next_account_info(iter)?;

    // Program-id checks first: both CPI targets of this instruction.
    validation::assert_program_id(system_program, &SYSTEM_PROGRAM_ID)?;
    validation::assert_program_id(token_program, &spl_token_2022_interface::id())?;

    // PDA derivation — canonical bumps are reused below for
    // `invoke_signed` and stored in the account bodies. No ownership check on
    // PDA-1/PDA-2/mint: none exists yet; the System `CreateAccount` CPIs are
    // the enforcement (they fail on any pre-existing lamports/data/owner).
    let bump1 =
        validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    let bump2 = validation::assert_pda(
        pda2,
        &[pda::ATTESTATION_SEED, mint.key.as_ref()],
        program_id,
    )?;
    // PDA-3 is an init parameter only (signing identity, no data) — no
    // account is passed and nothing is created for it. Same for PDA-5, which
    // I-1 does not touch.
    let (pda3, _) = pda::find_fee_authority_address(mint.key, program_id);

    // Writable status.
    validation::assert_writable(mint)?;
    validation::assert_writable(pda1)?;
    validation::assert_writable(pda2)?;
    validation::assert_writable(payer)?;

    // Signer status — deployer tier: the new mint keypair and the
    // payer. Authority match is N/A at I-1 (module docs above).
    validation::assert_signer(mint)?;
    validation::assert_signer(payer)?;

    let rent = Rent::get()?;

    // Mint account allocation (in-handler): plain `invoke` — mint and payer
    // signatures pass through from the transaction.
    //
    // Final-size funding: the account is ALLOCATED at the four-extension size;
    // the TokenMetadata TLV is variable-length and arrives via the processor's
    // realloc at the Initialize below, which requires lamports >=
    // minimum_balance(final size) — funded here at exact equality. The final
    // size composes from Token-2022's own embedded-TLV framing — the SAME
    // public terms the processor's length arithmetic sums (2-byte
    // `ExtensionType` + 2-byte `Length`; NOT the standalone-TLV `tlv_size_of`,
    // which assumes a 12-byte entry header and overestimates by 8) — plus the
    // metadata's borsh packed length (the metadata crate's own packed-length
    // semantics). No hand-coded size constants. The CHECKED conversion rejects
    // a default-pubkey update authority: the unchecked wrap would silently
    // null the CONTENT authority, leaving the metadata immutable from genesis.
    // Fee-ceiling business check: a basis-points ceiling above Token-2022's
    // own bound on a rate could never be reached by I-6, so it is refused at
    // genesis rather than stored as a promise the chain cannot keep. The
    // absolute ceiling is any u64; zero means no fee is ever charged.
    if args.fee_ceiling_basis_points > 10_000 {
        return Err(DdcError::FeeCeilingInvalid.into());
    }

    // The conforming genesis: a Confidential Transfer mint authority of none,
    // which makes automatic approval and the absent auditor key permanent,
    // and three distinct co-signer keys. Both are refused before any account
    // is created. A fork that departs from either changes these checks in its
    // own code and discloses it in its own specification.
    if args.confidential_transfer_mint_authority.is_some() {
        return Err(DdcError::ConfidentialTransferAuthorityNotNone.into());
    }
    validation::assert_distinct_co_signers(
        &args.issuer_authority,
        &args.operator_authority,
        &args.reserve_authority,
    )?;

    let token_metadata = TokenMetadata {
        update_authority: Some(*metadata_update_authority.key)
            .try_into()
            .map_err(|_| ProgramError::from(DdcError::InvalidPubkey))?,
        mint: *mint.key,
        name: args.name.clone(),
        symbol: args.symbol.clone(),
        uri: args.uri.clone(),
        additional_metadata: Vec::new(),
    };
    let metadata_content_len = get_instance_packed_len(&token_metadata)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let mint_space = ExtensionType::try_calculate_account_len::<Mint>(&GENESIS_MINT_EXTENSIONS)?;
    let final_size = mint_space
        .checked_add(size_of::<ExtensionType>())
        .and_then(|n| n.checked_add(size_of::<Length>()))
        .and_then(|n| n.checked_add(metadata_content_len))
        .ok_or(ProgramError::ArithmeticOverflow)?;
    invoke(
        &system_create_account_ix(
            payer.key,
            mint.key,
            rent.minimum_balance(final_size),
            mint_space as u64,
            token_program.key,
        ),
        &[payer.clone(), mint.clone(), system_program.clone()],
    )?;

    // Extension inits: the confidential and fee three in order, then
    // MetadataPointer — `initialize_mint2` LAST. Token-2022
    // rejects the layout without ConfidentialTransferFeeConfig
    // (`InvalidExtensionCombination`).
    //
    // ConfidentialTransferMint: auto_approve_new_accounts TRUE,
    // auditor_elgamal_pubkey NONE, authority = the arg, which the check
    // above has already required to be None, so both settings are permanent.
    let ix = initialize_confidential_transfer_mint(
        token_program.key,
        mint.key,
        args.confidential_transfer_mint_authority,
        true,
        None,
    )?;
    invoke(&ix, &[mint.clone(), token_program.clone()])?;

    // TransferFeeConfig: all fee parameters zero at genesis; fee_authority =
    // PDA-3 (so no single keyholder can ever call SetTransferFee directly);
    // withdraw_withheld_authority = the arg.
    let ix = initialize_transfer_fee_config(
        token_program.key,
        mint.key,
        Some(&pda3),
        Some(&args.withdraw_withheld_authority),
        0,
        0,
    )?;
    invoke(&ix, &[mint.clone(), token_program.clone()])?;

    // ConfidentialTransferFeeConfig: both values come from the args. The
    // ElGamal key is genesis-permanent — no update instruction exists. Direct
    // pod construction: PodElGamalPubkey is a public [u8; 32] wrapper,
    // infallible.
    let ix = initialize_confidential_transfer_fee_config(
        token_program.key,
        mint.key,
        Some(args.confidential_transfer_fee_authority),
        &PodElGamalPubkey(args.withdraw_withheld_authority_elgamal_pubkey),
    )?;
    invoke(&ix, &[mint.clone(), token_program.clone()])?;

    // MetadataPointer — authority = the arg (LOCATION role, distinct from
    // the TokenMetadata CONTENT authority, account #7), metadata_address =
    // the mint itself (on-mint TokenMetadata, initialized below).
    let ix = initialize_metadata_pointer(
        token_program.key,
        mint.key,
        Some(args.metadata_pointer_authority),
        Some(*mint.key),
    )?;
    invoke(&ix, &[mint.clone(), token_program.clone()])?;

    // Mint Authority = PDA-1 (dual role); Freeze Authority None, set at
    // initialization: Token-2022 has no instruction that adds one later.
    let ix = initialize_mint2(token_program.key, mint.key, pda1.key, None, DECIMALS)?;
    invoke(&ix, &[mint.clone(), token_program.clone()])?;

    // PDA-1 create + write: only the program can sign for the PDA, so
    // `invoke_signed` over the canonical seeds (dependency-free inline
    // encoding).
    invoke_signed(
        &system_create_account_ix(
            payer.key,
            pda1.key,
            rent.minimum_balance(MINT_STATE_LEN),
            MINT_STATE_LEN as u64,
            program_id,
        ),
        &[payer.clone(), pda1.clone(), system_program.clone()],
        &[&[pda::MINT_STATE_SEED, mint.key.as_ref(), &[bump1]]],
    )?;
    {
        let mut data = pda1.try_borrow_mut_data()?;
        MintState {
            pause_active: false,
            issuer_authority: args.issuer_authority,
            operator_authority: args.operator_authority,
            reserve_authority: args.reserve_authority,
            minimum_fee: 0,
            fee_ceiling_basis_points: args.fee_ceiling_basis_points,
            fee_ceiling_base_units: args.fee_ceiling_base_units,
            reserved: [0u8; 54],
            bump: bump1,
        }
        .save(&mut data)?;
    }

    // PDA-2 create + write via `AttestationRecord::save` — never raw zero
    // bytes: discriminator + zero-valued fields + canonical
    // bump, `attestor_pubkey == default` as the no-attestation-yet sentinel.
    invoke_signed(
        &system_create_account_ix(
            payer.key,
            pda2.key,
            rent.minimum_balance(ATTESTATION_RECORD_LEN),
            ATTESTATION_RECORD_LEN as u64,
            program_id,
        ),
        &[payer.clone(), pda2.clone(), system_program.clone()],
        &[&[pda::ATTESTATION_SEED, mint.key.as_ref(), &[bump2]]],
    )?;
    {
        let mut data = pda2.try_borrow_mut_data()?;
        AttestationRecord {
            attested_reserve_amount: 0,
            attestation_timestamp: 0,
            attestor_pubkey: Pubkey::default(),
            attestation_uri: [0u8; 128],
            bump: bump2,
        }
        .save(&mut data)?;
    }

    // On-mint TokenMetadata Initialize — the fifth genesis extension.
    // metadata account = the mint itself (the self-referential pointer set
    // above); update authority = account #7 (CONTENT role); mint
    // authority = PDA-1 signing via `invoke_signed`, the same pattern
    // as I-2's MintTo. Token-2022 reallocs the mint to the final size here —
    // rent was pre-funded at allocation.
    let ix = initialize_token_metadata(
        token_program.key,
        mint.key,
        metadata_update_authority.key,
        mint.key,
        pda1.key,
        token_metadata.name,
        token_metadata.symbol,
        token_metadata.uri,
    );
    invoke_signed(
        &ix,
        &[
            mint.clone(),
            metadata_update_authority.clone(),
            pda1.clone(),
            token_program.clone(),
        ],
        &[&[pda::MINT_STATE_SEED, mint.key.as_ref(), &[bump1]]],
    )?;

    Ok(())
}
