//! The account validation checks, as explicit helpers. Anchor generates
//! these implicitly; in native Rust every check is written out and **a missing
//! check is an audit finding**. Each helper returns the built-in `ProgramError`
//! documented in `error.rs`'s mapping table, except the custom variants:
//! authority-stage failures (`assert_authority`,
//! `assert_token_account_owner_field`) use `Unauthorized`, and
//! `assert_token_account_mint` uses `TokenAccountMintMismatch`.
//! `assert_distinct_co_signers` is a business rule, not an account check, and
//! returns `CoSignersNotDistinct`; it lives here so I-1 and I-8 share one copy.

use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use spl_token_2022_interface::extension::StateWithExtensions;
use spl_token_2022_interface::state::Account as TokenAccount;

use crate::error::DdcError;

/// Signer status: the account must have signed the transaction.
pub fn assert_signer(info: &AccountInfo) -> Result<(), ProgramError> {
    if !info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

/// Writable status: the account must be marked writable.
pub fn assert_writable(info: &AccountInfo) -> Result<(), ProgramError> {
    if !info.is_writable {
        return Err(ProgramError::Immutable);
    }
    Ok(())
}

/// Account ownership: the account must be owned by the expected program.
pub fn assert_owned_by(info: &AccountInfo, expected_owner: &Pubkey) -> Result<(), ProgramError> {
    if info.owner != expected_owner {
        return Err(ProgramError::InvalidAccountOwner);
    }
    Ok(())
}

/// PDA derivation: the account key must match the canonical
/// `find_program_address` derivation. Returns the bump for `invoke_signed`.
pub fn assert_pda(
    info: &AccountInfo,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Result<u8, ProgramError> {
    let (expected, bump) = Pubkey::find_program_address(seeds, program_id);
    if *info.key != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

/// Authority match: the account must (a) be a transaction signer and
/// (b) match the authority pubkey stored in PDA-1. (a) fails with the built-in
/// `MissingRequiredSignature`; (b) fails with the custom `Unauthorized`.
pub fn assert_authority(info: &AccountInfo, expected: &Pubkey) -> Result<(), ProgramError> {
    assert_signer(info)?;
    if info.key != expected {
        return Err(DdcError::Unauthorized.into());
    }
    Ok(())
}

/// Program-account identity: the supplied program account's key
/// must be the expected program (e.g. canonical Token-2022 before a CPI).
pub fn assert_program_id(info: &AccountInfo, expected: &Pubkey) -> Result<(), ProgramError> {
    if info.key != expected {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Token account mint: deserialize the token account via the interface
/// crate's own types; `.mint` must equal the mint account supplied to the
/// instruction. Fails with the dedicated `TokenAccountMintMismatch`
/// rather than Token-2022's `MintMismatch`, so tests can prove the
/// program's explicit check fired and not the CPI's.
pub fn assert_token_account_mint(info: &AccountInfo, mint: &Pubkey) -> Result<(), ProgramError> {
    let data = info.try_borrow_data()?;
    let token_account = StateWithExtensions::<TokenAccount>::unpack(&data[..])?;
    if token_account.base.mint != *mint {
        return Err(DdcError::TokenAccountMintMismatch.into());
    }
    Ok(())
}

/// Token-account `.owner` FIELD check (I-3's FINAL authority-stage
/// check): deserialize via the interface crate's own types;
/// the account's stored owner must equal the expected authority (PDA-5 in
/// I-3). Distinct from `assert_owned_by`, which checks the ACCOUNT-level
/// `AccountInfo.owner` (the owning program) at the ownership stage — the two
/// must never be conflated. Fails with the custom `Unauthorized`.
///
/// Deliberately a second self-contained unpack rather than sharing
/// `assert_token_account_mint`'s: unpack is zero-copy pod casting (negligible
/// CU on a 2-of-2 admin path), and one named call per checklist row keeps
/// each check greppable audit evidence (a missing check is an audit
/// finding).
pub fn assert_token_account_owner_field(
    info: &AccountInfo,
    expected: &Pubkey,
) -> Result<(), ProgramError> {
    let data = info.try_borrow_data()?;
    let token_account = StateWithExtensions::<TokenAccount>::unpack(&data[..])?;
    if token_account.base.owner != *expected {
        return Err(DdcError::Unauthorized.into());
    }
    Ok(())
}

/// The issuer, operator and reserve keys must be three distinct keys. I-1
/// checks the keys it is given; I-8 checks the three as they stand after the
/// replacement, so replacing a key with itself stays permitted while making
/// two roles share one key is refused. Two roles on one key would let a
/// single holder supply both signatures of a two-signature action.
pub fn assert_distinct_co_signers(
    issuer: &Pubkey,
    operator: &Pubkey,
    reserve: &Pubkey,
) -> Result<(), ProgramError> {
    if issuer == operator || issuer == reserve || operator == reserve {
        return Err(DdcError::CoSignersNotDistinct.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_co_signers_accepts_three_distinct_keys() {
        let (a, b, c) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        assert_eq!(assert_distinct_co_signers(&a, &b, &c), Ok(()));
    }

    #[test]
    fn distinct_co_signers_refuses_each_shared_pair_and_all_three() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let refused = Err(ProgramError::Custom(6012));
        assert_eq!(assert_distinct_co_signers(&a, &a, &b), refused); // issuer = operator
        assert_eq!(assert_distinct_co_signers(&a, &b, &a), refused); // issuer = reserve
        assert_eq!(assert_distinct_co_signers(&b, &a, &a), refused); // operator = reserve
        assert_eq!(assert_distinct_co_signers(&a, &a, &a), refused); // all three
    }

    fn account_info<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        is_writable: bool,
        owner: &'a Pubkey,
        lamports: &'a mut u64,
        data: &'a mut [u8],
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, is_signer, is_writable, lamports, data, owner, false)
    }

    #[test]
    fn signer_and_writable_checks() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&key, false, false, &owner, &mut lamports, &mut data);
        assert_eq!(
            assert_signer(&info),
            Err(ProgramError::MissingRequiredSignature)
        );
        assert_eq!(assert_writable(&info), Err(ProgramError::Immutable));

        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&key, true, true, &owner, &mut lamports, &mut data);
        assert_eq!(assert_signer(&info), Ok(()));
        assert_eq!(assert_writable(&info), Ok(()));
    }

    #[test]
    fn ownership_check() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&key, false, false, &owner, &mut lamports, &mut data);
        assert_eq!(assert_owned_by(&info, &owner), Ok(()));
        assert_eq!(
            assert_owned_by(&info, &other),
            Err(ProgramError::InvalidAccountOwner)
        );
    }

    #[test]
    fn pda_check_returns_bump_or_invalid_seeds() {
        let program_id = crate::id();
        let mint = Pubkey::new_unique();
        let (pda, expected_bump) = crate::pda::find_mint_state_address(&mint, &program_id);
        let owner = program_id;

        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&pda, false, false, &owner, &mut lamports, &mut data);
        let bump = assert_pda(
            &info,
            &[crate::pda::MINT_STATE_SEED, mint.as_ref()],
            &program_id,
        )
        .unwrap();
        assert_eq!(bump, expected_bump);

        let wrong = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&wrong, false, false, &owner, &mut lamports, &mut data);
        assert_eq!(
            assert_pda(
                &info,
                &[crate::pda::MINT_STATE_SEED, mint.as_ref()],
                &program_id
            ),
            Err(ProgramError::InvalidSeeds)
        );
    }

    #[test]
    fn program_id_check() {
        let expected = spl_token_2022_interface::id();
        let other = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&expected, false, false, &owner, &mut lamports, &mut data);
        assert_eq!(assert_program_id(&info, &expected), Ok(()));

        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&other, false, false, &owner, &mut lamports, &mut data);
        assert_eq!(
            assert_program_id(&info, &expected),
            Err(ProgramError::IncorrectProgramId)
        );
    }

    // `assert_token_account_mint` and `assert_token_account_owner_field` have
    // no unit tests here by design: their inputs are Token-2022 account
    // bytes, which the tests take only as written by the pinned Token-2022
    // program, never hand-assembled. The
    // integration matrices cover both outcomes of each against real accounts.

    #[test]
    fn authority_check_distinguishes_missing_signature_from_unauthorized() {
        let stored_authority = Pubkey::new_unique();
        let imposter = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        // Correct key, didn't sign -> MissingRequiredSignature (built-in).
        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(
            &stored_authority,
            false,
            false,
            &owner,
            &mut lamports,
            &mut data,
        );
        assert_eq!(
            assert_authority(&info, &stored_authority),
            Err(ProgramError::MissingRequiredSignature)
        );

        // Signed, wrong key -> Unauthorized (custom 6001).
        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(&imposter, true, false, &owner, &mut lamports, &mut data);
        assert_eq!(
            assert_authority(&info, &stored_authority),
            Err(ProgramError::Custom(6001))
        );

        // Signed with the right key -> Ok.
        let mut lamports = 0u64;
        let mut data = [];
        let info = account_info(
            &stored_authority,
            true,
            false,
            &owner,
            &mut lamports,
            &mut data,
        );
        assert_eq!(assert_authority(&info, &stored_authority), Ok(()));
    }
}
