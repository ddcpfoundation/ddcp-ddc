// The five 'transfer' proofs -- built offline from the source account's OWN
// available-balance ciphertext, the gross and its fee split, and the four
// encryption keys a transfer with fee binds. 'confidential-transfer' is the
// user word; the wire instruction is 'TransferWithFee',
// ConfidentialTransferInstruction 13 under Token-2022 instruction 27, and the
// two never mix in user copy.
//
// WHAT THE CHAIN CHECKS, and therefore what each proof must say:
//   1. equality: the source's new available balance, computed on-chain by
//      subtracting the lo/hi transfer ciphertexts from the account's own
//      available-balance ciphertext, equals the commitment the range proof
//      covers -- byte equality, so the ciphertext here is the vendored
//      'subtractWithLoHiCiphertexts' over the bytes READ off the extension,
//      never a fresh encryption (the unshield-proofs.ts rule);
//   2. batched 3-handle validity: the two transfer ciphertexts are well
//      formed encryptions of the same lo/hi amounts under the source, the
//      destination and the auditor keys;
//   3. percentage with cap: the fee is ceil(gross * bps / 10000) or the
//      cap, on the schedule's OWN bps and maximumFee, which the program
//      compares against the mint at execution;
//   4. batched 2-handle validity: the two fee ciphertexts are well formed
//      encryptions of the same lo/hi fee under the destination and the
//      withdraw-withheld authority keys;
//   5. range U256: eight commitments at 64/16/32/16/16/16/32/64 bits --
//      remaining balance, transfer lo, transfer hi, claimed delta, its
//      complement to 9999, fee lo, fee hi, net -- all in range.
// The GROSS is what leaves the source (transfer lo/hi encrypt the gross);
// the fee is carved out of it on the destination side and the destination's
// pending balance receives the net. The sender's new available balance is
// therefore 'available - gross'.
//
// THE KEYS. The auditor key is the mint's when it carries one and the
// all-zero key when it does not: an encryption under the zero key is a
// real encryption whose handle is the identity point, which is why the
// program accepts it, and why hard-coding either choice would break the
// wallet on the mint it did not match. The withheld-fee key is the mint's
// ConfidentialTransferFeeConfig key, read by the caller. Both arrive as
// raw 32-byte keys; the caller decodes addresses.
//
// EVERY PROOF IS VERIFIED LOCALLY before return: a stale AES copy (after a
// raced apply) makes the equality proof fail here, before any send.
//
// OFFLINE, NOT DETERMINISTIC: the openings are random, so tests pin lengths
// and verification, never bytes.
//
// THE ARITHMETIC. A Pedersen commitment to x with opening r is x*G + r*H, and
// both parts are linear, so every sum, difference or multiple taken below over
// commitments is taken over their openings too, in the same order: the proofs
// check a commitment against its opening. 'combineLoHi' joins two halves as
// lo + 2^16 * hi, the lo half being 16 bits for the transfer and the fee alike.
// The fee delta, 'fee * 10000 - gross * bps', and why it lies in 0..9999, are
// explained in tx/transfer-fee-split.ts.
//
// CONSTRUCTOR CONSUMPTION: the array-taking range constructor MOVES its
// commitments and openings into WASM. It is therefore built LAST, after
// every other use of those objects, in upstream's own order
// (@solana-program/token-2022 0.15.0, confidentialTransferHelpers.ts,
// getConfidentialTransferWithFeeInstructionPlan). The other four
// constructors borrow; the sibling test exercises the whole sequence twice
// on one input set to pin that no object is consumed early.
//
// NO '/confidential' IMPORT: the arithmetic is the vendored copy at
// cli/src/vendor/, the proof types come from @solana/zk-sdk directly.
import {
  BatchedGroupedCiphertext2HandlesValidityProofData,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU256Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  ElGamalPubkey,
  ElGamalSecretKey,
  GroupedElGamalCiphertext2Handles,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
  PercentageWithCapProofData,
} from "@solana/zk-sdk/node";
import {
  extractCiphertextFromGroupedBytes,
  subtractWithLoHiCiphertexts,
} from "../vendor/confidentialTransferArithmetic.js";
import {
  MAX_CLAIMED_DELTA_FEE,
  MAX_FEE_BASIS_POINTS,
  TRANSFER_AMOUNT_HI_BIT_LENGTH,
  TRANSFER_AMOUNT_LO_BIT_LENGTH,
  type TransferFeeSchedule,
  type TransferFeeSplit,
} from "./transfer-fee-split.js";
import { ELGAMAL_CIPHERTEXT_BYTES, EQUALITY_PROOF_BYTES, REMAINING_BALANCE_BIT_LENGTH } from "./unshield-proofs.js";

