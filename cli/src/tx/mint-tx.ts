// I-2 mint transaction assembly + initiator partial-sign. OFFLINE and
// deterministic: every input arrives already resolved (the live PDA-1 and
// nonce reads are the command layer's job);
// nothing here touches the network or the filesystem.

import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Address,
  type KeyPairSigner,
  type Nonce,
} from "@solana/kit";
import { buildMintTokensInstruction } from "../instructions/mint-tokens.js";

export interface MintTxInput {
  mint: Address;
  destination: Address;
  /** PDA-1 MintState. */
  mintState: Address;
  issuerAuthority: Address;
  reserveAuthority: Address;
  token2022Program: Address;
  amount: bigint;
  nonceAccount: Address;
  nonceAuthority: Address;
  /** The nonce account's CURRENT stored nonce value, read live by the caller. */
  nonceValue: string;
  /**
   * The initiating party's signer (the issuer in real use). This one
   * key is fee payer, nonce authority, and issuer_authority, so the partial
   * sign fills exactly one signature slot and leaves the Reserve slot empty.
   */
  initiatorSigner: KeyPairSigner;
}

/**
 * Assemble the durable-nonce I-2 mint transaction and partially sign it with
 * the initiator only. Instruction 0 is the AdvanceNonceAccount that the
 * durable-nonce lifetime setter auto-prepends; instruction 1 is mint_tokens.
 * The returned transaction's Reserve signature slot is null — the countersign
 * stage fills it. Returns both the pre-compile message (inspectable) and the
 * partially-signed transaction.
 */
export async function assembleMintTokensTransaction(input: MintTxInput) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.initiatorSigner, m),
    (m) =>
      setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: input.nonceValue as Nonce,
          nonceAccountAddress: input.nonceAccount,
          nonceAuthorityAddress: input.nonceAuthority,
        },
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        buildMintTokensInstruction({
          mint: input.mint,
          destination: input.destination,
          mintState: input.mintState,
          issuerAuthority: input.issuerAuthority,
          reserveAuthority: input.reserveAuthority,
          token2022Program: input.token2022Program,
          amount: input.amount,
        }),
        m,
      ),
  );
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { message, transaction };
}
