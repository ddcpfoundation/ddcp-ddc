// Offline tests for the two `unshield` proofs and the ONE version-1
// transaction that carries them. No network; no live path is mocked. Proof
// bytes are random per run, so as in confidential-setup-tx.test.ts every
// assertion is over structure, numbers and lengths.
//
// THE ASSERTIONS THAT EARN THEIR KEEP: the stale-copy refusal (a proof built
// over a wrong plaintext fails LOCALLY, before any send), the discriminator
// pairs read off encoded bytes (27/6 for Withdraw beside 27/8 for
// ApplyPendingBalance one word away; 3 and 6 for the two verifies), the proof
// offsets read off the withdraw bytes as SIGNED values equal to the proofs'
// positions relative to the withdraw, and the account order of Withdraw WITH
// the instructions sysvar, because both offsets are non-zero. That last
// assertion is the inverse of the one the five-transaction shape carried, and
// it inverts for the reason stated: the processor consumes the sysvar exactly
// when it must locate a proof by relative index.
//
// THE VERSION IS PINNED FROM THE BYTES, not from the message object alone:
// message byte zero reads 0x81, the wire is above the legacy limit and below
// the version-1 limit, and both limits are present on the message while the
// priority fee is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, getTransactionEncoder } from "@solana/kit";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/node";
import { DDC_MINT } from "../constants.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";
import {
  buildUnshieldProofs,
  EQUALITY_PROOF_BYTES,
  RANGE_U64_PROOF_BYTES,
} from "./unshield-proofs.js";
import {
  assembleUnshieldTransaction,
  UNSHIELD_COMPUTE_UNIT_LIMIT,
  UNSHIELD_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  V1_TRANSACTION_SIZE_LIMIT_BYTES,
} from "./unshield-tx.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZK_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
const LEGACY_TRANSACTION_SIZE_LIMIT_BYTES = 1232;

// Measured on devnet at maxed limits; the shipped limits must clear both.
const MEASURED_COMPUTE_UNITS = 124_157;
const MEASURED_LOADED_ACCOUNTS_DATA_BYTES = 712_728;

// TEST-ONLY double cast, as in confidential-setup-tx.test.ts: the module only
// carries the value into the lifetime setter. A distinct 32-byte value, not a
// key or mint the assertions below also name.
const TEST_BLOCKHASH = {
  blockhash: "9m4ZX1kQ5cPrmNP6rB3rZQ3kSakDJdEQ5F4ZTMVTAHN1",
  lastValidBlockHeight: 0n,
} as unknown as BlockhashLifetime;

interface AnyInstruction {
  programAddress: string;
  data?: Uint8Array;
  accounts?: readonly { address: string }[];
}
const instructionsOf = (result: { message: { instructions: unknown } }) =>
  result.message.instructions as unknown as AnyInstruction[];

const AVAILABLE = 1_000_000n;
const AMOUNT = 250_000n;

function proofsForTest(availableCopy: bigint = AVAILABLE) {
  const keypair = new ElGamalKeypair();
  const availableBalanceCiphertext = new Uint8Array(
    keypair.pubkey().encryptU64(AVAILABLE).toBytes(),
  );
  const elgamalSecretKey = new Uint8Array(keypair.secret().toBytes());
  return buildUnshieldProofs({
    elgamalSecretKey,
    availableBalanceCiphertext,
    availableBaseUnits: availableCopy,
    amountBaseUnits: AMOUNT,
  });
}

test("the two proofs verify locally and serialize to 320 and 936 bytes", () => {
  const proofs = proofsForTest();
  assert.equal(proofs.equalityProof.length, EQUALITY_PROOF_BYTES);
  assert.equal(proofs.rangeProof.length, RANGE_U64_PROOF_BYTES);
  assert.equal(proofs.remainingBaseUnits, AVAILABLE - AMOUNT);
  assert.equal(proofs.remainingBalanceCiphertext.length, 64);
});

test("a STALE balance copy is refused locally: the proof over the wrong plaintext fails verify()", () => {
  // The ciphertext encrypts 1,000,000; the copy claims 1,000,005. The
  // equality proof is over the wrong figure and must not leave the machine.
  assert.throws(() => proofsForTest(AVAILABLE + 5n));
});

test("zero and over-balance amounts are refused before any proof is built", () => {
  const keypair = new ElGamalKeypair();
  const base = {
    elgamalSecretKey: new Uint8Array(keypair.secret().toBytes()),
    availableBalanceCiphertext: new Uint8Array(keypair.pubkey().encryptU64(AVAILABLE).toBytes()),
    availableBaseUnits: AVAILABLE,
  };
  assert.throws(() => buildUnshieldProofs({ ...base, amountBaseUnits: 0n }), /at least 1 base unit/);
  assert.throws(() => buildUnshieldProofs({ ...base, amountBaseUnits: AVAILABLE + 1n }), /above the/);
});

async function assembleOne() {
  const signer = await generateKeyPairSigner();
  const proofs = proofsForTest();
  const aeKey = new Uint8Array(new AeKey().toBytes());
  const newDecryptableAvailableBalance = new Uint8Array(
    AeKey.fromBytes(aeKey).encrypt(proofs.remainingBaseUnits).toBytes(),
  );
  const result = await assembleUnshieldTransaction({
    signer,
    mint: DDC_MINT,
    amountBaseUnits: AMOUNT,
    newDecryptableAvailableBalance,
    equalityProof: proofs.equalityProof,
    rangeProof: proofs.rangeProof,
    blockhash: TEST_BLOCKHASH,
  });
  return { signer, ...result };
}

