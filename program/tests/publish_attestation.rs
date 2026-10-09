//! I-7 publish_attestation integration suite (LiteSVM, real .so). Covers the
//! Reserve-only tier, the borsh Vec<u8> URI contract with zero-padding, Clock-
//! sourced timestamps, overwrite semantics, strict/truncated args, and the
//! cross-mint PDA-pairing hazard the mint account exists to close.

mod common;

use common::*;
use ddcp_ddc::instruction::PublishAttestationArgs;
use solana_program::clock::Clock;
use solana_program::instruction::InstructionError;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;

fn args_bytes(amount: u64, uri: &[u8]) -> Vec<u8> {
    borsh::to_vec(&PublishAttestationArgs {
        attested_reserve_amount: amount,
        attestation_uri: uri.to_vec(),
    })
    .unwrap()
}

fn set_timestamp(svm: &mut litesvm::LiteSVM, unix_timestamp: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar::<Clock>(&clock);
}

#[test]
fn publish_writes_full_record_from_clock_and_signer() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    set_timestamp(&mut ctx.svm, 1_753_000_000);

    let uri = b"https://example.org/attestations/2026-07.json";
    let ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(42_000_000_000_000, uri),
    );
    let state_before = read_mint_state(&ctx.svm, &ctx.pda1);
    send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]).unwrap();

    let rec = read_attestation(&ctx.svm, &pda2);
    assert_eq!(rec.attested_reserve_amount, 42_000_000_000_000);
    assert_eq!(rec.attestation_timestamp, 1_753_000_000); // Clock, not args
    assert_eq!(rec.attestor_pubkey, reserve.pubkey()); // signer, not args
    assert_eq!(&rec.attestation_uri[..uri.len()], uri);
    assert!(
        rec.attestation_uri[uri.len()..].iter().all(|b| *b == 0),
        "URI tail must be zero-padded"
    );
    let (_, canonical_bump) =
        ddcp_ddc::pda::find_attestation_address(&ctx.mint, &ddcp_ddc::id());
    assert_eq!(rec.bump, canonical_bump);

    // PDA-1 untouched by I-7.
    assert_eq!(read_mint_state(&ctx.svm, &ctx.pda1), state_before);
}

#[test]
fn publish_overwrites_previous_record_wholesale() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    let payer = ctx.payer.insecure_clone();

    set_timestamp(&mut ctx.svm, 1_000);
    let first = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(111, b"https://a.example/1"),
    );
    send(&mut ctx.svm, &payer, first, &[&reserve]).unwrap();

    set_timestamp(&mut ctx.svm, 2_000);
    let second = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(222, b"short"),
    );
    send(&mut ctx.svm, &payer, second, &[&reserve]).unwrap();

    let rec = read_attestation(&ctx.svm, &pda2);
    assert_eq!(rec.attested_reserve_amount, 222);
    assert_eq!(rec.attestation_timestamp, 2_000);
    assert_eq!(&rec.attestation_uri[..5], b"short");
    // No residue of the longer first URI beyond the new content.
    assert!(rec.attestation_uri[5..].iter().all(|b| *b == 0));
}

#[test]
fn uri_of_exactly_128_bytes_is_accepted() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    let uri = [b'u'; 128];
    let ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(1, &uri),
    );
    send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]).unwrap();
    assert_eq!(read_attestation(&ctx.svm, &pda2).attestation_uri, uri);
}

#[test]
fn uri_of_129_bytes_is_invalid_attestation_uri() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    let uri = [b'u'; 129];
    let ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(1, &uri),
    );
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]);
    assert_custom(res, 6003); // InvalidAttestationUri
}

#[test]
fn empty_uri_is_accepted() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    let ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(7, b""),
    );
    send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]).unwrap();
    let rec = read_attestation(&ctx.svm, &pda2);
    assert_eq!(rec.attested_reserve_amount, 7);
    assert_eq!(rec.attestation_uri, [0u8; 128]);
}

#[test]
fn issuer_signer_is_unauthorized() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let issuer = ctx.issuer.insecure_clone();
    let ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &issuer.pubkey(),
        args_bytes(1, b"x"),
    );
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&issuer]);
    assert_custom(res, 6001); // Unauthorized — Issuer co-signature would be circular
}

#[test]
fn operator_signer_is_unauthorized() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let operator = ctx.operator.insecure_clone();
    let ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &operator.pubkey(),
        args_bytes(1, b"x"),
    );
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&operator]);
    assert_custom(res, 6001);
}

#[test]
fn reserve_present_but_not_signing() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let mut ix = publish_ix(
        &ctx.mint,
        &pda2,
        &ctx.pda1,
        &ctx.reserve.pubkey(),
        args_bytes(1, b"x"),
    );
    ix.accounts[3].is_signer = false;
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[]);
    assert_eq!(res, Err(InstructionError::MissingRequiredSignature));
}

#[test]
fn cross_mint_pda_pairing_fails_invalid_seeds() {
    // Mint A's PDA-1 (whose Reserve signs) with mint B's PDA-2: without the shared
    // mint seed check, this would write an attestation into another mint's
    // record. The derivation check must kill it.
    let mut ctx = setup(false); // mint A
    let mint_b = Pubkey::new_unique();
    let pda2_b = seed_attestation_zeroed(&mut ctx.svm, &mint_b);
    let reserve = ctx.reserve.insecure_clone();
    let ix = publish_ix(
        &ctx.mint,
        &pda2_b,
        &ctx.pda1,
        &reserve.pubkey(),
        args_bytes(1, b"x"),
    );
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]);
    assert_eq!(res, Err(InstructionError::InvalidSeeds));
    // Mint B's record untouched.
    let rec_b = read_attestation(&ctx.svm, &pda2_b);
    assert_eq!(rec_b.attestor_pubkey, Pubkey::default());
}

#[test]
fn truncated_args_are_invalid_instruction_data() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    let mut bytes = args_bytes(1, b"hello");
    bytes.truncate(bytes.len() - 3); // cut the URI vector short
    let ix = publish_ix(&ctx.mint, &pda2, &ctx.pda1, &reserve.pubkey(), bytes);
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

#[test]
fn trailing_args_are_invalid_instruction_data() {
    let mut ctx = setup(false);
    let pda2 = seed_attestation_zeroed(&mut ctx.svm, &ctx.mint);
    let reserve = ctx.reserve.insecure_clone();
    let mut bytes = args_bytes(1, b"hello");
    bytes.push(0xEE); // strict-args: exact consumption required
    let ix = publish_ix(&ctx.mint, &pda2, &ctx.pda1, &reserve.pubkey(), bytes);
    let res = send(&mut ctx.svm, &ctx.payer.insecure_clone(), ix, &[&reserve]);
    assert_eq!(res, Err(InstructionError::InvalidInstructionData));
}

// Sanity: PublishAttestationArgs on the wire is length-prefixed (Vec<u8>), the
// binding client contract.
#[test]
fn wire_format_is_length_prefixed_vec() {
    let bytes = borsh::to_vec(&PublishAttestationArgs {
        attested_reserve_amount: 5,
        attestation_uri: b"abc".to_vec(),
    })
    .unwrap();
    assert_eq!(&bytes[..8], &5u64.to_le_bytes());
    assert_eq!(&bytes[8..12], &3u32.to_le_bytes()); // u32 LE length prefix
    assert_eq!(&bytes[12..], b"abc");
}
