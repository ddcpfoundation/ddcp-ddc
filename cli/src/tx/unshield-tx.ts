// Unshield transaction assembly — ONE transaction that moves a stated amount
// from a token account's CONFIDENTIAL balance to its PUBLIC balance (an earlier
// five-transaction chain is deleted, not kept alongside). Ordinary blockhash,
// self-pay. THE USER WORD IS `unshield`; THE INSTRUCTION IS `Withdraw`,
// ConfidentialTransferInstruction 6 — never conflated.
//
// WHY ONE. Under the version-1 transaction format the wire limit is 4,096
// bytes, and the whole shape measures 1,629, so both proofs are
// verified INLINE, in the same transaction as the withdraw that consumes them:
//   0. VerifyCiphertextCommitmentEquality   proof inline, no accounts
//   1. VerifyBatchedRangeProofU64            proof inline, no accounts
//   2. Withdraw                              offsets -2 and -1, via the sysvar
// No stored-result account is created, so no rent is locked, no account can be
// orphaned, and the transaction cannot half-succeed. The assembler is offline:
// the blockhash arrives as a parameter, read by the caller. Proof bytes are
// random per run, so the sibling test pins structure and lengths, never a byte
// vector of a proof.
//
// THE PROOF OFFSETS ARE DERIVED FROM POSITION, never written as literals: each
// is the proof's index in the instruction array minus the withdraw's. The
// processor takes the instructions sysvar ONLY when an offset is non-zero
// (spl-token-2022 verify_proof.rs) and reads each proof at that relative
// index. This is a different processor branch from the stored-result path this
// build exercised before: the proofs are located by introspection of the
// transaction itself, which is where an offset confusion would live, and it is
// the surface an auditor should read first here.
//
// THE TWO LIMITS ARE MANDATORY. Under version 1 the compute-unit limit and the
// loaded-accounts-data-size limit are fields on the message and both DEFAULT
// TO ZERO — an unset transaction fails at account loading before any log is
// written. Both are stated below with margin over the measured figures. There
// is no ComputeBudget instruction: under version 1 it is a no-op that burns
// units, and `priorityFeeLamports` is NEVER set, which is the rule
// against SetComputeUnitPrice in its version-1 form.
//
// VERSION 1 IS REQUIRED, not preferred: the same three instructions as a
// version-0 message encode to 1,618 bytes, 386 past the legacy limit, so no
// legacy shape exists for this transaction. Whether the cluster runs the
// format is a NETWORK fact the caller gates before any send
// (transaction-format.ts); this module only assembles.
//
// `decimals` IS DDC_DECIMALS, SUPPLIED EXPLICITLY, cross-checked by the
// program against the mint (MintDecimalsMismatch) — from amount.ts, never
// constants.ts, on the shield-tx.ts reasoning.

import {
  appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getConfidentialWithdrawInstruction,
} from "@solana-program/token-2022";
import {
  getVerifyProofInstruction,
  ZkElGamalProofInstruction,
} from "@solana-program/zk-elgamal-proof";
import { DDC_DECIMALS } from "../amount.js";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import { SYSVAR_INSTRUCTIONS, TOKEN_2022_PROGRAM } from "../constants.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";
import { EQUALITY_PROOF_BYTES, RANGE_U64_PROOF_BYTES } from "./unshield-proofs.js";

/**
 * Compute-unit limit for the one transaction. Measured 124,157 on devnet
 * (6,400 equality verify, 111,000 range verify, 6,757
 * withdraw); stated with margin because the proof program's charges are its
 * own and move with its version. A ceiling, not a cost: the fee is the base
 * signature fee regardless.
 */
export const UNSHIELD_COMPUTE_UNIT_LIMIT = 150_000;

/**
 * Loaded-accounts-data-size limit for the one transaction, in bytes. Measured
 * 712,728 on devnet, dominated by the two programs' own bytes, which move
 * when either program is upgraded; stated with margin for that.
 */
export const UNSHIELD_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 1_000_000;

/** The wire limit the shape is assembled against; the sibling test pins the measured size beneath it. */
export const V1_TRANSACTION_SIZE_LIMIT_BYTES = 4096;

/**
 * An empty version-1 message. At the pinned @solana/kit 7.0.0 the exported
 * `createTransactionMessage` is TYPED to exclude version 1 ("not yet supported
 * by these functions") while every encoder, setter and signer beneath it
 * dispatches on `version === 1` at runtime; its body is this same freeze. The
 * type is the one the package itself declares for a version-1 message, so a
 * setter that later stops accepting it fails here at compile time.
 */
function createV1TransactionMessage(): Readonly<{ instructions: readonly []; version: 1 }> {
  const instructions: readonly [] = Object.freeze([]) as readonly [];
  return Object.freeze({ instructions, version: 1 as const });
}

function requireLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error(`the ${what} is ${bytes.length} bytes, not the ${expected} of record`);
  }
}

/**
 * Both verifies and the withdraw, in one version-1 transaction. Throws on a
 * non-positive amount and on any proof or balance copy of the wrong length.
 */
export async function assembleUnshieldTransaction(input: {
  signer: KeyPairSigner;
  mint: Address;
  amountBaseUnits: bigint;
  /** The 36-byte AES ciphertext of (available − amount), produced by the CALLER. */
  newDecryptableAvailableBalance: Uint8Array;
  equalityProof: Uint8Array;
  rangeProof: Uint8Array;
  blockhash: BlockhashLifetime;
}) {
  if (input.amountBaseUnits <= 0n) {
    throw new Error(`refusing to unshield ${input.amountBaseUnits} base units: the amount must be at least 1 base unit`);
  }
  requireLength(input.equalityProof, EQUALITY_PROOF_BYTES, "equality proof");
  requireLength(input.rangeProof, RANGE_U64_PROOF_BYTES, "range proof");
  requireLength(input.newDecryptableAvailableBalance, DECRYPTABLE_BALANCE_BYTES, "new decryptable balance");
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: input.signer.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: input.mint,
  });

  // Position first, offsets second: the withdraw is appended LAST and each
  // offset is the proof's index minus the withdraw's, so the array is the
  // single source of truth for where the processor will look.
  const equalityVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyCiphertextCommitmentEquality,
    proofData: input.equalityProof,
  });
  const rangeVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyBatchedRangeProofU64,
    proofData: input.rangeProof,
  });
  const proofs = [equalityVerify, rangeVerify] as const;
  const withdrawIndex = proofs.length;
  const equalityProofInstructionOffset = proofs.indexOf(equalityVerify) - withdrawIndex;
  const rangeProofInstructionOffset = proofs.indexOf(rangeVerify) - withdrawIndex;
  const withdraw = getConfidentialWithdrawInstruction({
    token: tokenAccount,
    mint: input.mint,
    instructionsSysvar: SYSVAR_INSTRUCTIONS,
    authority: input.signer,
    amount: input.amountBaseUnits,
    decimals: DDC_DECIMALS,
    newDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
    equalityProofInstructionOffset,
    rangeProofInstructionOffset,
  });

  const message = pipe(
    createV1TransactionMessage(),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) => appendTransactionMessageInstructions([...proofs, withdraw], m),
    (m) => setTransactionMessageComputeUnitLimit(UNSHIELD_COMPUTE_UNIT_LIMIT, m),
    (m) => setTransactionMessageLoadedAccountsDataSizeLimit(UNSHIELD_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, m),
  );
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { tokenAccount, message, transaction };
}
