// Generic durable-nonce admin-transaction assembly + initiator partial-sign
// — the same pipe shape as tx/mint-tx.ts but instruction-agnostic;
// mint-tx.ts keeps its own assembly and does not delegate
// here. OFFLINE and deterministic: the live PDA-1 and nonce reads are the
// command layer's job; nothing here touches the network or the filesystem.

import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Nonce,
} from "@solana/kit";

export interface DurableNonceParams {
  nonceAccount: Address;
  nonceAuthority: Address;
  /** The nonce account's CURRENT stored nonce value, read live by the caller. */
  nonceValue: string;
}

/**
 * Assemble a durable-nonce admin transaction around ONE instruction and
 * partially sign it with the fee payer only. Instruction 0 is the
 * AdvanceNonceAccount the durable-nonce lifetime setter auto-prepends;
 * instruction 1 is the passed instruction. Returns both the pre-compile
 * message (inspectable) and the partially-signed transaction.
 */
export async function assembleDurableNonceTransaction(
  instruction: Instruction,
  nonce: DurableNonceParams,
  feePayerSigner: KeyPairSigner,
) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayerSigner, m),
    (m) =>
      setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: nonce.nonceValue as Nonce,
          nonceAccountAddress: nonce.nonceAccount,
          nonceAuthorityAddress: nonce.nonceAuthority,
        },
        m,
      ),
    (m) => appendTransactionMessageInstruction(instruction, m),
  );
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { message, transaction };
}
