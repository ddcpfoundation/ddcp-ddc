// Offline unit tests for the shield assembly. No network, no live path mocked;
// the devnet run proves the broadcast path and this file proves what would be
// broadcast. Every test name here is prefixed `shield-tx:` so that it cannot
// collide with the sibling apply-pending-tx tests, which pin the same
// ApplyPendingBalance bytes on a one-instruction transaction.
//
// BOTH GOLDEN VECTORS ARE HAND-DERIVED, NOT CAPTURED. Every byte comes from
// the WIRE LAYOUT read at pinned Rust source, never from running the encoder
// and pasting its output.
//
// PROVENANCE, INSTRUCTION 0 — Deposit:
//   byte 0      27 — TokenInstruction::ConfidentialTransferExtension
//   byte 1       5 — ConfidentialTransferInstruction::Deposit, enum position 5
//                    under repr(u8), counted in the pinned source
//   bytes 2-9      — amount, u64 LITTLE-ENDIAN
//   byte 10        — decimals, u8
// Total 11 = 1 + 1 + 8 + 1.
//
// PROVENANCE, INSTRUCTION 1 — ApplyPendingBalance, as tx/apply-pending-tx.test.ts:
//   byte 0      27, byte 1  8, bytes 2-9 the expected counter u64 LE, bytes
//   10-45 the 36-byte AES ciphertext. Total 46.
//
// THE TEST INPUTS MAKE EACH FAILURE MODE VISIBLE IN THE LITERAL. The amount
// 0x060504030201 sits inside the 2^48 - 1 cap and renders little-endian as an
// ascending six-byte run followed by two zero bytes, so a byte-order flip reads
// backwards and a width error truncates the run. The counter AS READ is
// 0x0807060504030200; the module adds one, so the bytes written into
// ApplyPendingBalance are the ascending run 01..08 — a forgotten increment
// shows as a trailing 00, an increment applied twice as a trailing 02.
//
// IF THE ENCODER DISAGREES WITH THESE BYTES, THAT IS A FINDING TO ESCALATE,
// NEVER A NUMBER TO UPDATE.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  getApplyConfidentialPendingBalanceInstructionDataDecoder,
  getConfidentialDepositInstructionDataDecoder,
} from "@solana-program/token-2022";
import { DDC_DECIMALS } from "../amount.js";
import { DDC_MINT } from "../constants.js";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import {
  MAXIMUM_DEPOSIT_TRANSFER_AMOUNT,
  assembleShieldTransaction,
  type ShieldInput,
} from "./shield-tx.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

// See PROVENANCE above. None of these numbers is imported from the package under test.
const EXTENSION_DISCRIMINATOR = 27;
const DEPOSIT_DISCRIMINATOR = 5;
const APPLY_PENDING_DISCRIMINATOR = 8;
const DEPOSIT_DATA_BYTES = 1 + 1 + 8 + 1;
const APPLY_DATA_BYTES = 1 + 1 + 8 + DECRYPTABLE_BALANCE_BYTES;

// 0x060504030201: inside the cap; little-endian 01 02 03 04 05 06 00 00.
const TEST_AMOUNT = 6618611909121n;
// 0x0807060504030200 as read; the module writes 0x0807060504030201.
const TEST_COUNTER_AT_READ = 578437695752307200n;
const TEST_COUNTER_EXPECTED = 578437695752307201n;

// 36 ascending bytes from 0x10, so an offset error breaks the run visibly.
const TEST_CIPHERTEXT = new Uint8Array(
  Array.from({ length: DECRYPTABLE_BALANCE_BYTES }, (_, i) => 0x10 + i),
);

const GOLDEN_DEPOSIT_DATA = new Uint8Array([
  27, 5,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x00, 0x00,
  6,
]);

const GOLDEN_APPLY_DATA = new Uint8Array([
  27, 8,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21,
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33,
]);

// A syntactically valid 32-byte base58 blockhash. TEST-ONLY double cast, as in
// the siblings: the branded type has no constructor this build has verified.
const TEST_BLOCKHASH = {
  blockhash: "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa",
  lastValidBlockHeight: 0n,
} as unknown as BlockhashLifetime;

