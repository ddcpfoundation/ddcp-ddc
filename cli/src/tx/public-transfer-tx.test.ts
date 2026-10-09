// Offline unit tests for the public transfer assembly. No network, no live
// path mocked; the devnet run proves the broadcast path and this file proves
// what would be broadcast. Every test name here is prefixed 'public-transfer-tx:'
// so it cannot collide with the 'shield-tx:' and 'transfer-tx:' names in tx/.
//
// BOTH GOLDEN VECTORS ARE HAND-DERIVED, NOT CAPTURED. Every byte comes from
// the WIRE LAYOUT read at pinned source, never from running the encoder and
// pasting its output.
//
// PROVENANCE, INSTRUCTION 0 -- CreateAssociatedTokenIdempotent:
//   byte 0       1 -- AssociatedTokenAccountInstruction::CreateIdempotent,
//                     enum position 1 under repr(u8)
// Total 1.
//
// PROVENANCE, INSTRUCTION 1 -- TransferCheckedWithFee:
//   byte 0      26 -- TokenInstruction::TransferFeeExtension
//   byte 1       1 -- TransferFeeInstruction::TransferCheckedWithFee, enum
//                     position 1 under repr(u8)
//   bytes 2-9      -- amount, u64 LITTLE-ENDIAN
//   byte 10        -- decimals, u8
//   bytes 11-18    -- fee, u64 LITTLE-ENDIAN
// Total 19 = 1 + 1 + 8 + 1 + 8.
//
// THE TEST INPUTS MAKE EACH FAILURE MODE VISIBLE IN THE LITERAL. The gross
// 0x0807060504030201 renders little-endian as the ascending run 01..08, so a
// byte-order flip reads backwards and a width error truncates the run. It also
// sits ABOVE 2^48 - 1, which is the point: the public path reaches where the
// confidential path refuses. The fee 0x14131211 renders as 11 12 13 14 followed
// by four zero bytes, a second distinct run, so the two u64 fields cannot be
// confused for one another and a field-order swap is visible at a glance.
//
// IF THE ENCODER DISAGREES WITH THESE BYTES, THAT IS A FINDING TO ESCALATE,
// NEVER A NUMBER TO UPDATE.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { getTransferCheckedWithFeeInstructionDataDecoder } from "@solana-program/token-2022";
import { DDC_DECIMALS } from "../amount.js";
import { DDC_MINT } from "../constants.js";
import { PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, TRANSFER_AMOUNT_MAX_BASE_UNITS } from "./transfer-fee-split.js";
import {
  assemblePublicTransferTransaction,
  type PublicTransferInput,
} from "./public-transfer-tx.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

// See PROVENANCE above. None of these numbers is imported from the package under test.
const CREATE_IDEMPOTENT_DISCRIMINATOR = 1;
const TRANSFER_FEE_EXTENSION_DISCRIMINATOR = 26;
const TRANSFER_CHECKED_WITH_FEE_DISCRIMINATOR = 1;
const CREATE_DATA_BYTES = 1;
const TRANSFER_DATA_BYTES = 1 + 1 + 8 + 1 + 8;

// 0x0807060504030201: above the 48-bit bound on purpose; LE 01..08.
const TEST_GROSS = 578437695752307201n;
// 0x14131211: LE 11 12 13 14 00 00 00 00, a second distinct run.
const TEST_FEE = 336794129n;
const RECIPIENT = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");

const GOLDEN_CREATE_DATA = new Uint8Array([1]);

