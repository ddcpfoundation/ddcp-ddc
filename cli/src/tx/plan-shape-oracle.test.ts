// PLAN-SHAPE ORACLE (narrowed form). Calls UPSTREAM's
// own recommended plan builder for confidential-account creation and asserts
// ONLY: four instructions, the expected program IDs, and the leading
// discriminators, IN ORDER. Deliberately NOT field-for-field — that form was
// rejected because it couples the test to the plan object's internal shape
// and breaks for cosmetic upstream reasons. What this catches mechanically is
// the failure worth catching: upstream adding a required step, reordering, or
// changing a discriminator under an exact-pin bump, which would otherwise be
// found only by someone remembering to re-read the plan builder.
//
// TWO ISOLATION FACTS, discovered building this test:
// (1) Under Node, the plan builder is NOT on the package root — the root's
//     runtime omits the confidential helpers; they live at the subpath
//     "@solana-program/token-2022/confidential".
// (2) The helper's internals run on @solana/zk-sdk's BUNDLER entry and
//     _assertClass-reject key objects built from the /node entry, so this test
//     constructs throwaway keys from the bundler entry. That import exists in
//     THIS TEST ONLY: shipping code stays on @solana/zk-sdk/node per the pins.
//     Loading both entries means a second WASM instantiation in the test
//     process; Node prints one ExperimentalWarning for it. Harmless.
//
// The helper's signature wants an rpc for rent arithmetic; a stub returning a
// fixed lamport figure keeps the test offline. The figure does not enter any
// asserted value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, type Instruction } from "@solana/kit";
import { getConfidentialWithdrawInstructionPlan, getCreateConfidentialTransferAccountInstructionPlan } from "@solana-program/token-2022/confidential";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/bundler";
import { DDC_MINT } from "../constants.js";
import { MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER } from "./confidential-setup-tx.js";

// Asserted programs are LITERAL pins — deliberately not the constants the
// shipping code imports, so a change to those constants is caught, not tracked.
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZK_ELGAMAL_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111";

/** Depth-first flatten of an InstructionPlan tree to its instructions, in order. */
function flattenPlan(plan: unknown, out: Instruction[] = []): Instruction[] {
  const node = plan as { kind?: string; instruction?: Instruction; plans?: unknown[] };
  if (node.kind === "single" && node.instruction !== undefined) {
    out.push(node.instruction);
  } else {
    for (const child of node.plans ?? []) flattenPlan(child, out);
  }
  return out;
}

test("plan-shape oracle: upstream's confidential-account plan is four instructions with the fixed programs and discriminators, in order", async () => {
  const signer = await generateKeyPairSigner();
  const rpcStub = {
    getMinimumBalanceForRentExemption: () => ({ send: async () => 2445120n }),
  };
  const plan = await getCreateConfidentialTransferAccountInstructionPlan({
    payer: signer,
    owner: signer,
    mint: DDC_MINT,
    rpc: rpcStub as unknown as Parameters<
      typeof getCreateConfidentialTransferAccountInstructionPlan
    >[0]["rpc"],
    elgamalKeypair: new ElGamalKeypair(),
    aesKey: new AeKey(),
    maximumPendingBalanceCreditCounter: MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
    includeConfidentialTransferFeeAmount: true,
  });

  const instructions = flattenPlan(plan);
  assert.equal(instructions.length, 4, "upstream's plan is no longer four instructions");

  const shape = instructions.map((ix) => ({
    program: ix.programAddress as string,
    lead: (ix.data ?? new Uint8Array())[0],
  }));
  assert.deepEqual(
    shape.map((s) => s.program),
    [ATA_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, ZK_ELGAMAL_PROOF_PROGRAM],
    "program sequence changed",
  );
  assert.deepEqual(
    shape.map((s) => s.lead),
    [1, 29, 27, 4],
    "leading discriminators changed: CreateIdempotent=1, Reallocate=29, ConfidentialTransferExtension=27, VerifyPubkeyValidity=4",
  );
  // The one second byte that IS a discriminator: ConfigureAccount inside the
  // Confidential Transfer extension.
  assert.equal(
    (instructions[2]?.data ?? new Uint8Array())[1],
    2,
    "ConfigureAccount sub-discriminator changed",
  );
});

