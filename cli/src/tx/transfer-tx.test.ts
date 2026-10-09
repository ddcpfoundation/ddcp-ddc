// Offline tests for the ONE version-1 transaction that carries the five
// 'transfer' proofs (tx/transfer-tx.ts), on the unshield-tx.test.ts pattern.
// No network; no live path is mocked. Proof bytes are random per run, so
// every assertion is over structure, numbers and lengths.
//
// THE ASSERTIONS THAT EARN THEIR KEEP: the discriminator pair read off the
// encoded bytes (27/13 for TransferWithFee, one word from 27/6 Withdraw),
// the five verify discriminators 3 / 12 / 5 / 10 / 8 with each proof INLINE
// (data length = 1 + proof bytes), the five offsets read off the transfer
// bytes as SIGNED values equal to the proofs' positions relative to the
// transfer, the account order WITH the instructions sysvar and WITHOUT any
// record account, one filled signature slot, and the wire size pinned at
// its measured figure.
//
// EVERY TEST NAME IS PREFIXED 'transfer-tx:' so it cannot collide with the
// unprefixed names in unshield-tx.test.ts or the 'transfer proofs:' names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, getTransactionEncoder, type Address } from "@solana/kit";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/node";
import { DDC_MINT } from "../constants.js";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import type { BlockhashLifetime } from "./confidential-setup-tx.js";
import { EQUALITY_PROOF_BYTES } from "./unshield-proofs.js";
import { grossForNet } from "./transfer-fee-gross.js";
import {
  buildTransferProofs,
  PERCENTAGE_WITH_CAP_PROOF_BYTES,
  RANGE_U256_PROOF_BYTES,
  VALIDITY_2_HANDLES_PROOF_BYTES,
  VALIDITY_3_HANDLES_PROOF_BYTES,
} from "./transfer-proofs.js";
import {
  assembleTransferTransaction,
  TRANSFER_COMPUTE_UNIT_LIMIT,
  TRANSFER_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  TRANSFER_VERIFY_COMPUTE_UNITS,
  V1_TRANSACTION_SIZE_LIMIT_BYTES,
  type TransferProofBytes,
} from "./transfer-tx.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZK_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
const LEGACY_TRANSACTION_SIZE_LIMIT_BYTES = 1232;
// Measured on devnet for unshield; the transfer loads one more token account.
const MEASURED_LOADED_ACCOUNTS_DATA_BYTES = 712_728;
// The whole transaction, by devnet simulation: 455,927 units at 0 bps and the
// same at 100 bps with the fee at its cap.
const MEASURED_TRANSFER_COMPUTE_UNITS = 455_927;
/** The all-inline shape with a distinct destination, measured. */
const MEASURED_WIRE_BYTES = 3247;

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

const DEVNET = { epoch: 1108n, maximumFee: 1_000_000n, basisPoints: 100 };
const AVAILABLE = 600_500_000n;
const NET = 100_000_000n;

function proofsForTest() {
  const source = new ElGamalKeypair();
  const destination = new ElGamalKeypair();
  const withheld = new ElGamalKeypair();
  const g = grossForNet(NET, DEVNET);
  return buildTransferProofs({
    elgamalSecretKey: new Uint8Array(source.secret().toBytes()),
    availableBalanceCiphertext: new Uint8Array(source.pubkey().encryptU64(AVAILABLE).toBytes()),
    availableBaseUnits: AVAILABLE,
    grossBaseUnits: g.grossBaseUnits,
    split: g.split,
    schedule: DEVNET,
    destinationElgamalPubkey: new Uint8Array(destination.pubkey().toBytes()),
    auditorElgamalPubkey: undefined,
    withdrawWithheldAuthorityElgamalPubkey: new Uint8Array(withheld.pubkey().toBytes()),
  });
}