// TEST-ONLY narrowing; the only fields this file reads.
interface AnyAccount {
  address: string;
  role: number;
}
interface AnyInstruction {
  programAddress: string;
  data?: Uint8Array;
  accounts?: readonly AnyAccount[];
}

async function assembleForTest(overrides: Partial<ShieldInput> = {}) {
  const signer = await generateKeyPairSigner();
  const result = await assembleShieldTransaction({
    signer,
    mint: DDC_MINT,
    amountBaseUnits: TEST_AMOUNT,
    newDecryptableAvailableBalance: TEST_CIPHERTEXT,
    pendingBalanceCreditCounterAtRead: TEST_COUNTER_AT_READ,
    blockhash: TEST_BLOCKHASH,
    ...overrides,
  });
  const instructions = result.message
    .instructions as unknown as AnyInstruction[];
  return { signer, result, instructions };
}

test("shield-tx: the two golden vectors are 11 and 46 bytes, open with their discriminator pairs, and their integer fields read back little-endian", () => {
  assert.equal(GOLDEN_DEPOSIT_DATA.length, DEPOSIT_DATA_BYTES);
  assert.equal(DEPOSIT_DATA_BYTES, 11);
  assert.equal(GOLDEN_DEPOSIT_DATA[0], EXTENSION_DISCRIMINATOR);
  assert.equal(GOLDEN_DEPOSIT_DATA[1], DEPOSIT_DISCRIMINATOR);
  const depositView = new DataView(
    GOLDEN_DEPOSIT_DATA.buffer,
    GOLDEN_DEPOSIT_DATA.byteOffset,
  );
  assert.equal(depositView.getBigUint64(2, true), TEST_AMOUNT);
  assert.equal(GOLDEN_DEPOSIT_DATA[10], DDC_DECIMALS);
  assert.equal(GOLDEN_APPLY_DATA.length, APPLY_DATA_BYTES);
  assert.equal(APPLY_DATA_BYTES, 46);
  assert.equal(GOLDEN_APPLY_DATA[0], EXTENSION_DISCRIMINATOR);
  assert.equal(GOLDEN_APPLY_DATA[1], APPLY_PENDING_DISCRIMINATOR);
  const applyView = new DataView(
    GOLDEN_APPLY_DATA.buffer,
    GOLDEN_APPLY_DATA.byteOffset,
  );
  assert.equal(applyView.getBigUint64(2, true), TEST_COUNTER_EXPECTED);
  assert.equal(TEST_COUNTER_EXPECTED, TEST_COUNTER_AT_READ + 1n);
  assert.deepEqual(GOLDEN_APPLY_DATA.subarray(10), TEST_CIPHERTEXT);
});

test("shield-tx GOLDEN: instruction 0 is Deposit and instruction 1 is ApplyPendingBalance, each equal to its hand-derived vector byte for byte", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 2);
  assert.ok(instructions[0]?.data);
  assert.ok(instructions[1]?.data);
  assert.deepEqual(new Uint8Array(instructions[0].data), GOLDEN_DEPOSIT_DATA);
  assert.deepEqual(new Uint8Array(instructions[1].data), GOLDEN_APPLY_DATA);
});

test("shield-tx: the expected counter written is the counter as read plus exactly one, returned to the caller and pinned off the bytes", async () => {
  const { result, instructions } = await assembleForTest();
  assert.equal(result.expectedPendingBalanceCreditCounter, TEST_COUNTER_AT_READ + 1n);
  assert.ok(instructions[1]?.data);
  const view = new DataView(
    instructions[1].data.buffer,
    instructions[1].data.byteOffset,
    instructions[1].data.byteLength,
  );
  assert.equal(view.getBigUint64(2, true), TEST_COUNTER_AT_READ + 1n);
  // Zero as read: the first-ever credit on an account writes expected 1.
  const fromZero = await assembleForTest({ pendingBalanceCreditCounterAtRead: 0n });
  assert.equal(fromZero.result.expectedPendingBalanceCreditCounter, 1n);
});

