//! Instruction discriminators and argument types.
//!
//! **Discriminator convention:** Anchor-compatible — the first 8 bytes
//! of instruction data are `SHA-256("global:{snake_case_name}")[0..8]`. The
//! entrypoint matches these bytes before any deserialization; an unrecognized
//! discriminator returns `InvalidInstruction` immediately, no fallthrough.
//! Constants below were computed externally (Python hashlib, 2026-07-10) and
//! are re-derived in unit tests with the `sha2` crate — a cross-implementation
//! check, not a copy of the same computation.
//!
//! Argument encoding: borsh, following the discriminator (Anchor-compatible).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// `SHA-256("global:initialize_mint")[0..8]`
pub const INITIALIZE_MINT_DISCRIMINATOR: [u8; 8] = [0xd1, 0x2a, 0xc3, 0x04, 0x81, 0x55, 0xd1, 0x2c];
/// `SHA-256("global:mint_tokens")[0..8]`
pub const MINT_TOKENS_DISCRIMINATOR: [u8; 8] = [0x3b, 0x84, 0x18, 0xf6, 0x7a, 0x27, 0x08, 0xf3];
/// `SHA-256("global:burn_tokens")[0..8]`
pub const BURN_TOKENS_DISCRIMINATOR: [u8; 8] = [0x4c, 0x0f, 0x33, 0xfe, 0xe5, 0xd7, 0x79, 0x42];
/// `SHA-256("global:pause_issuance")[0..8]`
pub const PAUSE_ISSUANCE_DISCRIMINATOR: [u8; 8] = [0xc7, 0x0d, 0x81, 0xec, 0x90, 0xb5, 0x8a, 0x98];
/// `SHA-256("global:resume_issuance")[0..8]`
pub const RESUME_ISSUANCE_DISCRIMINATOR: [u8; 8] = [0xe1, 0x0a, 0xd2, 0xde, 0x30, 0x20, 0x0b, 0x92];
/// `SHA-256("global:update_transfer_fee")[0..8]`
pub const UPDATE_TRANSFER_FEE_DISCRIMINATOR: [u8; 8] =
    [0x87, 0x6a, 0x39, 0x4d, 0x5d, 0xf7, 0xd2, 0x9e];
/// `SHA-256("global:publish_attestation")[0..8]`
pub const PUBLISH_ATTESTATION_DISCRIMINATOR: [u8; 8] =
    [0x77, 0x26, 0x78, 0x2d, 0x56, 0x16, 0x91, 0x37];
/// `SHA-256("global:rotate_signer")[0..8]`
pub const ROTATE_SIGNER_DISCRIMINATOR: [u8; 8] = [0xc6, 0x87, 0x35, 0x1b, 0x15, 0xcb, 0x08, 0x00];

/// I-1 `initialize_mint` arguments. The `TokenMetadata` update authority is
/// not an argument: it arrives as an account identity (account #7).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InitializeMintArgs {
    pub issuer_authority: Pubkey,
    pub operator_authority: Pubkey,
    pub reserve_authority: Pubkey,
    /// `ConfidentialTransferMint` authority. The conforming default is
    /// `None`, which makes the absence of an auditor key and automatic
    /// approval of new confidential accounts permanent for the life of the
    /// mint. I-1 refuses `Some(key)` (`ConfidentialTransferAuthorityNotNone`);
    /// a fork that needs a key changes that check in its own code. Wire:
    /// borsh `Option` — one tag byte (0x00 none, 0x01 some) then 32 bytes
    /// when present; a zero pubkey is NOT a sentinel for none.
    pub confidential_transfer_mint_authority: Option<Pubkey>,
    /// `ConfidentialTransferFeeConfig` authority, chosen by the creator.
    pub confidential_transfer_fee_authority: Pubkey,
    /// ElGamal public key under which withheld fees are encrypted. Fixed at
    /// genesis: no instruction can change it afterwards. Raw 32 bytes,
    /// converted to `PodElGamalPubkey` at the CPI boundary.
    pub withdraw_withheld_authority_elgamal_pubkey: [u8; 32],
    /// Withdraw-withheld authority: the key that may move withheld fees,
    /// chosen by the creator.
    pub withdraw_withheld_authority: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// `MetadataPointer` authority. LOCATION role — distinct from the
    /// `TokenMetadata` CONTENT update authority (account #7), which may be a
    /// different key.
    pub metadata_pointer_authority: Pubkey,
    /// Genesis-settled ceiling on the transfer-fee rate, basis points, at
    /// most 10_000 (else `FeeCeilingInvalid`). Stored in PDA-1; no
    /// instruction changes it afterwards. The reference mint's ceiling is 100.
    pub fee_ceiling_basis_points: u16,
    /// Genesis-settled ceiling on the per-transfer maximum fee, base units.
    /// Stored in PDA-1; no instruction changes it afterwards. The reference
    /// mint's ceiling is 1_000_000 (one whole unit at six decimals). Zero is a valid
    /// choice and means the currency never charges a transfer fee.
    pub fee_ceiling_base_units: u64,
}