async function assembleOne() {
  const signer = await generateKeyPairSigner();
  const recipient = (await generateKeyPairSigner()).address;
  const proofs = proofsForTest();
  const newDecryptableAvailableBalance = new Uint8Array(new AeKey().encrypt(proofs.remainingBaseUnits).toBytes());
  const result = await assembleTransferTransaction({
    signer,
    mint: DDC_MINT,
    recipient,
    newDecryptableAvailableBalance,
    proofs,
    blockhash: TEST_BLOCKHASH,
  });
  return { signer, recipient, ...result };
}

test("transfer-tx: one transaction, six instructions in order: five verifies, then the transfer", async () => {
  const one = await assembleOne();
  assert.deepEqual(
    instructionsOf(one).map((ix) => ix.programAddress),
    [ZK_PROOF_PROGRAM, ZK_PROOF_PROGRAM, ZK_PROOF_PROGRAM, ZK_PROOF_PROGRAM, ZK_PROOF_PROGRAM, TOKEN_2022],
  );
});

test("transfer-tx: verify discriminators 3 / 12 / 5 / 10 / 8 with every proof INLINE, no accounts", async () => {
  const one = await assembleOne();
  const ixs = instructionsOf(one);
  const expected: [number, number][] = [
    [3, EQUALITY_PROOF_BYTES],
    [12, VALIDITY_3_HANDLES_PROOF_BYTES],
    [5, PERCENTAGE_WITH_CAP_PROOF_BYTES],
    [10, VALIDITY_2_HANDLES_PROOF_BYTES],
    [8, RANGE_U256_PROOF_BYTES],
  ];
  expected.forEach(([discriminator, proofBytes], i) => {
    const ix = ixs[i];
    assert.ok(ix?.data);
    assert.equal(ix.data[0], discriminator, "verify " + i);
    assert.equal(ix.data.length, 1 + proofBytes, "proof " + i + " inline");
    assert.equal(ix.accounts?.length ?? 0, 0, "verify " + i + " names no account");
  });
});

test("transfer-tx: TransferWithFee 27/13 (not Withdraw 27/6), 171 data bytes, offsets -5 .. -1 read as SIGNED bytes", async () => {
  const one = await assembleOne();
  const data = instructionsOf(one)[5]?.data;
  assert.ok(data);
  // 2 discriminators + 36 balance copy + 64 + 64 auditor ciphertexts + 5 offsets.
  assert.equal(data.length, 2 + DECRYPTABLE_BALANCE_BYTES + 64 + 64 + 5);
  assert.equal(data[0], 27);
  assert.equal(data[1], 13);
  const view = new DataView(data.buffer, data.byteOffset);
  const transferIndex = 5;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(view.getInt8(data.length - 5 + i), i - transferIndex);
  }
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => view.getInt8(data.length - 5 + i)),
    [-5, -4, -3, -2, -1],
  );
});

test("transfer-tx: accounts: source, mint, destination, instructions sysvar, authority; no record account", async () => {
  const one = await assembleOne();
  const accounts = instructionsOf(one)[5]?.accounts?.map((a) => a.address);
  assert.ok(accounts);
  assert.deepEqual(accounts, [one.sourceToken, DDC_MINT, one.destinationToken, SYSVAR_INSTRUCTIONS, one.signer.address]);
  assert.notEqual(one.sourceToken, one.destinationToken);
});

test("transfer-tx: one signature slot, the signer's, filled", async () => {
  const one = await assembleOne();
  const entries = Object.entries((one.transaction as { signatures: Record<string, unknown> }).signatures);
  assert.deepEqual(entries.map(([address]) => address), [one.signer.address]);
  for (const [, sig] of entries) assert.ok(sig, "the slot must be filled");
});