// WITHDRAW PLAN SHAPE. Same
// narrowed form as the setup oracle above: count, program sequence and leading
// discriminators, in order, nothing field-for-field. The two proof-carrying
// data lengths ARE asserted, because this build's five-transaction packing
// rests on them — 937 bytes of range-proof instruction data is what puts the
// range create and its verify in separate transactions.
//
// UPSTREAM LEAVES THE PACKING TO THE APPLICATION: its own comment says a
// transaction planner decides how to pack create-account beside verify-proof.
// This build is that planner; cli/src/tx/unshield-tx.ts is where these seven
// instructions become five transactions.
//
// THE SYSTEM PROGRAM PIN IS DECLARED IN-TEST, not beside the three module-scope
// pins above: a line added up there would move the line-60 anchor that the
// build's angle-open census pins by number.

test("plan-shape oracle: upstream's withdraw plan is seven instructions with the fixed programs and discriminators, in order", async () => {
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const signer = await generateKeyPairSigner();
  const elgamalKeypair = new ElGamalKeypair();
  const aesKey = new AeKey();
  const available = 1_000_000n;
  const rpcStub = {
    getMinimumBalanceForRentExemption: () => ({ send: async () => 2445120n }),
  };
  const tokenAccount = { extensions: { __option: "Some", value: [{ __kind: "ConfidentialTransferAccount", availableBalance: new Uint8Array(elgamalKeypair.pubkey().encryptU64(available).toBytes()), decryptableAvailableBalance: new Uint8Array(aesKey.encrypt(available).toBytes()) }] } } as unknown as Parameters<typeof getConfidentialWithdrawInstructionPlan>[0]["tokenAccount"];
  const plan = await getConfidentialWithdrawInstructionPlan({
    token: signer.address,
    mint: DDC_MINT,
    tokenAccount,
    authority: signer,
    amount: 250_000n,
    decimals: 6,
    elgamalKeypair,
    aesKey,
    payer: signer,
    rpc: rpcStub as unknown as Parameters<typeof getConfidentialWithdrawInstructionPlan>[0]["rpc"],
  });

  const instructions = flattenPlan(plan);
  assert.equal(instructions.length, 7, "upstream's withdraw plan is no longer seven instructions");

  const shape = instructions.map((ix) => ({
    program: ix.programAddress as string,
    lead: (ix.data ?? new Uint8Array())[0],
    bytes: (ix.data ?? new Uint8Array()).length,
  }));
  assert.deepEqual(
    shape.map((s) => s.program),
    [
      SYSTEM_PROGRAM,
      ZK_ELGAMAL_PROOF_PROGRAM,
      SYSTEM_PROGRAM,
      ZK_ELGAMAL_PROOF_PROGRAM,
      TOKEN_2022_PROGRAM,
      ZK_ELGAMAL_PROOF_PROGRAM,
      ZK_ELGAMAL_PROOF_PROGRAM,
    ],
    "program sequence changed",
  );
  assert.deepEqual(
    shape.map((s) => s.lead),
    [0, 3, 0, 6, 27, 0, 0],
    "leading discriminators changed: CreateAccount=0, VerifyCiphertextCommitmentEquality=3, VerifyBatchedRangeProofU64=6, ConfidentialTransferExtension=27, CloseContextState=0",
  );
  // The one second byte that IS a discriminator: Withdraw inside the
  // Confidential Transfer extension, beside ApplyPendingBalance at 27/8.
  assert.equal(
    (instructions[4]?.data ?? new Uint8Array())[1],
    6,
    "Withdraw sub-discriminator changed",
  );
  assert.deepEqual(
    [shape[1]?.bytes, shape[3]?.bytes],
    [321, 937],
    "inline proof bytes changed; the five-transaction packing rests on these",
  );
});
