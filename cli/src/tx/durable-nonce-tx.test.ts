import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  isTransactionMessageWithDurableNonceLifetime,
  type Instruction,
} from "@solana/kit";
import { buildResumeIssuanceInstruction } from "../instructions/resume-issuance.js";
import { assembleDurableNonceTransaction } from "./durable-nonce-tx.js";

// Fixed real devnet addresses; the initiator is a throwaway keypair per run.
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

async function assemble() {
  const initiator = await generateKeyPairSigner();
  const instruction = buildResumeIssuanceInstruction({
    mint: MINT,
    mintState: MINT_STATE,
    issuerAuthority: initiator.address,
    reserveAuthority: RESERVE,
  });
  const result = await assembleDurableNonceTransaction(
    instruction,
    {
      nonceAccount: NONCE_ACCOUNT,
      nonceAuthority: initiator.address,
      nonceValue: NONCE_VALUE,
    },
    initiator,
  );
  return { initiator, instruction, ...result };
}

test("durable-nonce assembly: ix0 is System AdvanceNonceAccount on the nonce account; lifetime predicate holds", async () => {
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
  assert.equal(
    Buffer.from(ix0.data ?? new Uint8Array(0)).toString("hex"),
    "04000000",
  );
});

test("durable-nonce assembly: ix1 is exactly the passed instruction (program, data, accounts)", async () => {
  const { instruction, message } = await assemble();
  const instructions: readonly Instruction[] = message.instructions;
  assert.equal(instructions.length, 2);
  const ix1 = instructions[1];
  if (ix1 === undefined) assert.fail("message has no instruction 1");
  assert.equal(ix1.programAddress, instruction.programAddress);
  assert.equal(
    Buffer.from(ix1.data ?? new Uint8Array(0)).toString("hex"),
    Buffer.from(instruction.data).toString("hex"),
  );
  assert.deepEqual(
    (ix1.accounts ?? []).map((a) => a.address),
    instruction.accounts.map((a) => a.address),
  );
});

test("durable-nonce assembly: fee payer is the signer; partial sign fills the initiator slot and leaves Reserve null", async () => {
  const { initiator, message, transaction } = await assemble();
  assert.equal(message.feePayer.address, initiator.address);
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
