//! Program-derived account state: PDA-1 `MintState` and PDA-2 `AttestationRecord`.
//! PDA-3 and PDA-5 are signing identities with no account data and therefore
//! have no struct here.
//!
//! **Account discriminators are counted INSIDE the space totals (178/185),
//! not on top of them.** The space formulas begin with the 8:
//! `178 = 8 + 1 + 32×3 + 8 + 2 + 8 + 54 + 1` and `185 = 8 + 8 + 8 + 32 + 128 + 1` —
//! the leading 8 is the Anchor-style account discriminator,
//! `SHA-256("account:{PascalCaseName}")[0..8]`, stored as the first 8 bytes of
//! account data. On-chain account size == the `*_LEN` constants below, exactly.
//!
//! Serialization: borsh for the struct body (fixed-size fields only, so the
//! serialized body length is constant), preceded by the 8-byte discriminator.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// `SHA-256("account:MintState")[0..8]` — verified by unit test below against a
/// second implementation (sha2 crate) of the same derivation.
pub const MINT_STATE_DISCRIMINATOR: [u8; 8] = [0x51, 0x11, 0x8f, 0x78, 0x17, 0x39, 0x16, 0x75];

/// `SHA-256("account:AttestationRecord")[0..8]` — verified by unit test below.
pub const ATTESTATION_RECORD_DISCRIMINATOR: [u8; 8] =
    [0x21, 0x89, 0x0d, 0xc1, 0x27, 0xe8, 0xd8, 0x3f];

/// PDA-1 total account size — discriminator included in the total:
///
/// | field               | bytes |
/// |---------------------|-------|
/// | account discriminator | 8   |
/// | `pause_active: bool`  | 1   |
/// | `issuer_authority`    | 32  |
/// | `operator_authority`  | 32  |
/// | `reserve_authority` | 32 |
/// | `minimum_fee: u64`    | 8   |
/// | `fee_ceiling_basis_points: u16` | 2 |
/// | `fee_ceiling_base_units: u64` | 8 |
/// | `reserved: [u8; 54]`  | 54  |
/// | `bump: u8`            | 1   |
/// | **total**             | **178** |
pub const MINT_STATE_LEN: usize = 8 + 1 + 32 + 32 + 32 + 8 + 2 + 8 + 54 + 1;

/// PDA-2 total account size — discriminator included in the total:
///
/// | field                        | bytes |
/// |------------------------------|-------|
/// | account discriminator        | 8     |
/// | `attested_reserve_amount: u64` | 8   |
/// | `attestation_timestamp: i64` | 8     |
/// | `attestor_pubkey`            | 32    |
/// | `attestation_uri: [u8; 128]` | 128   |
/// | `bump: u8`                   | 1     |
/// | **total**                    | **185** |
pub const ATTESTATION_RECORD_LEN: usize = 8 + 8 + 8 + 32 + 128 + 1;

/// PDA-1 — MintState. Dual role: state storage (these fields) and the mint's
/// Mint Authority / CPI signer via `invoke_signed`.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MintState {
    pub pause_active: bool,
    pub issuer_authority: Pubkey,
    pub operator_authority: Pubkey,
    pub reserve_authority: Pubkey,
    /// Client-policy parameter of record only — NOT program-enforced on
    /// transfers: a floor is inexpressible in
    /// `PercentageWithCapProof` semantics. Written by I-6.
    pub minimum_fee: u64,
    /// Genesis-settled ceiling on `fee_basis_points`, in basis points, at
    /// most 10_000. Written by I-1 only; no instruction changes it. I-6
    /// refuses a rate above it (`FeeAboveCeiling`). Occupies the first 2 of
    /// the formerly reserved bytes.
    pub fee_ceiling_basis_points: u16,
    /// Genesis-settled ceiling on `maximum_fee`, in base units. Written by
    /// I-1 only; no instruction changes it. I-6 refuses a maximum above it
    /// (`MaximumFeeAboveCeiling`); with the I-6 `minimum <= maximum` check
    /// this also bounds `minimum_fee`. Occupies the next 8 of the formerly
    /// reserved bytes.
    pub fee_ceiling_base_units: u64,
    /// Zeroed at init. Reserved: not read or written by any current
    /// instruction; 54 bytes remain after the two fee ceilings above took 10.
    pub reserved: [u8; 54],
    pub bump: u8,
}

/// PDA-2 — AttestationRecord. Public transparency record, overwritten by each
/// I-7 call. **Not a mint gate: no other instruction reads this account, and
/// I-2 must never depend on it.**
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AttestationRecord {
    /// The value of the reserve expressed in the currency's unit of account
    /// (for a currency pegged to a national currency, that currency unit; for
    /// one anchored to a basket or a commodity, the unit of that anchor), in
    /// the currency's base units. The program records the figure and does not
    /// check it.
    pub attested_reserve_amount: u64,
    /// The cluster clock when the statement was published, not the time the
    /// reserve was measured; the document at the URI states that time and the
    /// method of valuation.
    pub attestation_timestamp: i64,
    pub attestor_pubkey: Pubkey,
    /// Zero-padded to fixed width; the variable-length instruction argument is
    /// validated to <= 128 bytes before padding (I-7).
    pub attestation_uri: [u8; 128],
    pub bump: u8,
}

