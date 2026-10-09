// The burn source check (I-3), run by the client before anything is signed.
// The program burns only from a token account that Token-2022 owns, that
// holds this mint, and whose owner field is PDA-5, the redemption authority
// (program/src/processor/burn_tokens.rs: the account-owner check, the
// token-account-mint check, and the owner-field check). A burn naming any
// other source fails on-chain, so the CLI refuses it before the issuer signs
// it at serialize and before the reserve countersigns it, rather than leaving
// the program as the only check. The program stays the control; this check
// only spares an operator a signature on a transaction that cannot succeed.
//
// Pure: the caller reads the source account and passes what it read.

import { getAddressDecoder, type Address } from "@solana/kit";

const EM_DASH = String.fromCharCode(0x2014);

/** The fields of a Token-2022 token account this check reads: mint at [0:32], owner at [32:64]. */
const TOKEN_ACCOUNT_MINT_END = 32;
const TOKEN_ACCOUNT_OWNER_END = 64;

export type BurnSourceRead =
  | { readonly exists: false }
  | { readonly exists: true; readonly programOwner: Address; readonly data: Uint8Array };

export interface BurnSourceExpectation {
  readonly source: Address;
  readonly mint: Address;
  readonly redemptionAuthority: Address;
  readonly token2022Program: Address;
}

function refusal(source: Address, redemptionAuthority: Address, cause: string): string {
  return (
    "REFUSED " + EM_DASH + " the burn source " + source + " is not the redemption-collection account: " + cause + ". " +
    "The program burns only from a Token-2022 account for this mint whose owner is the redemption authority PDA-5 " +
    redemptionAuthority + ", so this transaction could never succeed. Nothing was signed and nothing was sent. " +
    "Name the redemption-collection account as the source."
  );
}

/** Pure: the read as an RPC getAccountInfo value in base64 encoding gives it, or null for no account. */
export function toBurnSourceRead(
  info: { readonly owner: Address; readonly data: readonly [string, string] } | null,
): BurnSourceRead {
  if (info === null) return { exists: false };
  return { exists: true, programOwner: info.owner, data: Uint8Array.from(Buffer.from(info.data[0], "base64")) };
}

/** Pure: undefined when the source passes the program's three checks, otherwise the refusal sentence. */
export function decideBurnSource(read: BurnSourceRead, expect: BurnSourceExpectation): string | undefined {
  if (!read.exists) {
    return refusal(expect.source, expect.redemptionAuthority, "no account exists at that address");
  }
  if (read.programOwner !== expect.token2022Program) {
    return refusal(
      expect.source,
      expect.redemptionAuthority,
      "the account belongs to the program " + read.programOwner + ", not to Token-2022",
    );
  }
  if (read.data.length < TOKEN_ACCOUNT_OWNER_END) {
    return refusal(
      expect.source,
      expect.redemptionAuthority,
      "its data is " + read.data.length + " bytes, too short to be a token account",
    );
  }
  const decoder = getAddressDecoder();
  const mint = decoder.decode(read.data.subarray(0, TOKEN_ACCOUNT_MINT_END));
  if (mint !== expect.mint) {
    return refusal(expect.source, expect.redemptionAuthority, "it holds the mint " + mint + ", not " + expect.mint);
  }
  const owner = decoder.decode(read.data.subarray(TOKEN_ACCOUNT_MINT_END, TOKEN_ACCOUNT_OWNER_END));
  if (owner !== expect.redemptionAuthority) {
    return refusal(expect.source, expect.redemptionAuthority, "its owner is " + owner + ", not PDA-5");
  }
  return undefined;
}
