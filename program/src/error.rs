//! Program error type. Custom codes start at 6000; new variants are appended
//! and existing codes are never renumbered.
//!
//! `TokenAccountMintMismatch` (6007) is the program's own error for the
//! token-account-mint check: reusing Token-2022's `MintMismatch` would make
//! the program's explicit check indistinguishable from the CPI's own failure.
//!
//! **Error-code base 6000:** Anchor reserves custom error codes from 6000 up;
//! using the same base keeps the program consistent with the Anchor-compatible
//! discriminator convention it follows.
//!
//! **Division of labor with built-in `ProgramError` variants** — the
//! structural account checks return built-ins (implemented in `validation.rs`);
//! the business-rule failures return the customs below:
//!
//! | failure mode                              | error returned                          |
//! |-------------------------------------------|-----------------------------------------|
//! | account list shorter than the handler's   | `ProgramError::NotEnoughAccountKeys`    |
//! | account owner != expected program         | `ProgramError::InvalidAccountOwner`     |
//! | PDA key != canonical derivation           | `ProgramError::InvalidSeeds`            |
//! | required signer flag absent               | `ProgramError::MissingRequiredSignature`|
//! | account expected writable, isn't          | `ProgramError::Immutable`               |
//! | borsh args fail to deserialize            | `ProgramError::InvalidInstructionData`  |
//! | wrong program account passed (e.g. token) | `ProgramError::IncorrectProgramId`      |
//! | PDA account data malformed / wrong disc   | `ProgramError::InvalidAccountData`      |
//!
//! Authority-match failures (signer key != stored authority in PDA-1, and the
//! I-3 `source.owner != PDA-5` check) return the custom `Unauthorized`, not
//! a built-in.

use solana_program::program_error::ProgramError;

/// Custom errors: `6000..=6007` the original set, `6008..=6010` appended for
/// the genesis-settled fee ceilings, `6011..=6012` appended for the conforming
/// genesis and the distinct co-signers — existing codes are never renumbered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum DdcError {
    /// I-2 called while `pause_active == true`.
    MintPaused = 6000,
    /// Signer doesn't match the required stored authority (any signing tier),
    /// or I-3 source token account not owned by PDA-5.
    Unauthorized = 6001,
    /// I-6 with `new_minimum_fee > new_maximum_fee`.
    FeeBoundsInvalid = 6002,
    /// I-7 with `attestation_uri` longer than 128 bytes.
    InvalidAttestationUri = 6003,
    /// I-8 with `Pubkey::default()` as `new_pubkey`; I-1 with
    /// `Pubkey::default()` as the `TokenMetadata` update authority (account
    /// #7) — a default key would silently null the CONTENT authority.
    InvalidPubkey = 6004,
    /// I-8 with `role > 2`.
    InvalidRole = 6005,
    /// Instruction data shorter than 8 bytes, or an 8-byte discriminator
    /// matching no known handler — returned immediately, no fallthrough.
    InvalidInstruction = 6006,
    /// I-2 `destination` / I-3 `source` token account whose `.mint` is not the
    /// mint account supplied to the instruction (the token-account-mint
    /// check).
    TokenAccountMintMismatch = 6007,
    /// I-6 with `new_fee_basis_points` above PDA-1's
    /// `fee_ceiling_basis_points` (genesis-settled; appended after 6007).
    FeeAboveCeiling = 6008,
    /// I-6 with `new_maximum_fee` above PDA-1's `fee_ceiling_base_units`.
    MaximumFeeAboveCeiling = 6009,
    /// I-1 with `fee_ceiling_basis_points` above 10_000, Token-2022's own
    /// bound on a transfer-fee rate.
    FeeCeilingInvalid = 6010,
    /// I-1 with a Confidential Transfer mint authority other than none. The
    /// reference genesis creates only mints whose automatic approval and
    /// absent auditor key are permanent; a fork that keeps such an authority
    /// changes this check in its own code.
    ConfidentialTransferAuthorityNotNone = 6011,
    /// I-1 with issuer, operator and reserve keys that are not three distinct
    /// keys, or I-8 with a new key equal to another role's current key: one
    /// holder would then supply both signatures of a two-signature action.
    CoSignersNotDistinct = 6012,
}

impl From<DdcError> for ProgramError {
    fn from(e: DdcError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_6000_based_in_spec_table_order() {
        assert_eq!(
            ProgramError::from(DdcError::MintPaused),
            ProgramError::Custom(6000)
        );
        assert_eq!(
            ProgramError::from(DdcError::Unauthorized),
            ProgramError::Custom(6001)
        );
        assert_eq!(
            ProgramError::from(DdcError::FeeBoundsInvalid),
            ProgramError::Custom(6002)
        );
        assert_eq!(
            ProgramError::from(DdcError::InvalidAttestationUri),
            ProgramError::Custom(6003)
        );
        assert_eq!(
            ProgramError::from(DdcError::InvalidPubkey),
            ProgramError::Custom(6004)
        );
        assert_eq!(
            ProgramError::from(DdcError::InvalidRole),
            ProgramError::Custom(6005)
        );
        assert_eq!(
            ProgramError::from(DdcError::InvalidInstruction),
            ProgramError::Custom(6006)
        );
        assert_eq!(
            ProgramError::from(DdcError::TokenAccountMintMismatch),
            ProgramError::Custom(6007)
        );
        assert_eq!(
            ProgramError::from(DdcError::FeeAboveCeiling),
            ProgramError::Custom(6008)
        );
        assert_eq!(
            ProgramError::from(DdcError::MaximumFeeAboveCeiling),
            ProgramError::Custom(6009)
        );
        assert_eq!(
            ProgramError::from(DdcError::FeeCeilingInvalid),
            ProgramError::Custom(6010)
        );
        assert_eq!(
            ProgramError::from(DdcError::ConfidentialTransferAuthorityNotNone),
            ProgramError::Custom(6011)
        );
        assert_eq!(
            ProgramError::from(DdcError::CoSignersNotDistinct),
            ProgramError::Custom(6012)
        );
    }
}
