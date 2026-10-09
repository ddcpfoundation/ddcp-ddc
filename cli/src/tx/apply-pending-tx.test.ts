// Offline unit tests for the apply-pending assembly. No network, no live path
// mocked; the devnet run proves the broadcast path and this file proves what
// would be broadcast.
//
// THE GOLDEN VECTOR IS HAND-DERIVED, NOT CAPTURED. Every byte below comes from
// the WIRE LAYOUT, not from running the encoder and pasting its output. That
// distinction is the whole value of the test: a captured vector moves with the
// encoder, so a silent upstream re-encoding changes the expectation and the
// assertion together and the test still passes.
//
// PROVENANCE, FIELD BY FIELD:
//   byte 0      27 — TokenInstruction::ConfidentialTransferExtension, read from
//                    pinned Rust source on the build machine.
//   byte 1       8 — ConfidentialTransferInstruction::ApplyPendingBalance, same
//                    read.
//   bytes 2-9      — the expected credit counter, u64 LITTLE-ENDIAN, Solana's
//                    encoding convention for integer instruction fields.
//   bytes 10-45    — the 36-byte AES ciphertext, passed through unchanged.
// Total 46 = 1 + 1 + 8 + 36, arithmetic rather than a figure taken from the
// encoder's declared size.
//
// The two discriminators come from the PROGRAM's Rust source, not from the
// TypeScript package. That is what makes the vector independent: were the
// generated client's discriminators to drift from the program's, this test
// fails, which a vector derived from the client's own constants could not do.
//
// IF THE ENCODER DISAGREES WITH THESE BYTES, THAT IS A FINDING TO ESCALATE,
// NEVER A NUMBER TO UPDATE.
//
// THE TEST INPUTS ARE CHOSEN SO EACH FAILURE MODE IS VISIBLE IN THE LITERAL.
// The counter 0x0807060504030201 renders little-endian as an ascending run, so
// a byte-order flip reads backwards at a glance; a width error truncates the
// run; and the ciphertext's 0x10-onward sequence breaks visibly at any offset
// error. Nobody has to decode anything to see which of the three went wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, generateKeyPairSigner } from "@solana/kit";
import { getApplyConfidentialPendingBalanceInstructionDataDecoder } from "@solana-program/token-2022";
import { DDC_MINT } from "../constants.js";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import {
  assembleApplyPendingTransaction,
  type ApplyPendingInput,
} from "./apply-pending-tx.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

// See PROVENANCE above. Neither number is imported from the package under test.
const EXTENSION_DISCRIMINATOR = 27;
const APPLY_PENDING_DISCRIMINATOR = 8;
const INSTRUCTION_DATA_BYTES = 1 + 1 + 8 + DECRYPTABLE_BALANCE_BYTES;

// 0x0807060504030201. Little-endian, this is 01 02 03 04 05 06 07 08.
const TEST_COUNTER = 578437695752307201n;

// 36 ascending bytes from 0x10, so an offset error breaks the run visibly.
const TEST_CIPHERTEXT = new Uint8Array(
  Array.from({ length: DECRYPTABLE_BALANCE_BYTES }, (_, i) => 0x10 + i),
);

const GOLDEN_INSTRUCTION_DATA = new Uint8Array([
  27, 8,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21,
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33,
]);

// A syntactically valid 32-byte base58 blockhash. TEST-ONLY double cast, as in
// the sibling: the branded type has no constructor this build has verified, and
// the module only carries the value into the lifetime setter.
const TEST_BLOCKHASH = {
  blockhash: "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa",
  lastValidBlockHeight: 0n,
} as unknown as BlockhashLifetime;

// TEST-ONLY narrowing. kit's message type is heavily parameterized; these are
// the only fields this file reads.
interface AnyAccount {
  address: string;
  role: number;
}
interface AnyInstruction {
  programAddress: string;
  data?: Uint8Array;
  accounts?: readonly AnyAccount[];
}

