//! I-7 `publish_attestation`. Signing tier: Reserve only, 1-of-1 — the reserve
//! publishes its own statement. Writes the statement to PDA-2, overwriting the
//! prior record wholesale; full history lives in the transaction log.
//!
//! **Transparency mechanism, not a mint gate:** PDA-2 has no other consumer in
//! this program; I-2 must never read it.
//!
//! Effects: the timestamp comes from the Clock sysvar and the
//! attestor from the signer's pubkey — neither is caller-supplied. The URI
//! argument is a borsh `Vec<u8>` on the wire (length-prefixed), validated
//! `<= 128` then zero-padded into the fixed `[u8; 128]` field.
//! I-7 never creates PDA-2 — it overwrites the account I-1 initialized
//! (discriminator + zero fields + canonical bump).

use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

use crate::{
    error::DdcError,
    instruction::PublishAttestationArgs,
    pda,
    state::{AttestationRecord, MintState},
    validation,
};

/// I-7 — accounts: `mint` (read-only, seed only) · `PDA-2` (writable) ·
/// `PDA-1` (read) · `reserve_authority` (signer).
pub fn process_publish_attestation(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
) -> ProgramResult {
    // Strict args: borsh must consume the remainder exactly.
    let args = PublishAttestationArgs::try_from_slice(args)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let pda2 = next_account_info(iter)?;
    let pda1 = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;

    // Structural checks, PDA-2 first (account-list order): ownership ->
    // derivation -> writable. The shared `mint` seed makes cross-mint
    // PDA-1/PDA-2 pairing fail here with InvalidSeeds.
    validation::assert_owned_by(pda2, program_id)?;
    let pda2_bump = validation::assert_pda(
        pda2,
        &[pda::ATTESTATION_SEED, mint.key.as_ref()],
        program_id,
    )?;
    validation::assert_writable(pda2)?;

    // PDA-1 is read-only here: ownership + derivation + data integrity, no
    // writable requirement.
    validation::assert_owned_by(pda1, program_id)?;
    validation::assert_pda(pda1, &[pda::MINT_STATE_SEED, mint.key.as_ref()], program_id)?;
    let state = {
        let data = pda1.try_borrow_data()?;
        MintState::load(&data[..])?
    };

    // Signer status + authority match: Reserve 1-of-1.
    validation::assert_authority(reserve, &state.reserve_authority)?;

    // Business validation: uri length after signer match.
    if args.attestation_uri.len() > 128 {
        return Err(DdcError::InvalidAttestationUri.into());
    }

    let clock = Clock::get()?;
    let mut uri = [0u8; 128];
    uri[..args.attestation_uri.len()].copy_from_slice(&args.attestation_uri);

    let record = AttestationRecord {
        attested_reserve_amount: args.attested_reserve_amount,
        attestation_timestamp: clock.unix_timestamp,
        attestor_pubkey: *reserve.key,
        attestation_uri: uri,
        bump: pda2_bump,
    };

    // Wholesale overwrite via save (never a create — save's exact-length check
    // fails on a nonexistent/wrong-size account).
    let mut data = pda2.try_borrow_mut_data()?;
    record.save(&mut data[..])
}