test("shield-tx: two instructions, both on Token-2022, in that order, and no ComputeBudget instruction anywhere", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0]?.programAddress, TOKEN_2022);
  assert.equal(instructions[1]?.programAddress, TOKEN_2022);
  assert.equal(instructions[0]?.data?.[1], DEPOSIT_DISCRIMINATOR);
  assert.equal(instructions[1]?.data?.[1], APPLY_PENDING_DISCRIMINATOR);
  for (const ix of instructions) {
    assert.notEqual(ix.programAddress, COMPUTE_BUDGET);
  }
});

test("shield-tx: Deposit carries token WRITABLE, mint READONLY, authority READONLY_SIGNER; ApplyPendingBalance carries token WRITABLE, authority READONLY_SIGNER", async () => {
  const { signer, result, instructions } = await assembleForTest();
  const deposit = instructions[0]?.accounts;
  assert.ok(deposit);
  assert.equal(deposit.length, 3);
  assert.equal(deposit[0]?.address, result.tokenAccount);
  assert.equal(deposit[0]?.role, AccountRole.WRITABLE);
  assert.equal(deposit[1]?.address, DDC_MINT);
  assert.equal(deposit[1]?.role, AccountRole.READONLY);
  assert.equal(deposit[2]?.address, signer.address);
  assert.equal(deposit[2]?.role, AccountRole.READONLY_SIGNER);
  const apply = instructions[1]?.accounts;
  assert.ok(apply);
  assert.equal(apply.length, 2);
  assert.equal(apply[0]?.address, result.tokenAccount);
  assert.equal(apply[0]?.role, AccountRole.WRITABLE);
  assert.equal(apply[1]?.address, signer.address);
  assert.equal(apply[1]?.role, AccountRole.READONLY_SIGNER);
});

test("shield-tx decoder cross-check: both generated decoders read back the fields as supplied", async () => {
  const { instructions } = await assembleForTest();
  assert.ok(instructions[0]?.data);
  assert.ok(instructions[1]?.data);
  const deposit = getConfidentialDepositInstructionDataDecoder().decode(instructions[0].data);
  assert.equal(deposit.discriminator, EXTENSION_DISCRIMINATOR);
  assert.equal(deposit.confidentialTransferDiscriminator, DEPOSIT_DISCRIMINATOR);
  assert.equal(deposit.amount, TEST_AMOUNT);
  assert.equal(deposit.decimals, DDC_DECIMALS);
  const apply = getApplyConfidentialPendingBalanceInstructionDataDecoder().decode(instructions[1].data);
  assert.equal(apply.discriminator, EXTENSION_DISCRIMINATOR);
  assert.equal(apply.confidentialTransferDiscriminator, APPLY_PENDING_DISCRIMINATOR);
  assert.equal(apply.expectedPendingBalanceCreditCounter, TEST_COUNTER_EXPECTED);
  assert.deepEqual(new Uint8Array(apply.newDecryptableAvailableBalance), TEST_CIPHERTEXT);
  // Shares a codec with the encoder, so it cannot catch a coordinated change;
  // the golden vectors above are the guard.
});

test("shield-tx determinism: two assemblies over identical inputs produce identical instruction data for both instructions", async () => {
  const signer = await generateKeyPairSigner();
  const input = {
    signer,
    mint: DDC_MINT,
    amountBaseUnits: TEST_AMOUNT,
    newDecryptableAvailableBalance: TEST_CIPHERTEXT,
    pendingBalanceCreditCounterAtRead: TEST_COUNTER_AT_READ,
    blockhash: TEST_BLOCKHASH,
  };
  const a = await assembleShieldTransaction(input);
  const b = await assembleShieldTransaction(input);
  const dataOf = (
    r: Awaited<ReturnType<typeof assembleShieldTransaction>>,
    i: number,
  ) => (r.message.instructions as unknown as AnyInstruction[])[i]?.data;
  assert.deepEqual(dataOf(a, 0), dataOf(b, 0));
  assert.deepEqual(dataOf(a, 1), dataOf(b, 1));
});

