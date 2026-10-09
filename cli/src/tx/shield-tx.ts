// Shield transaction assembly — the TWO-instruction path that moves a stated
// amount from a token account's PUBLIC balance into its CONFIDENTIAL balance
// (the user command is `shield`, the pair of `unshield`). Ordinary blockhash,
// single signer, self-pay.
//
// THE USER WORD IS `shield`. THE INSTRUCTION IS `Deposit`. They are different
// things and are never conflated: a holder shields; the wire carries
// ConfidentialTransferInstruction::Deposit followed by ApplyPendingBalance.
// "Deposit" is a bank word for money entering from outside, and nothing enters
// here — the amount changes side within one account the holder already owns.
//
// ONE TRANSACTION, ATOMIC: `Deposit` credits the pending limbs from the
// public balance and increments the pending-credit counter; the
// `ApplyPendingBalance` that follows it in the SAME transaction folds that
// credit into the available balance. A failed apply reverts the deposit. This
// is deposit-then-auto-apply made literal in one fee and one
// announcement, and it is why a successful shield leaves the counter at zero.
//
// THE EXPECTED COUNTER IS COMPUTED HERE, NOT BY THE CALLER. The caller passes
// the counter AS READ off the account; this module passes counter + 1 to
// ApplyPendingBalance, because the Deposit one instruction earlier is the
// credit that increments it. Taking the read value and adding one inside
// makes the forgotten increment unrepresentable rather than merely unchecked,
// and the sibling test pins the +1 off encoded bytes. The chain records the
// expected value beside the actual and compares NEITHER; the command's
// post-send read-back is what detects a race.
//
// OFFLINE AND DETERMINISTIC, on the same signature discipline as
// tx/apply-pending-tx.ts: the 36-byte AES copy of (available + amount) is
// RECEIVED and NEVER ENCRYPTED here, because the AES write is randomized.
// Move the encryption inside and the module becomes non-deterministic and
// its golden vector starts failing on its second run.
//
// THE AMOUNT CAP IS A PROTOCOL CONSTANT, SO IT IS GUARDED HERE. Every deposit
// or transfer amount is capped at MAXIMUM_DEPOSIT_TRANSFER_AMOUNT = 2^48 - 1,
// read from pinned Rust source. Above it the instruction fails on-chain after
// the fee is paid; refusing before assembly costs nothing. A zero amount is
// refused on the same ground: it would pay a fee to move nothing. Balance
// sufficiency is NOT checked here — it needs the account read the caller
// already holds, and the on-chain failure for it is a misleading
// TokenError::Overflow.
//
// `decimals` IS DDC_DECIMALS, SUPPLIED EXPLICITLY. Deposit carries the
// caller's expected decimals and the program cross-checks them against the
// mint. The value comes from amount.ts, where the instrument's decimals live,
// never from constants.ts, whose values are overridable defaults by that
// file's own header.
//
// NEAR-TWINS, ONE WORD AWAY. Upstream also exports
// `getConfidentialMintInstruction` and `getConfidentialBurnInstruction`, which
// belong to ConfidentialMintBurn — an extension this mint does NOT carry — and
// `getApplyConfidentialPendingBurnInstruction`, the burn-side twin of the
// apply. The apply twin takes the same field set, compiles clean and fails only
// ON-CHAIN; the mint twin happens to differ in fields today, an accident of
// upstream's API and not a defense. The sibling test asserts the DISCRIMINATOR
// PAIRS 27/5 and 27/8 off encoded bytes, never a function name.
//
// ONE SIGNER, TWO ROLES: fee payer and authority of the token account, which is
// its owner. No separate `owner` parameter: one signer makes an owner/signer
// mismatch unrepresentable.
//
// NO ComputeBudget INSTRUCTION OF ANY KIND. Neither instruction verifies a
// proof, so no raised budget is needed, and SetComputeUnitPrice must never
// appear in a DDC transaction.

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
  getConfidentialDepositInstruction,
} from "@solana-program/token-2022";
import { DDC_DECIMALS } from "../amount.js";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import { TOKEN_2022_PROGRAM } from "../constants.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";

/**
 * The largest amount a single Deposit or confidential Transfer may carry:
 * 2^48 - 1 base units (read at pinned source). A protocol
 * constant of Token-2022's Confidential Transfer extension, not a setting.
 */
export const MAXIMUM_DEPOSIT_TRANSFER_AMOUNT = (1n << 48n) - 1n;

export interface ShieldInput {
  /** Fee payer and token-account authority. One signer, two roles. */
  signer: KeyPairSigner;
  mint: Address;
  /** Base units to move from public to confidential; 1 .. 2^48 - 1. */
  amountBaseUnits: bigint;
  /**
   * The 36-byte AES ciphertext of (available + amount), produced by the CALLER
   * through encryptDecryptableBalance. Passed in, never computed here.
   */
  newDecryptableAvailableBalance: Uint8Array;
  /**
   * The pending-credit counter AS READ off the account immediately before
   * assembly. This module adds the one credit its own Deposit creates.
   */
  pendingBalanceCreditCounterAtRead: bigint;
  /** Read live by the caller; this module performs no network access. */
  blockhash: BlockhashLifetime;
}

/**
 * Assemble and sign the two-instruction shield transaction. Returns the
 * pre-compile message for inspection, the signed transaction, the derived
 * associated token account address, and the expected counter that was
 * written into ApplyPendingBalance.
 */
export async function assembleShieldTransaction(input: ShieldInput) {
  if (input.amountBaseUnits <= 0n) {
    throw new Error(
      `refusing to shield ${input.amountBaseUnits} base units: the amount must be at least 1 base unit`,
    );
  }
  if (input.amountBaseUnits > MAXIMUM_DEPOSIT_TRANSFER_AMOUNT) {
    throw new Error(
      `refusing to shield ${input.amountBaseUnits} base units: above the ${MAXIMUM_DEPOSIT_TRANSFER_AMOUNT} cap a single deposit may carry`,
    );
  }
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
  const expectedPendingBalanceCreditCounter =
    input.pendingBalanceCreditCounterAtRead + 1n;

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getConfidentialDepositInstruction({
          token: tokenAccount,
          mint: input.mint,
          authority: input.signer,
          amount: input.amountBaseUnits,
          decimals: DDC_DECIMALS,
        }),
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        getApplyConfidentialPendingBalanceInstruction({
          token: tokenAccount,
          authority: input.signer,
          expectedPendingBalanceCreditCounter,
          newDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
        }),
        m,
      ),
  );

  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { tokenAccount, message, transaction, expectedPendingBalanceCreditCounter };
}
