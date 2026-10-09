// The two `unshield` proofs — built from the account's OWN available-balance
// ciphertext, the amount, and the holder's keys, in upstream's composition.
// `unshield` is the user word; the wire instruction is `Withdraw`
// (ConfidentialTransferInstruction 6), and the two never mix in user copy, on
// the shield/Deposit rule.
//
// WHAT THE CHAIN CHECKS, and therefore what the proofs must say. The
// processor subtracts amount·G from the account's available-balance ciphertext
// itself and requires BYTE equality with the ciphertext the equality proof was
// generated over (`ConfidentialTransferBalanceMismatch` otherwise). So the
// ciphertext here is the vendored `subtractAmountFromCiphertext` over the
// bytes READ off the extension — never a fresh encryption of the remainder,
// which would carry different randomness and different bytes. The range proof
// certifies the remainder is a 64-bit value: on-chain it is the only guard
// against withdrawing more than the balance, since the equality proof alone
// would accept a remainder that wrapped negative.
//
// THE REMAINDER COMES FROM THE AES COPY. The plaintext the equality proof
// attests is `available − amount`, where `available` is the decrypted
// `decryptable_available_balance` copy (the only client-readable figure). If
// that copy is STALE — understated after a raced apply — the ciphertext no
// longer encrypts the figure the proof claims, and the LOCAL `verify()` below
// throws before anything is sent. That is the first place in this CLI where a
// wrong copy is caught by mathematics rather than by a counter comparison, and
// it is why both proofs are verified here and not only on-chain.
//
// OFFLINE, NOT DETERMINISTIC: the openings are random, so two runs over one
// input produce different proof bytes. Tests pin lengths and verification,
// never bytes (tx/confidential-setup-tx.ts states the same rule).
//
// THE ARRAY-TAKING CONSTRUCTOR CONSUMES ITS ARGUMENTS: the commitment and
// opening handed to BatchedRangeProofU64Data are moved into WASM and
// unusable afterwards, so the equality proof is built FIRST and the range
// proof LAST, in upstream's order. Reordering these two lines throws "array
// contains a value of the wrong type" at the second use.
//
// NO `/confidential` IMPORT: the arithmetic is the vendored copy at
// cli/src/vendor/, the proof types come from @solana/zk-sdk directly.

import {
  BatchedRangeProofU64Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  ElGamalSecretKey,
  PedersenCommitment,
  PedersenOpening,
} from "@solana/zk-sdk/node";
import { subtractAmountFromCiphertext } from "../vendor/confidentialTransferArithmetic.js";

/** The one bit length of the withdraw range proof: the remainder is a u64 (upstream REMAINING_BALANCE_BIT_LENGTH). */
export const REMAINING_BALANCE_BIT_LENGTH = 64;

/** Serialized proof sizes at @solana/zk-sdk 0.5.1, measured. */
export const EQUALITY_PROOF_BYTES = 320;
export const RANGE_U64_PROOF_BYTES = 936;

/** An ElGamal ciphertext on the wire: 32-byte commitment ‖ 32-byte handle. */
export const ELGAMAL_CIPHERTEXT_BYTES = 64;

export interface UnshieldProofInput {
  /** ElGamal SECRET key bytes from deriveConfidentialKeys. Never logged. */
  elgamalSecretKey: Uint8Array;
  /** The 64-byte `available_balance` ciphertext AS READ off the extension. */
  availableBalanceCiphertext: Uint8Array;
  /** The decrypted `decryptable_available_balance` copy, in base units. */
  availableBaseUnits: bigint;
  /** Base units to move from confidential to public; 1 .. available. */
  amountBaseUnits: bigint;
}

export interface UnshieldProofs {
  equalityProof: Uint8Array;
  rangeProof: Uint8Array;
  /** available − amount: the figure the caller encrypts into the new AES copy. */
  remainingBaseUnits: bigint;
  /** The ciphertext the equality proof was generated over, for inspection. */
  remainingBalanceCiphertext: Uint8Array;
}

/**
 * Build and locally verify both withdraw proofs. Throws on a zero amount, an
 * amount above the available figure, a malformed ciphertext, or a proof that
 * fails local verification — the last being the stale-copy case above.
 */
export function buildUnshieldProofs(input: UnshieldProofInput): UnshieldProofs {
  if (input.amountBaseUnits <= 0n) {
    throw new Error(
      `refusing to unshield ${input.amountBaseUnits} base units: the amount must be at least 1 base unit`,
    );
  }
  if (input.amountBaseUnits > input.availableBaseUnits) {
    throw new Error(
      `refusing to unshield ${input.amountBaseUnits} base units: above the ${input.availableBaseUnits} base units the confidential balance copy reads`,
    );
  }
  if (input.availableBalanceCiphertext.length !== ELGAMAL_CIPHERTEXT_BYTES) {
    throw new Error(
      `the available-balance ciphertext is ${input.availableBalanceCiphertext.length} bytes, not the ${ELGAMAL_CIPHERTEXT_BYTES} an ElGamal ciphertext carries`,
    );
  }

  const remainingBaseUnits = input.availableBaseUnits - input.amountBaseUnits;
  const remainingBalanceCiphertext = new Uint8Array(
    subtractAmountFromCiphertext(input.availableBalanceCiphertext, input.amountBaseUnits),
  );
  const ciphertext = ElGamalCiphertext.fromBytes(remainingBalanceCiphertext);
  if (ciphertext === undefined) {
    throw new Error("the remaining-balance ciphertext does not parse as an ElGamal ciphertext");
  }

  const keypair = ElGamalKeypair.fromSecretKey(
    ElGamalSecretKey.fromBytes(input.elgamalSecretKey),
  );
  const opening = new PedersenOpening();
  const commitment = PedersenCommitment.from(remainingBaseUnits, opening);

  // Equality FIRST: this constructor borrows; the range constructor below
  // consumes `commitment` and `opening` (see header).
  const equality = new CiphertextCommitmentEqualityProofData(
    keypair,
    ciphertext,
    commitment,
    opening,
    remainingBaseUnits,
  );
  equality.verify();
  const range = new BatchedRangeProofU64Data(
    [commitment],
    new BigUint64Array([remainingBaseUnits]),
    Uint8Array.from([REMAINING_BALANCE_BIT_LENGTH]),
    [opening],
  );
  range.verify();

  const equalityProof = new Uint8Array(equality.toBytes());
  const rangeProof = new Uint8Array(range.toBytes());
  if (equalityProof.length !== EQUALITY_PROOF_BYTES) {
    throw new Error(`the equality proof is ${equalityProof.length} bytes, not the ${EQUALITY_PROOF_BYTES} of record`);
  }
  if (rangeProof.length !== RANGE_U64_PROOF_BYTES) {
    throw new Error(`the range proof is ${rangeProof.length} bytes, not the ${RANGE_U64_PROOF_BYTES} of record`);
  }
  return { equalityProof, rangeProof, remainingBaseUnits, remainingBalanceCiphertext };
}
