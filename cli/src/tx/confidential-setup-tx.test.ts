// Offline unit tests for the confidential-account setup assembly, per
// convention: no network, and no live path is mocked. The devnet run proves
// the broadcast path; this file proves the SHAPE of what would be broadcast.
//
// WHY NO BYTE VECTOR IS PINNED. The module under test is offline but NOT
// deterministic — proof generation draws randomness, so two runs produce
// different proof bytes. Every assertion below is therefore over structure,
// numbers and lengths. A test that pinned the wire bytes of this transaction
// would fail on its second run and teach everyone to ignore it.
//
// WHAT THIS FILE DOES NOT DO. It is not an oracle: it imports nothing from
// @solana-program/token-2022/confidential, so the no-production-import rule
// and its two exceptions are untouched. The plan-shape oracle is a separate
// artifact and a separate file.
//
// THE ASSERTION THAT EARNS ITS KEEP is the pair of numeric checks on 5 and 17.
// Upstream's enum places ConfidentialTransferFee (16, mint-side) immediately
// before ConfidentialTransferFeeAmount (17, account-side), one word apart.
// Selecting 16 compiles clean and fails ON-CHAIN at the configure step. Names
// are checked against NUMBERS here so the constraint traces to this mint's own
// five extensions rather than to upstream's spelling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, getTransactionEncoder } from "@solana/kit";
import {
  ExtensionType,
  getConfigureConfidentialTransferAccountInstructionDataDecoder,
  getDecryptableBalanceEncoder,
  getReallocateInstructionDataDecoder,
} from "@solana-program/token-2022";
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from "@solana/zk-sdk/node";
import { DDC_MINT } from "../constants.js";
import { deriveConfidentialKeys } from "../confidential-keys.js";
import {
  assembleConfidentialSetupTransaction,
  MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
  PROOF_INSTRUCTION_OFFSET,
  REALLOCATE_EXTENSION_TYPES,
  type BlockhashLifetime,
} from "./confidential-setup-tx.js";

// The three program addresses this transaction spans, pinned as literals
// rather than imported from the packages that default them — the point is to
// catch a package changing its default, which asserting against that same
// default cannot do.
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZK_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111";

// VerifyPubkeyValidity, the discriminator the caller must supply because the
// generic encoder does not pick one.
const VERIFY_PUBKEY_VALIDITY_DISCRIMINATOR = 4;

// A syntactically valid 32-byte base58 blockhash. TEST-ONLY double cast: the
// branded blockhash type has no constructor this build has verified, and the
// module never inspects the value — it only carries it into the lifetime
// setter. Never do this in production code.
const TEST_BLOCKHASH = {
  blockhash: "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa",
  lastValidBlockHeight: 0n,
} as unknown as BlockhashLifetime;

// TEST-ONLY narrowing of the assembled instruction list. kit's message type is
// heavily parameterized; these three fields are all this file reads.
interface AnyInstruction {
  programAddress: string;
  data?: Uint8Array;
  accounts?: readonly unknown[];
}

async function assembleForTest() {
  const signer = await generateKeyPairSigner();
  const keys = await deriveConfidentialKeys({
    signer,
    owner: signer.address,
    mint: DDC_MINT,
  });
  const result = await assembleConfidentialSetupTransaction({
    signer,
    mint: DDC_MINT,
    elgamalSecretKey: keys.elgamalSecretKey,
    aeKey: keys.aeKey,
    blockhash: TEST_BLOCKHASH,
  });
  const instructions = result.message
    .instructions as unknown as AnyInstruction[];
  return { signer, keys, result, instructions };
}

test("the enum members this build selects ARE 5 and 17 — the 16-versus-17 guard", () => {
  assert.equal(ExtensionType.ConfidentialTransferAccount, 5);
  assert.equal(ExtensionType.ConfidentialTransferFeeAmount, 17);
  // The adjacent mint-side extension, named one word away and wrong here.
  assert.equal(ExtensionType.ConfidentialTransferFee, 16);
  assert.deepEqual([...REALLOCATE_EXTENSION_TYPES], [5, 17]);
});

test("four instructions, in order, across the three expected programs", async () => {
  const { instructions } = await assembleForTest();
  assert.equal(instructions.length, 4);
  const [ix0, ix1, ix2, ix3] = instructions;
  assert.ok(ix0 && ix1 && ix2 && ix3);
  assert.equal(ix0.programAddress, ATA_PROGRAM);
  assert.equal(ix1.programAddress, TOKEN_2022);
  assert.equal(ix2.programAddress, TOKEN_2022);
  assert.equal(ix3.programAddress, ZK_PROOF_PROGRAM);
});

test("Reallocate carries extension types 5 and 17, read back off the encoded data", async () => {
  const { instructions } = await assembleForTest();
  const ix1 = instructions[1];
  assert.ok(ix1?.data);
  const decoded = getReallocateInstructionDataDecoder().decode(ix1.data);
  assert.deepEqual([...decoded.newExtensionTypes], [5, 17]);
});

