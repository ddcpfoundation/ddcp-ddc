// Transfer transaction assembly -- ONE version-1 transaction that moves a
// stated amount from the sender's CONFIDENTIAL balance to the recipient's
// PENDING balance, with the fee carved out on the recipient's side. Ordinary
// blockhash, self-pay. THE
// USER WORD IS 'confidential-transfer'; THE INSTRUCTION IS 'TransferWithFee',
// ConfidentialTransferInstruction 13 under Token-2022 instruction 27, and the
// two never mix in user copy. This is the ONLY valid Confidential Transfer
// extension instruction on this mint, even at zero fee: the mint carries
// TransferFeeConfig, so Token-2022 selects the
// with-fee path on extension presence, not rate.
//
// WHY ONE. Under the version-1 format the wire limit is 4,096 bytes and the
// whole shape measures 3,247 with a distinct destination, so
// all five proofs are verified INLINE in the same transaction as the
// transfer that consumes them, on the unshield-tx.ts pattern:
//   0. VerifyCiphertextCommitmentEquality                 proof inline
//   1. VerifyBatchedGroupedCiphertext3HandlesValidity     proof inline
//   2. VerifyPercentageWithCap                            proof inline
//   3. VerifyBatchedGroupedCiphertext2HandlesValidity     proof inline
//   4. VerifyBatchedRangeProofU256                        proof inline
//   5. TransferWithFee              offsets -5 .. -1, via the sysvar
// No record or context-state account is created, so no rent is locked,
// nothing can be orphaned, and the transaction cannot half-succeed. The
// assembler is offline: the blockhash arrives as a parameter. Proof bytes
// are random per run, so the sibling test pins structure and lengths, never
// a byte vector of a proof.
//
// THE PROOF OFFSETS ARE DERIVED FROM POSITION, never written as literals: each
// is the proof's index in the instruction array minus the transfer's. The
// processor takes the instructions sysvar ONLY when an offset is non-zero and
// reads each proof at that relative index; five proofs by relative offset was
// the branch unexercised until the first send. This is the surface an auditor
// should read first here.
//
// THE PROOFS AND THE AUDITOR CIPHERTEXTS COME FROM ONE BUILD: the remainder
// the equality proof covers carries the transfer ciphertexts' own openings,
// so the five proofs and the two auditor ciphertexts handed to this
// assembler must be the output of one buildTransferProofs call.
//
// THE TWO LIMITS ARE MANDATORY under version 1 (unshield-tx.ts states why).
// The compute limit is stated with margin over the five verifies' fixed
// charges, 6,400 + 16,400 + 6,500 + 13,000 + 368,000 = 410,300 (the U256
// figure measured), plus the TransferWithFee
// instruction's own charge. Simulated on devnet, the whole transaction
// consumes 455,927 units, Token-2022 taking 45,627 of them, the same at 0
// bps and at 100 bps with the fee at its cap; the limit is sized from that
// figure inside a 10-20% band. The loaded-accounts limit is
// unshield's; the transfer loads one more token account (a few hundred
// bytes) against the same two programs. There is no ComputeBudget
// instruction and 'priorityFeeLamports' is NEVER set.
//
// THE DESTINATION IS A WALLET ADDRESS; this module derives its associated
// token account, as it does the sender's. Sending to the sender's own wallet
// is refused by name here as well as in the command: the shape exists
// on-chain but nothing in this build wants it.
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
  getConfidentialTransferWithFeeInstruction,
} from "@solana-program/token-2022";
import {
  getVerifyProofInstruction,
  ZkElGamalProofInstruction,
} from "@solana-program/zk-elgamal-proof";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import { SYSVAR_INSTRUCTIONS, TOKEN_2022_PROGRAM } from "../constants.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";
import { ELGAMAL_CIPHERTEXT_BYTES, EQUALITY_PROOF_BYTES } from "./unshield-proofs.js";
import { V1_TRANSACTION_SIZE_LIMIT_BYTES } from "./unshield-tx.js";
import {
  PERCENTAGE_WITH_CAP_PROOF_BYTES,
  RANGE_U256_PROOF_BYTES,
  VALIDITY_2_HANDLES_PROOF_BYTES,
  VALIDITY_3_HANDLES_PROOF_BYTES,
  type TransferProofs,
} from "./transfer-proofs.js";

/**
 * Compute-unit limit for the one transaction: 410,300 of fixed verify charges
 * plus the TransferWithFee instruction's own 45,627, measured at 455,927 in
 * all. 525,000 is 1.15 times the measurement rounded up to a multiple of
 * 5,000, inside the 10-20% band. A ceiling, not a cost: the fee is
 * the base signature fee.
 */
export const TRANSFER_COMPUTE_UNIT_LIMIT = 525_000;
/** The five verify charges the limit must clear, for the sibling test. */
export const TRANSFER_VERIFY_COMPUTE_UNITS = 6_400 + 16_400 + 6_500 + 13_000 + 368_000;
/**
 * Loaded-accounts-data-size limit, in bytes: unshield measured 712,728,
 * dominated by the two programs' own bytes; the transfer adds one token
 * account. Stated with the same margin.
 */
export const TRANSFER_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 1_000_000;
export { V1_TRANSACTION_SIZE_LIMIT_BYTES };