test("transfer-tx: version 1, both limits set above the verify charges and the measured bytes, no priority fee, no ComputeBudget", async () => {
  const one = await assembleOne();
  const message = one.message as { version: unknown; config?: Record<string, unknown> };
  assert.equal(message.version, 1);
  assert.ok(message.config);
  assert.equal(message.config["computeUnitLimit"], TRANSFER_COMPUTE_UNIT_LIMIT);
  assert.equal(message.config["loadedAccountsDataSizeLimit"], TRANSFER_LOADED_ACCOUNTS_DATA_SIZE_LIMIT);
  assert.equal(TRANSFER_VERIFY_COMPUTE_UNITS, 410_300);
  assert.ok(TRANSFER_COMPUTE_UNIT_LIMIT > TRANSFER_VERIFY_COMPUTE_UNITS, "compute limit must clear the five verifies");
  assert.ok(TRANSFER_COMPUTE_UNIT_LIMIT * 100 >= MEASURED_TRANSFER_COMPUTE_UNITS * 110, "compute limit at least 10% above the measured transaction");
  assert.ok(TRANSFER_COMPUTE_UNIT_LIMIT * 100 <= MEASURED_TRANSFER_COMPUTE_UNITS * 120, "compute limit at most 20% above the measured transaction");
  assert.ok(TRANSFER_LOADED_ACCOUNTS_DATA_SIZE_LIMIT > MEASURED_LOADED_ACCOUNTS_DATA_BYTES);
  assert.equal(message.config["priorityFeeLamports"], undefined);
  assert.equal(message.config["heapSize"], undefined);
  assert.ok(instructionsOf(one).every((ix) => ix.programAddress !== COMPUTE_BUDGET));
});

test("transfer-tx: wire size 3247 bytes: message byte zero 0x81, above 1232, below 4096", async () => {
  const one = await assembleOne();
  const wire = getTransactionEncoder().encode(one.transaction as never);
  console.log("transfer wire size: " + wire.length + " bytes");
  assert.equal(wire.length, MEASURED_WIRE_BYTES);
  assert.equal(wire[0], 0x81);
  assert.ok(wire.length > LEGACY_TRANSACTION_SIZE_LIMIT_BYTES, "a legacy shape would fit; the version-1 gate would be unearned");
  assert.ok(wire.length <= V1_TRANSACTION_SIZE_LIMIT_BYTES);
  assert.equal(V1_TRANSACTION_SIZE_LIMIT_BYTES, 4096);
});

test("transfer-tx: a recipient equal to the sender is refused by name before anything is built", async () => {
  const signer = await generateKeyPairSigner();
  const proofs = proofsForTest();
  await assert.rejects(
    assembleTransferTransaction({
      signer,
      mint: DDC_MINT,
      recipient: signer.address,
      newDecryptableAvailableBalance: new Uint8Array(DECRYPTABLE_BALANCE_BYTES),
      proofs,
      blockhash: TEST_BLOCKHASH,
    }),
    /sender's own wallet/,
  );
});

test("transfer-tx: a proof or ciphertext of the wrong length is refused by name", async () => {
  const signer = await generateKeyPairSigner();
  const recipient = (await generateKeyPairSigner()).address;
  const good = proofsForTest();
  const cases: [keyof TransferProofBytes, RegExp][] = [
    ["equalityProof", /equality proof is/],
    ["transferValidityProof", /transfer validity proof is/],
    ["percentageWithCapProof", /percentage-with-cap proof is/],
    ["feeValidityProof", /fee validity proof is/],
    ["rangeProof", /range proof is/],
    ["transferAmountAuditorCiphertextLo", /auditor ciphertext lo is/],
    ["transferAmountAuditorCiphertextHi", /auditor ciphertext hi is/],
  ];
  for (const [field, pattern] of cases) {
    const proofs: TransferProofBytes = { ...good, [field]: new Uint8Array(7) };
    await assert.rejects(
      assembleTransferTransaction({
        signer,
        mint: DDC_MINT,
        recipient,
        newDecryptableAvailableBalance: new Uint8Array(DECRYPTABLE_BALANCE_BYTES),
        proofs,
        blockhash: TEST_BLOCKHASH,
      }),
      pattern,
    );
  }
  await assert.rejects(
    assembleTransferTransaction({
      signer,
      mint: DDC_MINT,
      recipient: recipient as Address,
      newDecryptableAvailableBalance: new Uint8Array(35),
      proofs: good,
      blockhash: TEST_BLOCKHASH,
    }),
    /new decryptable balance is 35/,
  );
});