async function assembleForTest(overrides: Partial<ApplyPendingInput> = {}) {
  const signer = await generateKeyPairSigner();
  const result = await assembleApplyPendingTransaction({
    signer,
    mint: DDC_MINT,
    newDecryptableAvailableBalance: TEST_CIPHERTEXT,
    expectedPendingBalanceCreditCounter: TEST_COUNTER,
    blockhash: TEST_BLOCKHASH,
    ...overrides,
  });
  const instructions = result.message
    .instructions as unknown as AnyInstruction[];
  return { signer, result, instructions };
}

test("the golden vector is 46 bytes and its first two are the discriminator pair", () => {
  assert.equal(GOLDEN_INSTRUCTION_DATA.length, INSTRUCTION_DATA_BYTES);
  assert.equal(INSTRUCTION_DATA_BYTES, 46);
  assert.equal(GOLDEN_INSTRUCTION_DATA[0], EXTENSION_DISCRIMINATOR);
  assert.equal(GOLDEN_INSTRUCTION_DATA[1], APPLY_PENDING_DISCRIMINATOR);
  // The counter's little-endian rendering, asserted against the number rather
  // than restated: a DataView read is independent of how the literal was typed.
  const view = new DataView(
    GOLDEN_INSTRUCTION_DATA.buffer,
    GOLDEN_INSTRUCTION_DATA.byteOffset,
  );
  assert.equal(view.getBigUint64(2, true), TEST_COUNTER);
  assert.deepEqual(GOLDEN_INSTRUCTION_DATA.subarray(10), TEST_CIPHERTEXT);
});

test("GOLDEN: the encoded instruction data equals the hand-derived vector, byte for byte", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 1);
  const ix = instructions[0];
  assert.ok(ix?.data);
  assert.deepEqual(new Uint8Array(ix.data), GOLDEN_INSTRUCTION_DATA);
});

test("one instruction, on Token-2022, and no ComputeBudget instruction anywhere", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0]?.programAddress, TOKEN_2022);
  // SetComputeUnitPrice must never appear in a DDC transaction.
  // Asserting the PROGRAM is absent is stronger than asserting one of its
  // instructions is, and it costs the same.
  for (const ix of instructions) {
    assert.notEqual(ix.programAddress, COMPUTE_BUDGET);
  }
});

test("two accounts: the token account WRITABLE, the authority READONLY_SIGNER, in that order", async () => {
  const { signer, result, instructions } = await assembleForTest();
  const accounts = instructions[0]?.accounts;
  assert.ok(accounts);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]?.address, result.tokenAccount);
  assert.equal(accounts[0]?.role, AccountRole.WRITABLE);
  assert.equal(accounts[1]?.address, signer.address);
  assert.equal(accounts[1]?.role, AccountRole.READONLY_SIGNER);
});

test("decoder cross-check: the generated decoder reads back the fields as supplied", async () => {
  const { instructions } = await assembleForTest();
  const ix = instructions[0];
  assert.ok(ix?.data);
  const decoded =
    getApplyConfidentialPendingBalanceInstructionDataDecoder().decode(ix.data);
  assert.equal(decoded.discriminator, EXTENSION_DISCRIMINATOR);
  assert.equal(decoded.confidentialTransferDiscriminator, APPLY_PENDING_DISCRIMINATOR);
  assert.equal(decoded.expectedPendingBalanceCreditCounter, TEST_COUNTER);
  assert.deepEqual(
    new Uint8Array(decoded.newDecryptableAvailableBalance),
    TEST_CIPHERTEXT,
  );
  // This check shares a codec with the encoder, so it cannot catch a
  // coordinated encoder-and-decoder change. The golden vector above is what
  // catches that. Kept as defense in depth, not as the guard.
});

