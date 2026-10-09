// Tests for the five 'transfer' proofs. Proof bytes are random per run, so
// these pin lengths, local verification, the arithmetic the caller relies
// on, and the throw cases -- never a byte vector of a proof. The source
// balance ciphertext is a fresh encryption under a seeded keypair; the
// chain-side check is byte equality against the program's OWN subtraction
// of the transfer ciphertexts, which is why the remainder is per-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ElGamalKeypair } from "@solana/zk-sdk/node";
import { subtractAmountFromCiphertext } from "../vendor/confidentialTransferArithmetic.js";
import {
  buildTransferProofs,
  PERCENTAGE_WITH_CAP_PROOF_BYTES,
  RANGE_U256_PROOF_BYTES,
  VALIDITY_2_HANDLES_PROOF_BYTES,
  VALIDITY_3_HANDLES_PROOF_BYTES,
  type TransferProofInput,
} from "./transfer-proofs.js";
import { EQUALITY_PROOF_BYTES } from "./unshield-proofs.js";
import { grossForNet } from "./transfer-fee-gross.js";
import { splitTransferFee, type TransferFeeSchedule } from "./transfer-fee-split.js";

const DEVNET: TransferFeeSchedule = { epoch: 1108n, maximumFee: 1_000_000n, basisPoints: 100 };
const ZERO: TransferFeeSchedule = { epoch: 0n, maximumFee: 0n, basisPoints: 0 };
const AVAILABLE = 600_500_000n;

const source = ElGamalKeypair.fromSeedPhraseAndPassphrase("transfer-proofs test source");
const destination = ElGamalKeypair.fromSeedPhraseAndPassphrase("transfer-proofs test destination");
const withheld = ElGamalKeypair.fromSeedPhraseAndPassphrase("transfer-proofs test withheld authority");
const auditor = ElGamalKeypair.fromSeedPhraseAndPassphrase("transfer-proofs test auditor");

function bytes(x: { toBytes(): Uint8Array }): Uint8Array {
  return new Uint8Array(x.toBytes());
}

/** A fresh input set: a new available-balance ciphertext each call, so no test shares mutable state. */
function inputFor(net: bigint, schedule: TransferFeeSchedule, overrides: Partial<TransferProofInput> = {}): TransferProofInput {
  const g = grossForNet(net, schedule);
  return {
    elgamalSecretKey: bytes(source.secret()),
    availableBalanceCiphertext: bytes(source.pubkey().encryptU64(AVAILABLE)),
    availableBaseUnits: AVAILABLE,
    grossBaseUnits: g.grossBaseUnits,
    split: g.split,
    schedule,
    destinationElgamalPubkey: bytes(destination.pubkey()),
    auditorElgamalPubkey: undefined,
    withdrawWithheldAuthorityElgamalPubkey: bytes(withheld.pubkey()),
    ...overrides,
  };
}

function assertLengths(p: ReturnType<typeof buildTransferProofs>) {
  assert.equal(p.equalityProof.length, EQUALITY_PROOF_BYTES);
  assert.equal(p.transferValidityProof.length, VALIDITY_3_HANDLES_PROOF_BYTES);
  assert.equal(p.percentageWithCapProof.length, PERCENTAGE_WITH_CAP_PROOF_BYTES);
  assert.equal(p.feeValidityProof.length, VALIDITY_2_HANDLES_PROOF_BYTES);
  assert.equal(p.rangeProof.length, RANGE_U256_PROOF_BYTES);
  assert.equal(p.transferAmountAuditorCiphertextLo.length, 64);
  assert.equal(p.transferAmountAuditorCiphertextHi.length, 64);
  assert.equal(p.remainingBalanceCiphertext.length, 64);
}

test("transfer proofs: sizes of record are 320 / 544 / 360 / 416 / 1064", () => {
  assert.deepEqual(
    [EQUALITY_PROOF_BYTES, VALIDITY_3_HANDLES_PROOF_BYTES, PERCENTAGE_WITH_CAP_PROOF_BYTES, VALIDITY_2_HANDLES_PROOF_BYTES, RANGE_U256_PROOF_BYTES],
    [320, 544, 360, 416, 1064],
  );
});

test("transfer proofs: 100 DDC to the recipient under the devnet schedule, capped fee, zero auditor key", () => {
  const input = inputFor(100_000_000n, DEVNET);
  assert.equal(input.grossBaseUnits, 101_000_000n);
  assert.equal(input.split.capped, true);
  const p = buildTransferProofs(input);
  assertLengths(p);
  assert.equal(p.zeroAuditorKey, true);
  assert.equal(p.remainingBaseUnits, AVAILABLE - 101_000_000n);
});