test("ConfigureAccount carries 65536 and offset 1, read back off the encoded data", async () => {
  const { instructions } = await assembleForTest();
  const ix2 = instructions[2];
  assert.ok(ix2?.data);
  const decoded =
    getConfigureConfidentialTransferAccountInstructionDataDecoder().decode(
      ix2.data,
    );
  assert.equal(decoded.maximumPendingBalanceCreditCounter, 65536n);
  assert.equal(
    decoded.maximumPendingBalanceCreditCounter,
    MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
  );
  assert.equal(decoded.proofInstructionOffset, 1);
  assert.equal(decoded.proofInstructionOffset, PROOF_INSTRUCTION_OFFSET);
});

test("the verify instruction is discriminator 4 and sits at exactly offset +1 from ConfigureAccount", async () => {
  const { keys, instructions } = await assembleForTest();
  const configureIndex = 2;
  const ix3 = instructions[configureIndex + PROOF_INSTRUCTION_OFFSET];
  assert.ok(ix3?.data);
  assert.equal(ix3.programAddress, ZK_PROOF_PROGRAM);
  assert.equal(ix3.data[0], VERIFY_PUBKEY_VALIDITY_DISCRIMINATOR);
  // Inline proof bytes, not the four-byte offset form: one discriminator
  // byte plus a 96-byte proof.
  //
  // THE PROOF CARRIES THE KEY. A pubkey-validity proof's CONTEXT is exactly
  // the 32-byte ElGamal public key, verified against @solana/zk-sdk@0.5.1.
  // ConfigureAccount has no field for that key, so the proof is the ONLY
  // channel by which it reaches the chain, and the key this proof attests is
  // therefore the key this account will be configured with. Asserting that
  // agreement here is what stops a key being registered that the holder
  // cannot decrypt with.
  //
  // CONTAINMENT, NOT A FIXED OFFSET. The position of the context inside the
  // 96 proof bytes was never read from upstream. An assertion at a guessed
  // offset would pass or fail for the wrong reason.
  const PROOF_BYTES = 96;
  assert.equal(ix3.data.length, 1 + PROOF_BYTES, "proof must be inline");
  const proofHex = Buffer.from(ix3.data.subarray(1)).toString("hex");
  const pubkeyHex = Buffer.from(keys.elgamalPublicKey).toString("hex");
  assert.equal(pubkeyHex.length, 64, "an ElGamal public key is 32 bytes");
  assert.ok(
    proofHex.includes(pubkeyHex),
    "the proof must attest the derived ElGamal public key",
  );
});

test("round trip: a keypair rebuilt from the secret bytes yields the derived public key", async () => {
  const { keys } = await assembleForTest();
  const rebuilt = ElGamalKeypair.fromSecretKey(
    ElGamalSecretKey.fromBytes(keys.elgamalSecretKey),
  );
  assert.deepEqual(
    new Uint8Array(rebuilt.pubkey().toBytes()),
    keys.elgamalPublicKey,
    "rebuilding from bytes must not change the public key",
  );
});

test("the AE ciphertext length equals the wire size ConfigureAccount reserves", async () => {
  const { keys, instructions } = await assembleForTest();
  const produced = new Uint8Array(
    AeKey.fromBytes(keys.aeKey).encrypt(0n).toBytes(),
  ).length;
  assert.equal(getDecryptableBalanceEncoder().fixedSize, produced);
  const ix2 = instructions[2];
  assert.ok(ix2?.data);
  const decoded =
    getConfigureConfidentialTransferAccountInstructionDataDecoder().decode(
      ix2.data,
    );
  assert.equal(decoded.decryptableZeroBalance.length, produced);
});

test("single signer: exactly one signature slot, and it is filled", async () => {
  const { signer, result } = await assembleForTest();
  const slots = Object.keys(result.transaction.signatures);
  assert.deepEqual(slots, [signer.address]);
  // Assert what the slot HOLDS, not what it is not: notEqual(x, null) passes
  // on undefined, which is the empty-slot case this test exists to exclude.
  const signature = result.transaction.signatures[signer.address];
  assert.ok(signature, "the signer's slot must be filled");
  assert.equal(signature.length, 64, "an Ed25519 signature is 64 bytes");
});

// WIRE SIZE, MEASURED. The signed transaction is encoded here and its length
// pinned against the 1,232-byte packet limit, on the self-pay single-signature
// form; proof bytes vary per run, their length does not. A change in any
// encoder or in the proof size moves this number.
const EXPECTED_WIRE_BYTES = 536;
const PACKET_LIMIT_BYTES = 1232;

test("wire size: the signed four-instruction setup transaction is 536 bytes, inside the 1232-byte packet", async () => {
  const { result } = await assembleForTest();
  const wireBytes = getTransactionEncoder().encode(result.transaction).length;
  console.log(`confidential setup wire size: ${wireBytes} bytes`);
  assert.ok(PACKET_LIMIT_BYTES - wireBytes >= 0, `wire size ${wireBytes} exceeds the packet limit`);
  assert.equal(wireBytes, EXPECTED_WIRE_BYTES, `measured ${wireBytes} bytes, pinned ${EXPECTED_WIRE_BYTES}`);
});