const GOLDEN_TRANSFER_DATA = new Uint8Array([
  26, 1,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  6,
  0x11, 0x12, 0x13, 0x14, 0x00, 0x00, 0x00, 0x00,
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

async function assembleForTest(overrides: Partial<PublicTransferInput> = {}) {
  const signer = await generateKeyPairSigner();
  const result = await assemblePublicTransferTransaction({
    signer,
    mint: DDC_MINT,
    recipient: RECIPIENT,
    grossBaseUnits: TEST_GROSS,
    feeBaseUnits: TEST_FEE,
    blockhash: TEST_BLOCKHASH,
    ...overrides,
  });
  const instructions = result.message.instructions as unknown as AnyInstruction[];
  return { signer, result, instructions };
}

test("public-transfer-tx: the two golden vectors are 1 and 19 bytes, open with their discriminators, and their integer fields read back little-endian", () => {
  assert.equal(GOLDEN_CREATE_DATA.length, CREATE_DATA_BYTES);
  assert.equal(GOLDEN_CREATE_DATA[0], CREATE_IDEMPOTENT_DISCRIMINATOR);
  assert.equal(GOLDEN_TRANSFER_DATA.length, TRANSFER_DATA_BYTES);
  assert.equal(TRANSFER_DATA_BYTES, 19);
  assert.equal(GOLDEN_TRANSFER_DATA[0], TRANSFER_FEE_EXTENSION_DISCRIMINATOR);
  assert.equal(GOLDEN_TRANSFER_DATA[1], TRANSFER_CHECKED_WITH_FEE_DISCRIMINATOR);
  const view = new DataView(GOLDEN_TRANSFER_DATA.buffer, GOLDEN_TRANSFER_DATA.byteOffset);
  assert.equal(view.getBigUint64(2, true), TEST_GROSS);
  assert.equal(GOLDEN_TRANSFER_DATA[10], DDC_DECIMALS);
  assert.equal(view.getBigUint64(11, true), TEST_FEE);
  // The gross of record is deliberately above the confidential bound.
  assert.ok(TEST_GROSS > TRANSFER_AMOUNT_MAX_BASE_UNITS);
  assert.ok(TEST_GROSS < PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS);
});

test("public-transfer-tx GOLDEN: instruction 0 creates the recipient's account idempotently and instruction 1 is TransferCheckedWithFee, each equal to its hand-derived vector byte for byte", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 2);
  assert.ok(instructions[0]?.data);
  assert.ok(instructions[1]?.data);
  assert.deepEqual(new Uint8Array(instructions[0].data), GOLDEN_CREATE_DATA);
  assert.deepEqual(new Uint8Array(instructions[1].data), GOLDEN_TRANSFER_DATA);
});

test("public-transfer-tx: two instructions, the create on the Associated Token program and the transfer on Token-2022, in that order, and no ComputeBudget instruction anywhere", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0]?.programAddress, ASSOCIATED_TOKEN);
  assert.equal(instructions[1]?.programAddress, TOKEN_2022);
  for (const ix of instructions) {
    assert.notEqual(ix.programAddress, COMPUTE_BUDGET);
  }
});

test("public-transfer-tx: the create names the SENDER as payer and the RECIPIENT as owner, and the transfer carries source WRITABLE, mint READONLY, destination WRITABLE, authority READONLY_SIGNER", async () => {
  const { signer, result, instructions } = await assembleForTest();
  const create = instructions[0]?.accounts;
  assert.ok(create);
  assert.equal(create[0]?.address, signer.address);
  assert.equal(create[0]?.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(create[1]?.address, result.destinationToken);
  assert.equal(create[2]?.address, RECIPIENT);
  assert.equal(create[3]?.address, DDC_MINT);
  const transfer = instructions[1]?.accounts;
  assert.ok(transfer);
  assert.equal(transfer.length, 4);
  assert.equal(transfer[0]?.address, result.sourceToken);
  assert.equal(transfer[0]?.role, AccountRole.WRITABLE);
  assert.equal(transfer[1]?.address, DDC_MINT);
  assert.equal(transfer[1]?.role, AccountRole.READONLY);
  assert.equal(transfer[2]?.address, result.destinationToken);
  assert.equal(transfer[2]?.role, AccountRole.WRITABLE);
  assert.equal(transfer[3]?.address, signer.address);
  assert.equal(transfer[3]?.role, AccountRole.READONLY_SIGNER);
  assert.notEqual(result.sourceToken, result.destinationToken);
});

test("public-transfer-tx decoder cross-check: the generated decoder reads back the fields as supplied", async () => {
  const { instructions } = await assembleForTest();
  assert.ok(instructions[1]?.data);
  const d = getTransferCheckedWithFeeInstructionDataDecoder().decode(instructions[1].data);
  assert.equal(d.discriminator, TRANSFER_FEE_EXTENSION_DISCRIMINATOR);
  assert.equal(d.transferFeeDiscriminator, TRANSFER_CHECKED_WITH_FEE_DISCRIMINATOR);
  assert.equal(d.amount, TEST_GROSS);
  assert.equal(d.decimals, DDC_DECIMALS);
  assert.equal(d.fee, TEST_FEE);
  // Shares a codec with the encoder, so it cannot catch a coordinated change;
  // the golden vectors above are the guard.
});

test("public-transfer-tx determinism: two assemblies over identical inputs produce identical instruction data for both instructions", async () => {
  const signer = await generateKeyPairSigner();
  const input = {
    signer,
    mint: DDC_MINT,
    recipient: RECIPIENT,
    grossBaseUnits: TEST_GROSS,
    feeBaseUnits: TEST_FEE,
    blockhash: TEST_BLOCKHASH,
  };
  const a = await assemblePublicTransferTransaction(input);
  const b = await assemblePublicTransferTransaction(input);
  const dataOf = (
    r: Awaited<ReturnType<typeof assemblePublicTransferTransaction>>,
    i: number,
  ) => (r.message.instructions as unknown as AnyInstruction[])[i]?.data;
  assert.deepEqual(dataOf(a, 0), dataOf(b, 0));
  assert.deepEqual(dataOf(a, 1), dataOf(b, 1));
});

test("public-transfer-tx: the bound is the public one, it assembles AT the bound, and no refusal in this module names a proof", async () => {
  assert.equal(PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, 18446744073709551615n);
  const atBound = await assembleForTest({ grossBaseUnits: PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS, feeBaseUnits: 0n });
  assert.equal(atBound.instructions.length, 2);
  const signer = await generateKeyPairSigner();
  const base = { signer, mint: DDC_MINT, recipient: RECIPIENT, blockhash: TEST_BLOCKHASH };
  const cases: Array<[bigint, bigint, RegExp]> = [
    [PUBLIC_TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n, 0n, /one transfer carries at most 18446744073709551615 base units$/],
    [0n, 0n, /the amount must be at least 1 base unit$/],
    [-1n, 0n, /the amount must be at least 1 base unit$/],
    [100n, -1n, /a fee must be non-negative, got -1$/],
    [100n, 101n, /the fee cannot exceed the amount$/],
  ];
  for (const [grossBaseUnits, feeBaseUnits, shape] of cases) {
    await assert.rejects(
      () => assemblePublicTransferTransaction({ ...base, grossBaseUnits, feeBaseUnits }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, shape);
        assert.doesNotMatch(err.message, /proof|proven|48|confidential/i);
        return true;
      },
    );
  }
});

