//! Library decode of a dumped Token-2022 mint account: MetadataPointer +
//! TokenMetadata, via spl-token-2022-interface's own StateWithExtensions —
//! no hand-rolled TLV walking anywhere.

use solana_program::pubkey::Pubkey;
use spl_token_2022_interface::extension::metadata_pointer::MetadataPointer;
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::Mint;
use spl_token_metadata_interface::state::TokenMetadata;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: decode-mint-metadata <mint-account-bytes.bin>");
    let data = std::fs::read(&path).expect("read mint account bytes");
    println!("account bytes: {}", data.len());

    let st = StateWithExtensions::<Mint>::unpack(&data).expect("unpack Mint + extensions");

    let mp = st
        .get_extension::<MetadataPointer>()
        .expect("MetadataPointer extension");
    println!(
        "MetadataPointer.authority        = {:?}",
        Option::<Pubkey>::from(mp.authority)
    );
    println!(
        "MetadataPointer.metadata_address = {:?}",
        Option::<Pubkey>::from(mp.metadata_address)
    );

    let tm = st
        .get_variable_len_extension::<TokenMetadata>()
        .expect("TokenMetadata extension");
    println!(
        "TokenMetadata.update_authority   = {:?}",
        Option::<Pubkey>::from(tm.update_authority)
    );
    println!("TokenMetadata.name               = {:?}", tm.name);
    println!("TokenMetadata.symbol             = {:?}", tm.symbol);
    println!("TokenMetadata.uri                = {:?}", tm.uri);
}