/// I-2 `mint_tokens` arguments.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MintTokensArgs {
    pub amount: u64,
}

/// I-3 `burn_tokens` arguments.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BurnTokensArgs {
    pub amount: u64,
}

// I-4 `pause_issuance` and I-5 `resume_issuance` take no arguments.

/// I-6 `update_transfer_fee` arguments. Validation:
/// `new_minimum_fee <= new_maximum_fee`, else `FeeBoundsInvalid`.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateTransferFeeArgs {
    pub new_fee_basis_points: u16,
    pub new_maximum_fee: u64,
    pub new_minimum_fee: u64,
}

/// I-7 `publish_attestation` arguments. `attestation_uri` is variable-length
/// on the wire (borsh `Vec<u8>`), validated <= 128 bytes, then zero-padded
/// into the fixed `[u8; 128]` field of PDA-2.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PublishAttestationArgs {
    /// The reserve's value in the currency's unit of account, in base units;
    /// the rule is stated on `AttestationRecord` in `state.rs`.
    pub attested_reserve_amount: u64,
    pub attestation_uri: Vec<u8>,
}

/// I-8 `rotate_signer` arguments. Validation: `role <= 2` else
/// `InvalidRole`; `new_pubkey != Pubkey::default()` else `InvalidPubkey`.
/// Role encoding: 0 = Issuer, 1 = Operator, 2 = Reserve.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RotateSignerArgs {
    pub role: u8,
    pub new_pubkey: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn global_discriminator(name: &str) -> [u8; 8] {
        let hash = Sha256::digest(format!("global:{name}").as_bytes());
        hash[..8].try_into().unwrap()
    }

    #[test]
    fn instruction_discriminators_match_rederivation() {
        let expected: [(&str, [u8; 8]); 8] = [
            ("initialize_mint", INITIALIZE_MINT_DISCRIMINATOR),
            ("mint_tokens", MINT_TOKENS_DISCRIMINATOR),
            ("burn_tokens", BURN_TOKENS_DISCRIMINATOR),
            ("pause_issuance", PAUSE_ISSUANCE_DISCRIMINATOR),
            ("resume_issuance", RESUME_ISSUANCE_DISCRIMINATOR),
            ("update_transfer_fee", UPDATE_TRANSFER_FEE_DISCRIMINATOR),
            ("publish_attestation", PUBLISH_ATTESTATION_DISCRIMINATOR),
            ("rotate_signer", ROTATE_SIGNER_DISCRIMINATOR),
        ];
        for (name, constant) in expected {
            assert_eq!(
                constant,
                global_discriminator(name),
                "discriminator mismatch for {name}"
            );
        }
    }

    #[test]
    fn discriminators_are_pairwise_distinct() {
        let all = [
            INITIALIZE_MINT_DISCRIMINATOR,
            MINT_TOKENS_DISCRIMINATOR,
            BURN_TOKENS_DISCRIMINATOR,
            PAUSE_ISSUANCE_DISCRIMINATOR,
            RESUME_ISSUANCE_DISCRIMINATOR,
            UPDATE_TRANSFER_FEE_DISCRIMINATOR,
            PUBLISH_ATTESTATION_DISCRIMINATOR,
            ROTATE_SIGNER_DISCRIMINATOR,
        ];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "discriminator collision {i}/{j}");
            }
        }
    }

    #[test]
    fn initialize_mint_ct_authority_option_wire_bytes() {
        // Pins the borsh Option encoding of the ConfidentialTransferMint
        // authority at its wire offset (after the three 32-byte authorities),
        // so a genesis script can be checked against these bytes.
        let base = InitializeMintArgs {
            issuer_authority: Pubkey::new_from_array([1u8; 32]),
            operator_authority: Pubkey::new_from_array([2u8; 32]),
            reserve_authority: Pubkey::new_from_array([3u8; 32]),
            confidential_transfer_mint_authority: None,
            confidential_transfer_fee_authority: Pubkey::new_from_array([4u8; 32]),
            withdraw_withheld_authority_elgamal_pubkey: [5u8; 32],
            withdraw_withheld_authority: Pubkey::new_from_array([6u8; 32]),
            name: String::new(),
            symbol: String::new(),
            uri: String::new(),
            metadata_pointer_authority: Pubkey::new_from_array([7u8; 32]),
            fee_ceiling_basis_points: 100,
            fee_ceiling_base_units: 1_000_000,
        };
        let none_bytes = borsh::to_vec(&base).unwrap();
        assert_eq!(none_bytes[96], 0x00, "none tag at offset 96");
        assert_eq!(none_bytes[97], 4u8, "next field follows the tag at once");
        assert_eq!(InitializeMintArgs::try_from_slice(&none_bytes).unwrap(), base);

        let key = Pubkey::new_from_array([9u8; 32]);
        let some = InitializeMintArgs {
            confidential_transfer_mint_authority: Some(key),
            ..base.clone()
        };
        let some_bytes = borsh::to_vec(&some).unwrap();
        assert_eq!(some_bytes[96], 0x01, "some tag at offset 96");
        assert_eq!(&some_bytes[97..129], key.as_ref());
        assert_eq!(some_bytes[129], 4u8, "next field follows the 32 bytes");
        assert_eq!(some_bytes.len(), none_bytes.len() + 32);
        assert_eq!(InitializeMintArgs::try_from_slice(&some_bytes).unwrap(), some);

        // A zero pubkey is a present value, not none.
        let zero = InitializeMintArgs {
            confidential_transfer_mint_authority: Some(Pubkey::default()),
            ..base
        };
        let zero_bytes = borsh::to_vec(&zero).unwrap();
        assert_eq!(zero_bytes[96], 0x01);
        assert_ne!(zero_bytes, none_bytes);
    }

    #[test]
    fn args_round_trip_through_borsh() {
        let args = RotateSignerArgs {
            role: 2,
            new_pubkey: Pubkey::new_unique(),
        };
        let bytes = borsh::to_vec(&args).unwrap();
        assert_eq!(RotateSignerArgs::try_from_slice(&bytes).unwrap(), args);

        let args = PublishAttestationArgs {
            attested_reserve_amount: 42,
            attestation_uri: b"https://example.org/attestation.json".to_vec(),
        };
        let bytes = borsh::to_vec(&args).unwrap();
        assert_eq!(
            PublishAttestationArgs::try_from_slice(&bytes).unwrap(),
            args
        );

        let args = UpdateTransferFeeArgs {
            new_fee_basis_points: 25,
            new_maximum_fee: 1_000_000,
            new_minimum_fee: 100,
        };
        let bytes = borsh::to_vec(&args).unwrap();
        assert_eq!(UpdateTransferFeeArgs::try_from_slice(&bytes).unwrap(), args);
    }
}
