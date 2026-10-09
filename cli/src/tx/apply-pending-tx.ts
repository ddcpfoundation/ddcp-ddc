// Apply-pending transaction assembly — the ONE-instruction path that folds a
// token account's pending confidential credits into its available balance.
// Ordinary blockhash, single signer, self-pay.
//
// OFFLINE AND DETERMINISTIC, WHICH ITS SIBLING IS NOT — and the second half is
// TRUE ONLY BECAUSE OF THIS MODULE'S SIGNATURE. There is no proof here, so the
// randomness that makes tx/confidential-setup-tx.ts unpinnable is absent. But
// the AES write is ALSO randomized: the same figure under the same key encrypts
// to different bytes every call. This module therefore RECEIVES the 36
// ciphertext bytes and NEVER ENCRYPTS. Move the encryption inside and the
// module becomes non-deterministic again, and the sibling test's pinned vector
// starts failing on its second run for a reason nobody will find.
//
// THE INSTRUCTION IS `getApplyConfidentialPendingBalanceInstruction`, AND A
// NEAR-TWIN SITS ONE WORD AWAY. Upstream also ships
// `getApplyConfidentialPendingBurnInstruction`, which belongs to
// ConfidentialMintBurn — an extension this mint does not carry and whose
// adoption is still an open genesis decision. Selecting it compiles clean and
// fails ON-CHAIN. Same shape as the ConfidentialTransferFee 16 against
// ConfidentialTransferFeeAmount 17 trap on the setup path, and it earns the
// same defense: the sibling test asserts the DISCRIMINATOR PAIR 27 and 8 off
// encoded bytes, never this function's name.
//
// ONE SIGNER, TWO ROLES: fee payer and ConfigureAccount-era `authority`, which
// here is the token account's owner. No separate `owner` parameter, for the
// reason the setup module states at length — taking one signer
// makes an owner/signer mismatch unrepresentable rather than merely unchecked.
//
// NO ComputeBudget INSTRUCTION OF ANY KIND. `SetComputeUnitPrice` must never
// appear in a DDC transaction and the sibling test asserts its absence.
// `SetComputeUnitLimit` is not needed either: the raised budget the relay
// path requires is for PROOF VERIFICATION, and this instruction verifies no
// proof.
//
// THE EXPECTED COUNTER IS THE CALLER'S, READ LIVE. The chain stores the
// caller's expected value beside the actual counter at execution and compares
// NEITHER, so a raced apply succeeds and writes a copy that is short.
// Detecting that is the post-send read-back's job, not this module's; both
// figures sit on the account extension and one decode returns them.

import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getApplyConfidentialPendingBalanceInstruction,
} from "@solana-program/token-2022";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import { TOKEN_2022_PROGRAM } from "../constants.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";

export interface ApplyPendingInput {
  /** Fee payer and token-account authority. One signer, two roles. */
  signer: KeyPairSigner;
  mint: Address;
  /**
   * The 36-byte AES ciphertext of available + pending, produced by the CALLER
   * through encryptDecryptableBalance. Passed in, never computed here — see
   * the determinism note above.
   */
  newDecryptableAvailableBalance: Uint8Array;
  /** The pending-credit counter as READ from the account, immediately before assembly. */
  expectedPendingBalanceCreditCounter: bigint;
  /** Read live by the caller; this module performs no network access. */
  blockhash: BlockhashLifetime;
}

/**
 * Assemble and sign the one-instruction apply-pending transaction. Returns the
 * pre-compile message for inspection, the signed transaction, and the derived
 * associated token account address.
 */
export async function assembleApplyPendingTransaction(input: ApplyPendingInput) {
  if (input.newDecryptableAvailableBalance.length !== DECRYPTABLE_BALANCE_BYTES) {
    throw new Error(
      `the new decryptable balance is ${input.newDecryptableAvailableBalance.length} bytes, not the ${DECRYPTABLE_BALANCE_BYTES} this instruction reserves`,
    );
  }

  const owner = input.signer.address;
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: input.mint,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getApplyConfidentialPendingBalanceInstruction({
          token: tokenAccount,
          authority: input.signer,
          expectedPendingBalanceCreditCounter:
            input.expectedPendingBalanceCreditCounter,
          newDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
        }),
        m,
      ),
  );

  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { tokenAccount, message, transaction };
}
