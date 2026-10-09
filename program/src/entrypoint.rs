//! Program entrypoint. Kept to a single delegation so all dispatch logic lives
//! in `processor::process`, which is unit-testable without the entrypoint
//! macro's runtime scaffolding. Gated behind `no-entrypoint` in lib.rs so
//! client crates can depend on the types without an entrypoint symbol clash.

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    crate::processor::process(program_id, accounts, instruction_data)
}