test("shield-tx: the amount cap is 2^48 - 1; the cap itself assembles, the cap plus one and zero are refused before assembly", async () => {
  assert.equal(MAXIMUM_DEPOSIT_TRANSFER_AMOUNT, 281474976710655n);
  assert.equal(MAXIMUM_DEPOSIT_TRANSFER_AMOUNT, (1n << 48n) - 1n);
  const atCap = await assembleForTest({ amountBaseUnits: MAXIMUM_DEPOSIT_TRANSFER_AMOUNT });
  assert.equal(atCap.instructions.length, 2);
  const signer = await generateKeyPairSigner();
  for (const amountBaseUnits of [MAXIMUM_DEPOSIT_TRANSFER_AMOUNT + 1n, 0n]) {
    await assert.rejects(
      () =>
        assembleShieldTransaction({
          signer,
          mint: DDC_MINT,
          amountBaseUnits,
          newDecryptableAvailableBalance: TEST_CIPHERTEXT,
          pendingBalanceCreditCounterAtRead: TEST_COUNTER_AT_READ,
          blockhash: TEST_BLOCKHASH,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^refusing to shield /);
        assert.ok(err.message.includes(amountBaseUnits.toString()));
        return true;
      },
    );
  }
});

test("shield-tx: a ciphertext of the wrong length is refused before assembly", async () => {
  const signer = await generateKeyPairSigner();
  await assert.rejects(
    () =>
      assembleShieldTransaction({
        signer,
        mint: DDC_MINT,
        amountBaseUnits: TEST_AMOUNT,
        newDecryptableAvailableBalance: new Uint8Array(35),
        pendingBalanceCreditCounterAtRead: TEST_COUNTER_AT_READ,
        blockhash: TEST_BLOCKHASH,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("35"));
      assert.ok(err.message.includes("36"));
      return true;
    },
  );
});

test("shield-tx single signer: one signature slot, and it is filled", async () => {
  const { signer, result } = await assembleForTest();
  const slots = Object.keys(result.transaction.signatures);
  assert.deepEqual(slots, [signer.address]);
  const signature = result.transaction.signatures[signer.address];
  assert.ok(signature, "the signer's slot must be filled");
  assert.equal(signature.length, 64, "an Ed25519 signature is 64 bytes");
});

// WIRE SIZE — the planned figure, 300 bytes, was a sandbox measurement to
// be re-pinned when the code landed; this pins it by EQUALITY
// (a knowable size is gated by equality, never inequality) and separately by
// the 1232-byte transaction limit, so the two failure modes read differently.
const WIRE_BYTES = 300;
const TRANSACTION_LIMIT_BYTES = 1232;

test("shield-tx: the signed wire transaction is exactly 300 bytes, 932 under the 1232-byte limit", async () => {
  const { result } = await assembleForTest();
  const wire = Buffer.from(getBase64EncodedWireTransaction(result.transaction), "base64");
  assert.equal(wire.length, WIRE_BYTES);
  assert.equal(TRANSACTION_LIMIT_BYTES - wire.length, 932);
  assert.ok(wire.length < TRANSACTION_LIMIT_BYTES);
});

// NETWORK FEE — the same tripwire as tx/apply-pending-tx.test.ts, re-stated
// for this transaction: the count is read OFF THE ARTIFACT, the two numbers
// are literal pins, and the zero guard keeps the comparison from being vacuous.
const LAMPORTS_PER_SIGNATURE = 5_000n;
const FEE_BOUND_LAMPORTS = 20_000n; // 0.00002 SOL, the figure the copy states

test("shield-tx network fee: one shield request, costed from the signature count read off the assembled artifact, is strictly below the 0.00002 SOL the copy claims", async () => {
  const { result } = await assembleForTest();
  const requiredSignatures = Object.keys(result.transaction.signatures).length;
  assert.ok(
    requiredSignatures > 0,
    "the assembled transaction carries no signature slot at all, so the fee comparison below would be vacuous",
  );
  const feeLamports = BigInt(requiredSignatures) * LAMPORTS_PER_SIGNATURE;
  assert.ok(
    feeLamports < FEE_BOUND_LAMPORTS,
    "one shield request costs " +
      feeLamports.toString() +
      " lamports across " +
      requiredSignatures.toString() +
      " required signatures, which is not STRICTLY below " +
      FEE_BOUND_LAMPORTS.toString(),
  );
});
