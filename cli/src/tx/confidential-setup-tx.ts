// Confidential-account setup transaction assembly — the FOUR-instruction path
// that activates confidential balance on one DDC token account. Ordinary
// blockhash, single signer, self-pay: relay passage is never required and
// `relay_endpoint` is not a recognized config key today.
//
// OFFLINE, BUT NOT DETERMINISTIC — the two halves are stated apart because one
// gate does not prove both. OFFLINE: no RPC handle, no filesystem, no network;
// the blockhash arrives as a parameter, exactly as tx/durable-nonce-tx.ts takes
// its nonce. NOT DETERMINISTIC: proof generation draws randomness, so two runs
// over identical inputs produce different proof bytes. Every other module in
// this directory is byte-deterministic; this one is the exception, and a test
// over it can pin structure and lengths but never a proof byte vector.
//
// ONE SIGNER, THREE ROLES. The same signer is fee payer, ATA/reallocate payer,
// account owner and ConfigureAccount authority. There is deliberately no
// separate `owner` parameter: confidential-keys.ts leaves owner and signer
// unconstrained because the SDK supports PDA wallets, and this is the layer
// where that guard belongs. Taking one signer makes the mismatch
// unrepresentable rather than merely unchecked.
//
// THE `Reallocate` EXTENSION TYPES ARE [5, 17], AND THE DERIVATION RUNS FROM
// THIS MINT, NOT FROM UPSTREAM'S SIGNATURE. This mint carries
// ConfidentialTransferFeeConfig permanently, so a token account on it needs
// room for ConfidentialTransferAccount (5) AND ConfidentialTransferFeeAmount
// (17); ConfigureAccount then initializes 17 itself. Allocating for 5 alone
// fails ON-CHAIN at the configure step, not at compile time, and not at the
// reallocate step that caused it. TransferFeeAmount (2) arrives at account
// creation and ImmutableOwner (7) arrives free on an ATA; neither belongs in
// this list.
//
// NAMING HAZARD, ONE WORD WIDE. Upstream's enum carries ConfidentialTransferFee
// = 16 (the MINT-side extension this project calls ConfidentialTransferFeeConfig)
// immediately before ConfidentialTransferFeeAmount = 17 (the ACCOUNT-side one
// wanted here). Selecting 16 compiles clean and fails on-chain. The sibling test
// therefore asserts the NUMBERS 5 and 17 off the encoded instruction data, never
// the member names.
//
// ADJACENCY IS LOAD-BEARING. `proofInstructionOffset` is resolved against the
// instruction list of the transaction being executed, so ConfigureAccount and
// the verify-proof instruction must sit next to each other in THE SAME
// transaction, in that order. Inserting anything between them silently
// repoints the offset.
//
// NO PLAN BUILDERS, NO `/confidential` IMPORT. Layer A generated encoders only,
// with assembly here in cli/src/tx/. That rule also disposes of
// @solana-program/zk-elgamal-proof's `actions/verifyPubkeyValidity` helper,
// which takes an `rpc` handle this path never uses.
//
// NO ApproveAccount STEP. `auto_approve_new_accounts` is 1 on this mint, read
// from chain at genesis, which is why the path is four
// instructions and not five.

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
  ExtensionType,
  findAssociatedTokenPda,
  getConfigureConfidentialTransferAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getReallocateInstruction,
} from "@solana-program/token-2022";
import {
  getVerifyProofInstruction,
  ZkElGamalProofInstruction,
} from "@solana-program/zk-elgamal-proof";
import {
  AeKey,
  ElGamalKeypair,
  ElGamalSecretKey,
  PubkeyValidityProofData,
} from "@solana/zk-sdk/node";
import { SYSVAR_INSTRUCTIONS, TOKEN_2022_PROGRAM } from "../constants.js";

/**
 * The pending-balance credit cap written at ConfigureAccount. Stated here and
 * never inherited from an upstream default. Upstream's default happens to
 * equal it, so this changes no bytes today — the constraint is prophylactic
 * and must not be deleted as redundant. It is IMMUTABLE for the life of the
 * token account.
 */
export const MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER = 65536n;

/** ConfigureAccount reads the verify instruction at exactly +1. See ADJACENCY. */
export const PROOF_INSTRUCTION_OFFSET = 1;

/** The [5, 17] pair, derived from this mint's own extensions. See above. */
export const REALLOCATE_EXTENSION_TYPES = [
  ExtensionType.ConfidentialTransferAccount,
  ExtensionType.ConfidentialTransferFeeAmount,
] as const;

/** Blockhash lifetime as the kit setter itself declares it — no local restatement. */
export type BlockhashLifetime = Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];

export interface ConfidentialSetupInput {
  /** Fee payer, ATA payer, account owner and ConfigureAccount authority. */
  signer: KeyPairSigner;
  mint: Address;
  /** ElGamal SECRET key bytes from deriveConfidentialKeys. Never logged. */
  elgamalSecretKey: Uint8Array;
  /** AE key bytes from deriveConfidentialKeys. Never logged. */
  aeKey: Uint8Array;
  /** Read live by the caller; this module performs no network access. */
  blockhash: BlockhashLifetime;
}

/**
 * Assemble and sign the four-instruction confidential-account setup
 * transaction. Returns the pre-compile message for inspection, the signed
 * transaction, and the derived associated token account address.
 *
 * The proof is verified LOCALLY before assembly: PubkeyValidityProofData
 * exposes verify(), which throws on an invalid proof, so a malformed proof
 * becomes a local error rather than a failed broadcast.
 */
export async function assembleConfidentialSetupTransaction(
  input: ConfidentialSetupInput,
) {
  const owner = input.signer.address;

  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: input.mint,
  });

  // Rebuild the two WASM handles from the derived bytes. Both live in the
  // /node instance; nothing crosses a WebAssembly boundary in production.
  const keypair = ElGamalKeypair.fromSecretKey(
    ElGamalSecretKey.fromBytes(input.elgamalSecretKey),
  );
  const decryptableZeroBalance = new Uint8Array(
    AeKey.fromBytes(input.aeKey).encrypt(0n).toBytes(),
  );

  const proof = new PubkeyValidityProofData(keypair);
  proof.verify();
  const proofData = new Uint8Array(proof.toBytes());

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: input.signer,
          ata: tokenAccount,
          owner,
          mint: input.mint,
          tokenProgram: TOKEN_2022_PROGRAM,
        }),
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        getReallocateInstruction({
          token: tokenAccount,
          payer: input.signer,
          owner: input.signer,
          newExtensionTypes: [...REALLOCATE_EXTENSION_TYPES],
        }),
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        getConfigureConfidentialTransferAccountInstruction({
          token: tokenAccount,
          mint: input.mint,
          instructionsSysvarOrContextState: SYSVAR_INSTRUCTIONS,
          authority: input.signer,
          decryptableZeroBalance,
          maximumPendingBalanceCreditCounter:
            MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
          proofInstructionOffset: PROOF_INSTRUCTION_OFFSET,
        }),
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        getVerifyProofInstruction({
          discriminator: ZkElGamalProofInstruction.VerifyPubkeyValidity,
          proofData,
        }),
        m,
      ),
  );

  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { tokenAccount, message, transaction };
}