/// Shared load/save behavior: 8-byte discriminator check, then exact-size borsh.
macro_rules! impl_account_io {
    ($ty:ty, $disc:expr, $len:expr) => {
        impl $ty {
            /// Deserialize from account data. Errors:
            /// - wrong length or discriminator mismatch (including an all-zero,
            ///   never-initialized account) -> `ProgramError::InvalidAccountData`
            pub fn load(data: &[u8]) -> Result<Self, ProgramError> {
                if data.len() != $len || data[..8] != $disc {
                    return Err(ProgramError::InvalidAccountData);
                }
                Self::try_from_slice(&data[8..]).map_err(|_| ProgramError::InvalidAccountData)
            }

            /// Serialize into account data, writing the discriminator first.
            /// The serialized body is fixed-size, so any length mismatch is a
            /// program bug surfaced as `InvalidAccountData` rather than silent
            /// truncation.
            pub fn save(&self, data: &mut [u8]) -> Result<(), ProgramError> {
                let body = borsh::to_vec(self).map_err(|_| ProgramError::InvalidAccountData)?;
                if data.len() != $len || 8 + body.len() != $len {
                    return Err(ProgramError::InvalidAccountData);
                }
                data[..8].copy_from_slice(&$disc);
                data[8..].copy_from_slice(&body);
                Ok(())
            }
        }
    };
}

impl_account_io!(MintState, MINT_STATE_DISCRIMINATOR, MINT_STATE_LEN);
impl_account_io!(
    AttestationRecord,
    ATTESTATION_RECORD_DISCRIMINATOR,
    ATTESTATION_RECORD_LEN
);

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn account_discriminator(name: &str) -> [u8; 8] {
        let hash = Sha256::digest(format!("account:{name}").as_bytes());
        hash[..8].try_into().unwrap()
    }

    #[test]
    fn account_discriminators_match_rederivation() {
        assert_eq!(MINT_STATE_DISCRIMINATOR, account_discriminator("MintState"));
        assert_eq!(
            ATTESTATION_RECORD_DISCRIMINATOR,
            account_discriminator("AttestationRecord")
        );
    }

    #[test]
    fn space_constants_match_spec() {
        assert_eq!(MINT_STATE_LEN, 178);
        assert_eq!(ATTESTATION_RECORD_LEN, 185);
    }

    fn sample_mint_state() -> MintState {
        MintState {
            pause_active: false,
            issuer_authority: Pubkey::new_unique(),
            operator_authority: Pubkey::new_unique(),
            reserve_authority: Pubkey::new_unique(),
            minimum_fee: 0,
            fee_ceiling_basis_points: 100,
            fee_ceiling_base_units: 1_000_000,
            reserved: [0u8; 54],
            bump: 254,
        }
    }

    fn sample_attestation() -> AttestationRecord {
        AttestationRecord {
            attested_reserve_amount: 1_000_000,
            attestation_timestamp: 1_780_000_000,
            attestor_pubkey: Pubkey::new_unique(),
            attestation_uri: [7u8; 128],
            bump: 253,
        }
    }

    #[test]
    fn serialized_sizes_equal_len_constants_exactly() {
        // Discriminator (8) + borsh body must fill the totals with no slack:
        // proves the discriminator is inside 178/185, not on top.
        let body = borsh::to_vec(&sample_mint_state()).unwrap();
        assert_eq!(8 + body.len(), MINT_STATE_LEN);
        let body = borsh::to_vec(&sample_attestation()).unwrap();
        assert_eq!(8 + body.len(), ATTESTATION_RECORD_LEN);
    }

    #[test]
    fn save_load_round_trip() {
        let state = sample_mint_state();
        let mut data = vec![0u8; MINT_STATE_LEN];
        state.save(&mut data).unwrap();
        assert_eq!(data[..8], MINT_STATE_DISCRIMINATOR);
        assert_eq!(MintState::load(&data).unwrap(), state);

        let rec = sample_attestation();
        let mut data = vec![0u8; ATTESTATION_RECORD_LEN];
        rec.save(&mut data).unwrap();
        assert_eq!(data[..8], ATTESTATION_RECORD_DISCRIMINATOR);
        assert_eq!(AttestationRecord::load(&data).unwrap(), rec);
    }

    #[test]
    fn load_rejects_wrong_discriminator_and_wrong_length() {
        // Never-initialized (all-zero) account data.
        let zeroed = vec![0u8; MINT_STATE_LEN];
        assert_eq!(
            MintState::load(&zeroed),
            Err(ProgramError::InvalidAccountData)
        );
        // Cross-discriminator confusion: AttestationRecord bytes fed to MintState.
        let mut data = vec![0u8; ATTESTATION_RECORD_LEN];
        sample_attestation().save(&mut data).unwrap();
        assert_eq!(
            MintState::load(&data),
            Err(ProgramError::InvalidAccountData)
        );
        // Truncated data.
        let mut data = vec![0u8; MINT_STATE_LEN];
        sample_mint_state().save(&mut data).unwrap();
        assert_eq!(
            MintState::load(&data[..MINT_STATE_LEN - 1]),
            Err(ProgramError::InvalidAccountData)
        );
    }
}