/** Bit widths of the two halves a FEE is proven in (upstream FEE_AMOUNT_LO/HI_BIT_LENGTH). */
export const FEE_AMOUNT_LO_BIT_LENGTH = 16n;
export const FEE_AMOUNT_HI_BIT_LENGTH = 32n;
/** Bit width of each of the two delta slots: claimed delta and its complement to 9999. */
export const DELTA_BIT_LENGTH = 16;
/** Bit width of the net transfer amount slot. */
export const NET_TRANSFER_AMOUNT_BIT_LENGTH = 64;
/** An ElGamal public key on the wire. */
export const ELGAMAL_PUBKEY_BYTES = 32;
/** Serialized proof sizes at @solana/zk-sdk 0.5.1 (less the one discriminator byte each); the equality size is unshield-proofs.ts's. */
export const VALIDITY_3_HANDLES_PROOF_BYTES = 544;
export const PERCENTAGE_WITH_CAP_PROOF_BYTES = 360;
export const VALIDITY_2_HANDLES_PROOF_BYTES = 416;
export const RANGE_U256_PROOF_BYTES = 1064;

export interface TransferProofInput {
  /** Source ElGamal SECRET key bytes from deriveConfidentialKeys. Never logged. */
  elgamalSecretKey: Uint8Array;
  /** The source's 64-byte 'available_balance' ciphertext AS READ off the extension. */
  availableBalanceCiphertext: Uint8Array;
  /** The decrypted 'decryptable_available_balance' copy, in base units. */
  availableBaseUnits: bigint;
  /** Base units debited from the source: the recipient's net plus the fee. */
  grossBaseUnits: bigint;
  /** The forward split at 'grossBaseUnits' under 'schedule' (transfer-fee-gross.ts). */
  split: TransferFeeSplit;
  /** The schedule the split was computed under; its bps and cap are bound into the proofs. */
  schedule: TransferFeeSchedule;
  /** The destination token account's ElGamal public key, 32 bytes. */
  destinationElgamalPubkey: Uint8Array;
  /** The mint's auditor key, 32 bytes, or undefined when the mint carries none. */
  auditorElgamalPubkey: Uint8Array | undefined;
  /** The mint's withdraw-withheld authority ElGamal key, 32 bytes. */
  withdrawWithheldAuthorityElgamalPubkey: Uint8Array;
}

export interface TransferProofs {
  equalityProof: Uint8Array;
  transferValidityProof: Uint8Array;
  percentageWithCapProof: Uint8Array;
  feeValidityProof: Uint8Array;
  rangeProof: Uint8Array;
  /** The gross encrypted under the auditor key, lo and hi, 64 bytes each: instruction data. */
  transferAmountAuditorCiphertextLo: Uint8Array;
  transferAmountAuditorCiphertextHi: Uint8Array;
  /** available - gross: the figure the caller encrypts into the new AES copy. */
  remainingBaseUnits: bigint;
  /** The ciphertext the equality proof was generated over, for inspection. */
  remainingBalanceCiphertext: Uint8Array;
  /** True when the mint carried no auditor key and the zero key was used. */
  zeroAuditorKey: boolean;
}

function splitAmount(amount: bigint, bitLength: bigint): [bigint, bigint] {
  const mask = (1n << bitLength) - 1n;
  return [amount & mask, amount >> bitLength];
}

function requireKeyLength(bytes: Uint8Array, what: string): void {
  if (bytes.length !== ELGAMAL_PUBKEY_BYTES) {
    throw new Error("the " + what + " is " + bytes.length + " bytes, not the " + ELGAMAL_PUBKEY_BYTES + " an ElGamal public key carries");
  }
}

function requireProofLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error("the " + what + " is " + bytes.length + " bytes, not the " + expected + " of record");
  }
}

/**
 * Build and locally verify all five proofs. Throws on a non-positive gross,
 * a gross above the available figure, a split whose figures do not sum, a
 * malformed ciphertext or key, or a proof that fails local verification.
 */
export function buildTransferProofs(input: TransferProofInput): TransferProofs {
  const gross = input.grossBaseUnits;
  if (gross <= 0n) {
    throw new Error("refusing to transfer " + gross + " base units: the amount must be at least 1 base unit");
  }
  if (gross > input.availableBaseUnits) {
    throw new Error(
      "refusing to transfer " + gross + " base units: above the " + input.availableBaseUnits + " base units the confidential balance copy reads",
    );
  }
  const { feeAmount, claimedDeltaFee, netTransferAmount } = input.split;
  if (feeAmount + netTransferAmount !== gross || netTransferAmount < 0n) {
    throw new Error("the fee split does not sum to the gross: fee " + feeAmount + " + net " + netTransferAmount + " is not " + gross);
  }
  if (claimedDeltaFee < 0n || claimedDeltaFee > MAX_CLAIMED_DELTA_FEE) {
    throw new Error("the claimed delta fee " + claimedDeltaFee + " is outside 0.." + MAX_CLAIMED_DELTA_FEE);
  }
  if (input.availableBalanceCiphertext.length !== ELGAMAL_CIPHERTEXT_BYTES) {
    throw new Error(
      "the available-balance ciphertext is " + input.availableBalanceCiphertext.length + " bytes, not the " + ELGAMAL_CIPHERTEXT_BYTES + " an ElGamal ciphertext carries",
    );
  }
  requireKeyLength(input.destinationElgamalPubkey, "destination ElGamal public key");
  requireKeyLength(input.withdrawWithheldAuthorityElgamalPubkey, "withdraw-withheld authority ElGamal public key");
  const zeroAuditorKey = input.auditorElgamalPubkey === undefined;
  if (input.auditorElgamalPubkey !== undefined) {
    requireKeyLength(input.auditorElgamalPubkey, "auditor ElGamal public key");
  }

  const sourceKeypair = ElGamalKeypair.fromSecretKey(ElGamalSecretKey.fromBytes(input.elgamalSecretKey));
  const sourcePubkey = sourceKeypair.pubkey();
  const destinationPubkey = ElGamalPubkey.fromBytes(input.destinationElgamalPubkey);
  const auditorPubkey = ElGamalPubkey.fromBytes(input.auditorElgamalPubkey ?? new Uint8Array(ELGAMAL_PUBKEY_BYTES));
  const withheldPubkey = ElGamalPubkey.fromBytes(input.withdrawWithheldAuthorityElgamalPubkey);

  // The gross, lo/hi, encrypted under source, destination and auditor.
  const [transferLo, transferHi] = splitAmount(gross, TRANSFER_AMOUNT_LO_BIT_LENGTH);
  const transferOpeningLo = new PedersenOpening();
  const transferOpeningHi = new PedersenOpening();
  const transferGroupedLo = GroupedElGamalCiphertext3Handles.encryptWith(sourcePubkey, destinationPubkey, auditorPubkey, transferLo, transferOpeningLo);
  const transferGroupedHi = GroupedElGamalCiphertext3Handles.encryptWith(sourcePubkey, destinationPubkey, auditorPubkey, transferHi, transferOpeningHi);
  const transferGroupedLoBytes = new Uint8Array(transferGroupedLo.toBytes());
  const transferGroupedHiBytes = new Uint8Array(transferGroupedHi.toBytes());
  const transferSourceLo = extractCiphertextFromGroupedBytes(transferGroupedLoBytes, 0);
  const transferSourceHi = extractCiphertextFromGroupedBytes(transferGroupedHiBytes, 0);
  const transferAmountAuditorCiphertextLo = new Uint8Array(extractCiphertextFromGroupedBytes(transferGroupedLoBytes, 2));
  const transferAmountAuditorCiphertextHi = new Uint8Array(extractCiphertextFromGroupedBytes(transferGroupedHiBytes, 2));

  // 1. equality over the on-chain-reproducible remaining ciphertext.
  const remainingBaseUnits = input.availableBaseUnits - gross;
  const remainingBalanceCiphertext = new Uint8Array(
    subtractWithLoHiCiphertexts(input.availableBalanceCiphertext, transferSourceLo, transferSourceHi, TRANSFER_AMOUNT_LO_BIT_LENGTH),
  );
  const remainingCiphertext = ElGamalCiphertext.fromBytes(remainingBalanceCiphertext);
  if (remainingCiphertext === undefined) {
    throw new Error("the remaining-balance ciphertext does not parse as an ElGamal ciphertext");
  }
  const remainingOpening = new PedersenOpening();
  const remainingCommitment = PedersenCommitment.from(remainingBaseUnits, remainingOpening);
  const equality = new CiphertextCommitmentEqualityProofData(sourceKeypair, remainingCiphertext, remainingCommitment, remainingOpening, remainingBaseUnits);
  equality.verify();

  // 2. the two transfer ciphertexts are valid under all three keys.
  const transferValidity = new BatchedGroupedCiphertext3HandlesValidityProofData(
    sourcePubkey, destinationPubkey, auditorPubkey, transferGroupedLo, transferGroupedHi, transferLo, transferHi, transferOpeningLo, transferOpeningHi,
  );
  transferValidity.verify();

  // The gross as one commitment, for the fee arithmetic below.
  const transferCommitmentLo = PedersenCommitment.fromBytes(transferGroupedLoBytes.slice(0, 32));
  const transferCommitmentHi = PedersenCommitment.fromBytes(transferGroupedHiBytes.slice(0, 32));
  const combinedTransferCommitment = PedersenCommitment.combineLoHi(transferCommitmentLo, transferCommitmentHi, Number(TRANSFER_AMOUNT_LO_BIT_LENGTH));
  const combinedTransferOpening = PedersenOpening.combineLoHi(transferOpeningLo, transferOpeningHi, Number(TRANSFER_AMOUNT_LO_BIT_LENGTH));

  // The fee, lo/hi, encrypted under destination and withdraw-withheld authority.
  const [feeLo, feeHi] = splitAmount(feeAmount, FEE_AMOUNT_LO_BIT_LENGTH);
  const feeOpeningLo = new PedersenOpening();
  const feeOpeningHi = new PedersenOpening();
  const feeGroupedLo = GroupedElGamalCiphertext2Handles.encryptWith(destinationPubkey, withheldPubkey, feeLo, feeOpeningLo);
  const feeGroupedHi = GroupedElGamalCiphertext2Handles.encryptWith(destinationPubkey, withheldPubkey, feeHi, feeOpeningHi);
  const feeGroupedLoBytes = new Uint8Array(feeGroupedLo.toBytes());
  const feeGroupedHiBytes = new Uint8Array(feeGroupedHi.toBytes());
  const feeCommitmentLo = PedersenCommitment.fromBytes(feeGroupedLoBytes.slice(0, 32));
  const feeCommitmentHi = PedersenCommitment.fromBytes(feeGroupedHiBytes.slice(0, 32));
  const combinedFeeCommitment = PedersenCommitment.combineLoHi(feeCommitmentLo, feeCommitmentHi, Number(FEE_AMOUNT_LO_BIT_LENGTH));
  const combinedFeeOpening = PedersenOpening.combineLoHi(feeOpeningLo, feeOpeningHi, Number(FEE_AMOUNT_LO_BIT_LENGTH));

  // 3. percentage with cap on the schedule's own bps and cap.
  const netCommitment = combinedTransferCommitment.subtract(combinedFeeCommitment);
  const netOpening = combinedTransferOpening.subtract(combinedFeeOpening);
  const claimedOpening = new PedersenOpening();
  const claimedCommitment = PedersenCommitment.from(claimedDeltaFee, claimedOpening);
  const bps = BigInt(input.schedule.basisPoints);
  const deltaCommitment = combinedFeeCommitment.multiplyByU64(MAX_FEE_BASIS_POINTS).subtract(combinedTransferCommitment.multiplyByU64(bps));
  const deltaOpening = combinedFeeOpening.multiplyByU64(MAX_FEE_BASIS_POINTS).subtract(combinedTransferOpening.multiplyByU64(bps));
  const percentageWithCap = new PercentageWithCapProofData(
    combinedFeeCommitment, combinedFeeOpening, feeAmount, deltaCommitment, deltaOpening, claimedDeltaFee, claimedCommitment, claimedOpening, input.schedule.maximumFee,
  );
  percentageWithCap.verify();

  // 4. the two fee ciphertexts are valid under both keys.
  const feeValidity = new BatchedGroupedCiphertext2HandlesValidityProofData(
    destinationPubkey, withheldPubkey, feeGroupedLo, feeGroupedHi, feeLo, feeHi, feeOpeningLo, feeOpeningHi,
  );
  feeValidity.verify();

  // 5. range, eight slots. The complement slot proves 'claimed' is at most 9999.
  const zeroOpening = PedersenOpening.zero();
  const maxDeltaCommitment = PedersenCommitment.from(MAX_CLAIMED_DELTA_FEE, zeroOpening);
  const claimedComplementCommitment = maxDeltaCommitment.subtract(claimedCommitment);
  const claimedComplementOpening = zeroOpening.subtract(claimedOpening);
  const claimedComplement = MAX_CLAIMED_DELTA_FEE - claimedDeltaFee;
  // LAST: this constructor consumes every commitment and opening handed to it.
  const range = new BatchedRangeProofU256Data(
    [remainingCommitment, transferCommitmentLo, transferCommitmentHi, claimedCommitment, claimedComplementCommitment, feeCommitmentLo, feeCommitmentHi, netCommitment],
    new BigUint64Array([remainingBaseUnits, transferLo, transferHi, claimedDeltaFee, claimedComplement, feeLo, feeHi, netTransferAmount]),
    Uint8Array.from([
      REMAINING_BALANCE_BIT_LENGTH, Number(TRANSFER_AMOUNT_LO_BIT_LENGTH), Number(TRANSFER_AMOUNT_HI_BIT_LENGTH),
      DELTA_BIT_LENGTH, DELTA_BIT_LENGTH, Number(FEE_AMOUNT_LO_BIT_LENGTH), Number(FEE_AMOUNT_HI_BIT_LENGTH), NET_TRANSFER_AMOUNT_BIT_LENGTH,
    ]),
    [remainingOpening, transferOpeningLo, transferOpeningHi, claimedOpening, claimedComplementOpening, feeOpeningLo, feeOpeningHi, netOpening],
  );
  range.verify();

  const equalityProof = new Uint8Array(equality.toBytes());
  const transferValidityProof = new Uint8Array(transferValidity.toBytes());
  const percentageWithCapProof = new Uint8Array(percentageWithCap.toBytes());
  const feeValidityProof = new Uint8Array(feeValidity.toBytes());
  const rangeProof = new Uint8Array(range.toBytes());
  requireProofLength(equalityProof, EQUALITY_PROOF_BYTES, "equality proof");
  requireProofLength(transferValidityProof, VALIDITY_3_HANDLES_PROOF_BYTES, "transfer validity proof");
  requireProofLength(percentageWithCapProof, PERCENTAGE_WITH_CAP_PROOF_BYTES, "percentage-with-cap proof");
  requireProofLength(feeValidityProof, VALIDITY_2_HANDLES_PROOF_BYTES, "fee validity proof");
  requireProofLength(rangeProof, RANGE_U256_PROOF_BYTES, "range proof");
  return {
    equalityProof,
    transferValidityProof,
    percentageWithCapProof,
    feeValidityProof,
    rangeProof,
    transferAmountAuditorCiphertextLo,
    transferAmountAuditorCiphertextHi,
    remainingBaseUnits,
    remainingBalanceCiphertext,
    zeroAuditorKey,
  };
}