test("transfer proofs: the remaining ciphertext is NOT the single-amount subtraction unshield uses", () => {
  // Unlike Withdraw, which subtracts amount*G with no randomness, the
  // TransferWithFee processor subtracts the transfer's own source
  // ciphertexts, whose openings are random per run. The remainder therefore
  // carries this run's openings, and the equality proof is bound to the
  // ciphertexts built in the same call -- they cannot be mixed across runs.
  const input = inputFor(100_000_000n, DEVNET);
  const p = buildTransferProofs(input);
  assert.notDeepEqual(
    p.remainingBalanceCiphertext,
    new Uint8Array(subtractAmountFromCiphertext(input.availableBalanceCiphertext, input.grossBaseUnits)),
  );
});

test("transfer proofs: the smallest transfer, uncapped, claimed delta 9800", () => {
  const input = inputFor(1n, DEVNET);
  assert.equal(input.grossBaseUnits, 2n);
  assert.equal(input.split.claimedDeltaFee, 9_800n);
  const p = buildTransferProofs(input);
  assertLengths(p);
  assert.equal(p.remainingBaseUnits, AVAILABLE - 2n);
});

test("transfer proofs: a mint auditor key is used when given", () => {
  const p = buildTransferProofs(inputFor(1_000_000n, DEVNET, { auditorElgamalPubkey: bytes(auditor.pubkey()) }));
  assertLengths(p);
  assert.equal(p.zeroAuditorKey, false);
});

test("transfer proofs: the zero schedule, fee 0 and delta 0", () => {
  const input = inputFor(250_000n, ZERO);
  assert.equal(input.split.feeAmount, 0n);
  const p = buildTransferProofs(input);
  assertLengths(p);
  assert.equal(p.remainingBaseUnits, AVAILABLE - 250_000n);
});

test("transfer proofs: two runs on one input set differ in bytes and neither consumes the input", () => {
  const input = inputFor(5_000_000n, DEVNET);
  const before = Uint8Array.from(input.availableBalanceCiphertext);
  const a = buildTransferProofs(input);
  const b = buildTransferProofs(input);
  assertLengths(a);
  assertLengths(b);
  assert.notDeepEqual(a.rangeProof, b.rangeProof);
  assert.deepEqual(input.availableBalanceCiphertext, before);
  assert.notDeepEqual(a.remainingBalanceCiphertext, b.remainingBalanceCiphertext);
});

test("transfer proofs: a stale available figure fails the equality proof locally, before any send", () => {
  // The AES copy says more than the ciphertext holds (the raced-apply case
  // in reverse): the equality proof over the true remainder does not hold
  // for the claimed figure and local verification throws.
  const input = inputFor(1_000_000n, DEVNET, { availableBaseUnits: AVAILABLE + 1n });
  assert.throws(() => buildTransferProofs(input));
});

test("transfer proofs: refusals by name before any proof is built", () => {
  assert.throws(() => buildTransferProofs(inputFor(1n, DEVNET, { grossBaseUnits: 0n })), /at least 1 base unit/);
  assert.throws(() => buildTransferProofs(inputFor(1n, DEVNET, { grossBaseUnits: AVAILABLE + 1n })), /above the/);
  const g = grossForNet(1_000_000n, DEVNET);
  assert.throws(
    () => buildTransferProofs(inputFor(1_000_000n, DEVNET, { split: splitTransferFee(g.grossBaseUnits + 1n, DEVNET) })),
    /does not sum to the gross/,
  );
  assert.throws(() => buildTransferProofs(inputFor(1n, DEVNET, { availableBalanceCiphertext: new Uint8Array(63) })), /not the 64/);
  assert.throws(() => buildTransferProofs(inputFor(1n, DEVNET, { destinationElgamalPubkey: new Uint8Array(31) })), /destination ElGamal public key is 31/);
  assert.throws(() => buildTransferProofs(inputFor(1n, DEVNET, { withdrawWithheldAuthorityElgamalPubkey: new Uint8Array(33) })), /withdraw-withheld authority ElGamal public key is 33/);
  assert.throws(() => buildTransferProofs(inputFor(1n, DEVNET, { auditorElgamalPubkey: new Uint8Array(1) })), /auditor ElGamal public key is 1/);
});