test("determinism: two assemblies over identical inputs produce identical instruction data", async () => {
  const signer = await generateKeyPairSigner();
  const input = {
    signer,
    mint: DDC_MINT,
    newDecryptableAvailableBalance: TEST_CIPHERTEXT,
    expectedPendingBalanceCreditCounter: TEST_COUNTER,
    blockhash: TEST_BLOCKHASH,
  };
  const a = await assembleApplyPendingTransaction(input);
  const b = await assembleApplyPendingTransaction(input);
  const dataOf = (r: Awaited<ReturnType<typeof assembleApplyPendingTransaction>>) =>
    (r.message.instructions as unknown as AnyInstruction[])[0]?.data;
  assert.deepEqual(dataOf(a), dataOf(b));
  // The property this pins is the module's SIGNATURE, not a happy accident:
  // the ciphertext is an input. Move encryption inside and this test fails.
});

test("a ciphertext of the wrong length is refused before assembly", async () => {
  const signer = await generateKeyPairSigner();
  await assert.rejects(
    () =>
      assembleApplyPendingTransaction({
        signer,
        mint: DDC_MINT,
        newDecryptableAvailableBalance: new Uint8Array(35),
        expectedPendingBalanceCreditCounter: TEST_COUNTER,
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

// NAME IS PREFIXED DELIBERATELY: tx/confidential-setup-tx.test.ts makes the
// same assertion about its own transaction, and test names in this suite are
// unique so that a gate needle can address one assertion. Do not shorten it.
test("single signer on apply-pending: one signature slot, and it is filled", async () => {
  const { signer, result } = await assembleForTest();
  const slots = Object.keys(result.transaction.signatures);
  assert.deepEqual(slots, [signer.address]);
  const signature = result.transaction.signatures[signer.address];
  assert.ok(signature, "the signer's slot must be filled");
  assert.equal(signature.length, 64, "an Ed25519 signature is 64 bytes");
});

// NETWORK FEE — the property is the COST OF ONE apply-pending REQUEST, which is
// what the announcement copy will claim: "network fee : less than 0.00002 SOL".
// The check measures that cost by reading the required-signature count OFF THE
// ASSEMBLED ARTIFACT and multiplying by the base rate. Reading the count off
// the artifact rather than hardcoding it is what makes this a tripwire instead
// of a restatement (superseding a "does not exceed" predicate: at four
// signatures the product is EXACTLY 20,000 lamports, which passes "does not
// exceed" while the shipped sentence is false of it — hence STRICTLY below).
//
// THE TWO NUMBERS ARE LITERAL PINS, DELIBERATELY NOT IMPORTED, on the
// plan-shape-oracle precedent: a bound that reads its own value from the module
// it is checking passes at any value of it.
//
// THE ZERO GUARD IS NOT DECORATION. An empty signature map costs zero, and zero
// is strictly below any bound, so the fee assertion alone would pass vacuously
// against an artifact that carries no signature slot at all. The positive check
// is what makes the comparison evidence.
//
// RESIDUAL, stated rather than glossed: this cannot detect a change in the
// network's lamports-per-signature, which would falsify the same sentence from
// outside an offline test's reach. Nor is this the copy-review trigger — the
// single-signer shape assertion above pins the slot count at one and fails the
// moment a relay fee payer is added, which is where the copy gets re-read.
const LAMPORTS_PER_SIGNATURE = 5_000n;
const FEE_BOUND_LAMPORTS = 20_000n; // 0.00002 SOL, the figure the copy states

test("network fee: one apply-pending request, costed from the signature count read off the assembled artifact, is strictly below the 0.00002 SOL the copy claims", async () => {
  const { result } = await assembleForTest();
  const requiredSignatures = Object.keys(result.transaction.signatures).length;
  assert.ok(
    requiredSignatures > 0,
    "the assembled transaction carries no signature slot at all, so the fee comparison below would be vacuous",
  );
  const feeLamports = BigInt(requiredSignatures) * LAMPORTS_PER_SIGNATURE;
  assert.ok(
    feeLamports < FEE_BOUND_LAMPORTS,
    "one apply-pending request costs " +
      feeLamports.toString() +
      " lamports across " +
      requiredSignatures.toString() +
      " required signatures, which is not STRICTLY below " +
      FEE_BOUND_LAMPORTS.toString(),
  );
});