test("one transaction, three instructions in order: equality verify, range verify, withdraw", async () => {
  const one = await assembleOne();
  assert.deepEqual(instructionsOf(one).map((ix) => ix.programAddress), [ZK_PROOF_PROGRAM, ZK_PROOF_PROGRAM, TOKEN_2022]);
});

test("discriminators off encoded bytes: verifies 3 and 6 with the proofs INLINE, Withdraw 27/6 (not ApplyPendingBalance 27/8)", async () => {
  const one = await assembleOne();
  const [eqVerify, rangeVerify, withdraw] = instructionsOf(one);
  assert.ok(eqVerify?.data && rangeVerify?.data && withdraw?.data);
  assert.equal(eqVerify.data[0], 3);
  assert.equal(eqVerify.data.length, 1 + EQUALITY_PROOF_BYTES, "equality proof inline");
  assert.equal(rangeVerify.data[0], 6);
  assert.equal(rangeVerify.data.length, 1 + RANGE_U64_PROOF_BYTES, "range proof inline");
  assert.equal(withdraw.data[0], 27);
  assert.equal(withdraw.data[1], 6);
});

test("the verifies carry NO accounts: nothing is written to a stored-result account", async () => {
  const one = await assembleOne();
  const [eqVerify, rangeVerify] = instructionsOf(one);
  assert.equal(eqVerify?.accounts?.length ?? 0, 0);
  assert.equal(rangeVerify?.accounts?.length ?? 0, 0);
});

test("Withdraw data: amount, decimals 6, 36-byte copy, proof offsets -2 and -1 read as SIGNED bytes — 49 bytes", async () => {
  const one = await assembleOne();
  const instructions = instructionsOf(one);
  const data = instructions[2]?.data;
  assert.ok(data);
  assert.equal(data.length, 2 + 8 + 1 + 36 + 1 + 1);
  const view = new DataView(data.buffer, data.byteOffset);
  assert.equal(view.getBigUint64(2, true), AMOUNT);
  assert.equal(data[10], 6);
  // The offsets are the proofs' positions relative to the withdraw, so they are
  // re-derived here from the array rather than restated as literals.
  const withdrawIndex = 2;
  assert.equal(view.getInt8(47), 0 - withdrawIndex);
  assert.equal(view.getInt8(48), 1 - withdrawIndex);
  assert.equal(view.getInt8(47), -2);
  assert.equal(view.getInt8(48), -1);
});

test("Withdraw accounts: token, mint, instructions sysvar, authority — WITH the sysvar, because the offsets are non-zero", async () => {
  const one = await assembleOne();
  const accounts = instructionsOf(one)[2]?.accounts?.map((a) => a.address);
  assert.ok(accounts);
  assert.equal(accounts.length, 4);
  assert.equal(accounts[0], one.tokenAccount);
  assert.equal(accounts[1], DDC_MINT);
  assert.equal(accounts[2], SYSVAR_INSTRUCTIONS);
  assert.equal(accounts[3], one.signer.address);
});

test("one signature slot, the signer's, filled", async () => {
  const one = await assembleOne();
  const entries = Object.entries((one.transaction as { signatures: Record<string, unknown> }).signatures);
  assert.deepEqual(entries.map(([address]) => address), [one.signer.address]);
  for (const [, sig] of entries) assert.ok(sig, "the slot must be filled");
});

test("version 1: both limits set on the message above the measured figures, no priority fee, no ComputeBudget instruction", async () => {
  const one = await assembleOne();
  const message = one.message as { version: unknown; config?: Record<string, unknown> };
  assert.equal(message.version, 1);
  assert.ok(message.config);
  assert.equal(message.config["computeUnitLimit"], UNSHIELD_COMPUTE_UNIT_LIMIT);
  assert.equal(message.config["loadedAccountsDataSizeLimit"], UNSHIELD_LOADED_ACCOUNTS_DATA_SIZE_LIMIT);
  assert.ok(UNSHIELD_COMPUTE_UNIT_LIMIT > MEASURED_COMPUTE_UNITS, "compute limit must clear the measured units");
  assert.ok(UNSHIELD_LOADED_ACCOUNTS_DATA_SIZE_LIMIT > MEASURED_LOADED_ACCOUNTS_DATA_BYTES, "data-size limit must clear the measured bytes");
  assert.equal(message.config["priorityFeeLamports"], undefined);
  assert.equal(message.config["heapSize"], undefined);
  assert.ok(instructionsOf(one).every((ix) => ix.programAddress !== COMPUTE_BUDGET));
});

// WIRE SIZE, MEASURED: above the legacy packet, inside the version-1 limit.
// Proof bytes vary, their length does not.
test("wire size 1629 bytes: message byte zero 0x81, above 1232, below 4096", async () => {
  const one = await assembleOne();
  const wire = getTransactionEncoder().encode(one.transaction as never);
  console.log(`unshield wire size: ${wire.length} bytes`);
  assert.equal(wire.length, 1629);
  assert.equal(wire[0], 0x81);
  assert.ok(wire.length > LEGACY_TRANSACTION_SIZE_LIMIT_BYTES, "a legacy shape would fit; the version-1 gate would be unearned");
  assert.ok(wire.length <= V1_TRANSACTION_SIZE_LIMIT_BYTES);
  assert.equal(V1_TRANSACTION_SIZE_LIMIT_BYTES, 4096);
});
