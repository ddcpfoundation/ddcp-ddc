import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  isTransactionMessageWithDurableNonceLifetime,
  type Instruction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import { assembleMintTokensTransaction } from "./mint-tx.js";

// Fixed real devnet addresses; the initiator is a throwaway keypair per run.
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
// A fixed nonce value (the real issuer nonce account's stored nonce at
// provisioning). Freshness is the live layer's job — this test is offline.
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

// Single-key shape: the throwaway initiator plays the issuer — fee payer, nonce
// authority, and issuer_authority are all its address.
async function assemble() {
  const initiator = await generateKeyPairSigner();
  const result = await assembleMintTokensTransaction({
    mint: MINT,
    destination: DESTINATION,
    mintState: MINT_STATE,
    issuerAuthority: initiator.address,
    reserveAuthority: RESERVE,
    token2022Program: TOKEN_2022,
    amount: 1_000_000n,
    nonceAccount: NONCE_ACCOUNT,
    nonceAuthority: initiator.address,
    nonceValue: NONCE_VALUE,
    initiatorSigner: initiator,
  });
  return { initiator, ...result };
}

test("mint tx: instruction 0 is System AdvanceNonceAccount on the nonce account; durable-nonce lifetime predicate holds", async () => {
  const { message } = await assemble();
  assert.ok(
    isTransactionMessageWithDurableNonceLifetime(message),
    "durable-nonce lifetime predicate must hold",
  );
  const instructions: readonly Instruction[] = message.instructions;
  const ix0 = instructions[0];
  if (ix0 === undefined) assert.fail("message has no instruction 0");
  assert.equal(ix0.programAddress, SYSTEM_PROGRAM);
  const firstAccount = ix0.accounts?.[0];
  if (firstAccount === undefined) {
    assert.fail("AdvanceNonceAccount has no first account");
  }
  assert.equal(firstAccount.address, NONCE_ACCOUNT);
  // AdvanceNonceAccount is System instruction index 4, u32 LE.
  assert.equal(
    Buffer.from(ix0.data ?? new Uint8Array(0)).toString("hex"),
    "04000000",
  );
});

test("mint tx: instruction 1 is mint_tokens on the program with 16-byte data and the pinned discriminator", async () => {
  const { message } = await assemble();
  const instructions: readonly Instruction[] = message.instructions;
  assert.equal(instructions.length, 2);
  const ix1 = instructions[1];
  if (ix1 === undefined) assert.fail("message has no instruction 1");
  assert.equal(ix1.programAddress, PROGRAM_ID);
  const data = ix1.data ?? new Uint8Array(0);
  assert.equal(data.length, 16);
  assert.equal(
    Buffer.from(data.subarray(0, 8)).toString("hex"),
    "3b8418f67a2708f3",
  );
});

test("mint tx: fee payer is the initiator signer's address", async () => {
  const { initiator, message } = await assemble();
  assert.equal(message.feePayer.address, initiator.address);
});

test("mint tx partial sign: initiator slot filled, Reserve slot present and null", async () => {
  const { initiator, transaction } = await assemble();
  assert.equal(Object.keys(transaction.signatures).length, 2);
  const initiatorSig = transaction.signatures[initiator.address];
  assert.ok(initiatorSig != null, "initiator signature slot must be filled");
  assert.equal(initiatorSig.length, 64);
  assert.equal(
    transaction.signatures[RESERVE],
    null,
    "Reserve slot must exist and be empty (null) after the partial sign",
  );
});
