// Public transfer transaction assembly -- the TWO-instruction path that moves a
// stated amount from the sender's PUBLIC balance to the recipient's PUBLIC
// balance, with the fee carved out on the recipient's side. Ordinary blockhash,
// single signer, self-pay.
//
// THE USER WORD IS 'public-transfer'; THE INSTRUCTION IS 'TransferCheckedWithFee',
// TransferFeeInstruction 1 under Token-2022 instruction 26, and the two never mix
// in user copy.
//
// WHY THE WITH-FEE FORM AND NOT PLAIN TransferChecked. Both are valid on this
// mint: read at Token-2022 program@v11.0.0, process_transfer computes the fee
// from the mint itself and compares it against a stated figure ONLY when the
// instruction is CheckedWithFee, returning TokenError::FeeMismatch on a
// mismatch. Stating the fee is therefore a deliberate choice and it buys one
// thing: the figure the sender read in the announcement and typed CONFIRM to
// is asserted on-chain. If the mint's fee schedule moves between the
// announcement and execution, the transfer FAILS rather than silently
// charging a fee the sender never approved. The command carries the copy for
// that outcome; this module only makes it possible.
//
// NO PROOF, NO BOUND FROM THE PROOF. A public transfer proves nothing, so the
// 48-bit bound of the confidential path does not reach it and the only bound
// is PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, the largest value the amount field
// holds. No refusal in this module names a proof.
//
// THE RECIPIENT'S ACCOUNT IS CREATED IDEMPOTENTLY, ALWAYS. Instruction 0 is
// CreateAssociatedTokenIdempotent with the SENDER as payer, so the sender pays
// the account's one-time rent when it does not exist and the instruction is a
// no-op when it does. Always present, never conditional: a third party
// creating the account between the command's read and this send is then
// harmless. The announcement's create line is driven by the command's read,
// which is the only place that read still matters.
//
// THE FEE ARRIVES AS A PARAMETER, COMPUTED BY THE CALLER through
// grossForNetPublic. This module performs no fee arithmetic, exactly as
// shield-tx.ts encrypts no balance: the figure on the wire must be the figure
// the announcement printed, and recomputing it here would make two sources of
// one number.
//
// 'decimals' IS DDC_DECIMALS, SUPPLIED EXPLICITLY, on the shield-tx.ts rule:
// the program cross-checks the caller's expected decimals against the mint,
// and the value comes from amount.ts where the instrument's decimals live,
// never from constants.ts whose values are overridable defaults.
//
// ONE SIGNER, THREE ROLES: fee payer, rent payer for the recipient's account,
// and authority of the source token account, which is its owner. No separate
// 'owner' parameter: one signer makes an owner/signer mismatch unrepresentable.
//
// SENDING TO THE SENDER'S OWN WALLET is refused by name here as well as in the
// command, as tx/transfer-tx.ts refuses it: the shape exists on-chain but
// nothing in this build wants it.
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
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedWithFeeInstruction,
} from "@solana-program/token-2022";
import { DDC_DECIMALS } from "../amount.js";
import { TOKEN_2022_PROGRAM } from "../constants.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";
import { PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS } from "./transfer-fee-split.js";

export interface PublicTransferInput {
  /** Fee payer, rent payer for the recipient's account, and source authority. */
  signer: KeyPairSigner;
  mint: Address;
  /** The recipient's WALLET address; the token account is derived here. */
  recipient: Address;
  /** Base units debited from the sender: the net plus the fee, from grossForNetPublic. */
  grossBaseUnits: bigint;
  /** The fee the program will compute for itself, asserted on the wire. */
  feeBaseUnits: bigint;
  /** Read live by the caller; this module performs no network access. */
  blockhash: BlockhashLifetime;
}

/**
 * Assemble and sign the two-instruction public transfer. Returns the
 * pre-compile message for inspection, the signed transaction, and both
 * derived token account addresses. Throws on a non-positive gross, a gross
 * above the public bound, a negative fee, a fee above the gross, and a
 * recipient equal to the sender; no refusal here names a proof.
 */
export async function assemblePublicTransferTransaction(input: PublicTransferInput) {
  if (input.recipient === input.signer.address) {
    throw new Error("refusing to transfer to the sender's own wallet " + input.recipient);
  }
  if (input.grossBaseUnits <= 0n) {
    throw new Error(
      "refusing to transfer " + input.grossBaseUnits + " base units: the amount must be at least 1 base unit",
    );
  }
  if (input.grossBaseUnits > PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS) {
    throw new Error(
      "refusing to transfer " + input.grossBaseUnits + " base units: one transfer carries at most " +
        PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS + " base units",
    );
  }
  if (input.feeBaseUnits < 0n) {
    throw new Error("a fee must be non-negative, got " + input.feeBaseUnits);
  }
  if (input.feeBaseUnits > input.grossBaseUnits) {
    throw new Error(
      "refusing to transfer " + input.grossBaseUnits + " base units with a fee of " + input.feeBaseUnits +
        ": the fee cannot exceed the amount",
    );
  }
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
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: input.signer,
          ata: destinationToken,
          owner: input.recipient,
          mint: input.mint,
          tokenProgram: TOKEN_2022_PROGRAM,
        }),
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        getTransferCheckedWithFeeInstruction({
          source: sourceToken,
          mint: input.mint,
          destination: destinationToken,
          authority: input.signer,
          amount: input.grossBaseUnits,
          decimals: DDC_DECIMALS,
          fee: input.feeBaseUnits,
        }),
        m,
      ),
  );
  const transaction = await partiallySignTransactionMessageWithSigners(message);
  return { sourceToken, destinationToken, message, transaction };
}