test("public-transfer-tx: a recipient equal to the sender's own wallet is refused before assembly", async () => {
  const signer = await generateKeyPairSigner();
  await assert.rejects(
    () =>
      assemblePublicTransferTransaction({
        signer,
        mint: DDC_MINT,
        recipient: signer.address,
        grossBaseUnits: TEST_GROSS,
        feeBaseUnits: TEST_FEE,
        blockhash: TEST_BLOCKHASH,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^refusing to transfer to the sender's own wallet /);
      assert.ok(err.message.includes(signer.address));
      return true;
    },
  );
});

test("public-transfer-tx single signer: one signature slot, and it is filled", async () => {
  const { signer, result } = await assembleForTest();
  const slots = Object.keys(result.transaction.signatures);
  assert.deepEqual(slots, [signer.address]);
  const signature = result.transaction.signatures[signer.address];
  assert.ok(signature, "the signer's slot must be filled");
  assert.equal(signature.length, 64, "an Ed25519 signature is 64 bytes");
});

// NETWORK FEE -- the same tripwire as tx/shield-tx.test.ts, re-stated for this
// transaction: the count is read OFF THE ARTIFACT, the two numbers are literal
// pins, and the zero guard keeps the comparison from being vacuous. The rent
// the create instruction may charge is NOT a network fee and is stated
// separately by the command.
const LAMPORTS_PER_SIGNATURE = 5_000n;
const FEE_BOUND_LAMPORTS = 20_000n; // 0.00002 SOL, the figure the copy states

test("public-transfer-tx network fee: one public transfer, costed from the signature count read off the assembled artifact, is strictly below the 0.00002 SOL the copy claims", async () => {
  const { result } = await assembleForTest();
  const requiredSignatures = Object.keys(result.transaction.signatures).length;
  assert.ok(
    requiredSignatures > 0,
    "the assembled transaction carries no signature slot at all, so the fee comparison below would be vacuous",
  );
  const feeLamports = BigInt(requiredSignatures) * LAMPORTS_PER_SIGNATURE;
  assert.ok(
    feeLamports < FEE_BOUND_LAMPORTS,
    "one public transfer costs " + feeLamports.toString() + " lamports across " +
      requiredSignatures.toString() + " required signatures, which is not STRICTLY below " +
      FEE_BOUND_LAMPORTS.toString(),
  );
});

// WIRE SIZE -- pinned by EQUALITY (a knowable size is gated by equality,
// never inequality) and separately against the 1232-byte transaction limit,
// so the two failure modes read differently, as tx/shield-tx.test.ts does.
const WIRE_BYTES = 396;
const TRANSACTION_LIMIT_BYTES = 1232;

test("public-transfer-tx: the signed wire transaction is exactly 396 bytes, 836 under the 1232-byte limit", async () => {
  const { result } = await assembleForTest();
  const wire = Buffer.from(getBase64EncodedWireTransaction(result.transaction), "base64");
  assert.equal(wire.length, WIRE_BYTES);
  assert.equal(TRANSACTION_LIMIT_BYTES - wire.length, 836);
  assert.ok(wire.length < TRANSACTION_LIMIT_BYTES);
});