/** The proof bytes and auditor ciphertexts of ONE buildTransferProofs call. */
type TransferProofField =
  | "equalityProof"
  | "transferValidityProof"
  | "percentageWithCapProof"
  | "feeValidityProof"
  | "rangeProof"
  | "transferAmountAuditorCiphertextLo"
  | "transferAmountAuditorCiphertextHi";
export type TransferProofBytes = Pick<TransferProofs, TransferProofField>;

function createV1TransactionMessage(): Readonly<{ instructions: readonly []; version: 1 }> {
  const instructions: readonly [] = Object.freeze([]) as readonly [];
  return Object.freeze({ instructions, version: 1 as const });
}

function requireLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error("the " + what + " is " + bytes.length + " bytes, not the " + expected + " of record");
  }
}

/**
 * The five verifies and the transfer, in one version-1 transaction. Throws
 * on a recipient equal to the signer and on any proof, ciphertext or balance
 * copy of the wrong length.
 */
export async function assembleTransferTransaction(input: {
  signer: KeyPairSigner;
  mint: Address;
  /** The recipient's WALLET address; the token account is derived here. */
  recipient: Address;
  /** The 36-byte AES ciphertext of (available - gross), produced by the CALLER. */
  newDecryptableAvailableBalance: Uint8Array;
  proofs: TransferProofBytes;
  blockhash: BlockhashLifetime;
}) {
  if (input.recipient === input.signer.address) {
    throw new Error("refusing to transfer to the sender's own wallet " + input.recipient);
  }
  const p = input.proofs;
  requireLength(p.equalityProof, EQUALITY_PROOF_BYTES, "equality proof");
  requireLength(p.transferValidityProof, VALIDITY_3_HANDLES_PROOF_BYTES, "transfer validity proof");
  requireLength(p.percentageWithCapProof, PERCENTAGE_WITH_CAP_PROOF_BYTES, "percentage-with-cap proof");
  requireLength(p.feeValidityProof, VALIDITY_2_HANDLES_PROOF_BYTES, "fee validity proof");
  requireLength(p.rangeProof, RANGE_U256_PROOF_BYTES, "range proof");
  requireLength(p.transferAmountAuditorCiphertextLo, ELGAMAL_CIPHERTEXT_BYTES, "auditor ciphertext lo");
  requireLength(p.transferAmountAuditorCiphertextHi, ELGAMAL_CIPHERTEXT_BYTES, "auditor ciphertext hi");
  requireLength(input.newDecryptableAvailableBalance, DECRYPTABLE_BALANCE_BYTES, "new decryptable balance");
  const [sourceToken] = await findAssociatedTokenPda({
    owner: input.signer.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: input.mint,
  });
  const [destinationToken] = await findAssociatedTokenPda({
    owner: input.recipient,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: input.mint,
  });
  // Position first, offsets second: the transfer is appended LAST and each
  // offset is the proof's index minus the transfer's, so the array is the
  // single source of truth for where the processor will look.
  const equalityVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyCiphertextCommitmentEquality,
    proofData: p.equalityProof,
  });
  const transferValidityVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyBatchedGroupedCiphertext3HandlesValidity,
    proofData: p.transferValidityProof,
  });
  const feeSigmaVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyPercentageWithCap,
    proofData: p.percentageWithCapProof,
  });
  const feeValidityVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyBatchedGroupedCiphertext2HandlesValidity,
    proofData: p.feeValidityProof,
  });
  const rangeVerify = getVerifyProofInstruction({
    discriminator: ZkElGamalProofInstruction.VerifyBatchedRangeProofU256,
    proofData: p.rangeProof,
  });
  const proofs = [equalityVerify, transferValidityVerify, feeSigmaVerify, feeValidityVerify, rangeVerify] as const;
  const transferIndex = proofs.length;
  const offsetOf = (ix: (typeof proofs)[number]) => proofs.indexOf(ix) - transferIndex;
  const transfer = getConfidentialTransferWithFeeInstruction({
    sourceToken,
    mint: input.mint,
    destinationToken,
    instructionsSysvar: SYSVAR_INSTRUCTIONS,
    authority: input.signer,
    newSourceDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
    transferAmountAuditorCiphertextLo: p.transferAmountAuditorCiphertextLo,
    transferAmountAuditorCiphertextHi: p.transferAmountAuditorCiphertextHi,
    equalityProofInstructionOffset: offsetOf(equalityVerify),
    transferAmountCiphertextValidityProofInstructionOffset: offsetOf(transferValidityVerify),
    feeSigmaProofInstructionOffset: offsetOf(feeSigmaVerify),
    feeCiphertextValidityProofInstructionOffset: offsetOf(feeValidityVerify),
    rangeProofInstructionOffset: offsetOf(rangeVerify),
  });
  const message = pipe(
    createV1TransactionMessage(),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) => appendTransactionMessageInstructions([...proofs, transfer], m),
    (m) => setTransactionMessageComputeUnitLimit(TRANSFER_COMPUTE_UNIT_LIMIT, m),
    (m) => setTransactionMessageLoadedAccountsDataSizeLimit(TRANSFER_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, m),
  );
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { sourceToken, destinationToken, message, transaction };
}
