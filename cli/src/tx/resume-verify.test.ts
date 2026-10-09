// Offline resume-verify tests. Fixtures are built exactly the way
// countersign-verify.test.ts builds them — assemble (via the generic
// durable-nonce pipe) + a throwaway Reserve countersign — so both signature
// states are available: issuer-only (countersign stage) and countersigned
// (submit stage).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Address,
  type Transaction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import { buildResumeIssuanceInstruction } from "../instructions/resume-issuance.js";
import { assembleDurableNonceTransaction } from "./durable-nonce-tx.js";
import { applyReserveCountersignature } from "./countersign-apply.js";
import {
  decodeAdminTxWire,
  type CountersignContext,
} from "./countersign-verify.js";
import { verifyResumeCountersign } from "./resume-verify.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";
// "Wrong" stand-ins: real, distinct devnet addresses.
const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
const STALE_NONCE = "6Ghu56Lum8acRdYbtK4aLyNNnJK9TF4fRfNmimDd3FdY";

function wireOf(tx: Transaction): Uint8Array {
  return Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(tx), "base64"),
  );
}

async function makeLifecycle(
  overrides: Partial<{ mint: Address; mintState: Address }> = {},
) {
  const initiator = await generateKeyPairSigner();
  const reserve = await generateKeyPairSigner();
  const { transaction } = await assembleDurableNonceTransaction(
    buildResumeIssuanceInstruction({
      mint: overrides.mint ?? MINT,
      mintState: overrides.mintState ?? MINT_STATE,
      issuerAuthority: initiator.address,
      reserveAuthority: reserve.address,
    }),
    {
      nonceAccount: NONCE_ACCOUNT,
      nonceAuthority: initiator.address,
      nonceValue: NONCE_VALUE,
    },
    initiator,
  );
  const issuerOnlyWire = wireOf(transaction);
  const countersigned = await applyReserveCountersignature(issuerOnlyWire, reserve);
  const countersignedWire = wireOf(countersigned);
  return { initiator, reserve, issuerOnlyWire, countersignedWire };
}

function ctxFor(
  liveIssuer: Address,
  liveReserve: Address,
  overrides: Partial<CountersignContext> = {},
): CountersignContext {
  return {
    liveIssuer,
    liveReserve,
    liveNonceValue: NONCE_VALUE,
    issuerNonceAccount: NONCE_ACCOUNT,
    mint: MINT,
    mintStatePda: MINT_STATE,
    token2022Program: TOKEN_2022,
    programId: PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM,
    ...overrides,
  };
}

test("resume verify: a good tx passes at both stages — issuer-only at countersign, countersigned at submit", async () => {
  const { initiator, reserve, issuerOnlyWire, countersignedWire } =
    await makeLifecycle();
  const atCountersign = verifyResumeCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
  );
  assert.equal(atCountersign.ok, true);
  const atSubmit = verifyResumeCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(initiator.address, reserve.address),
    "submit",
  );
  assert.equal(atSubmit.ok, true);
});

test("resume verify: tampered ix1 discriminator is refused naming the discriminator", async () => {
  const { initiator, reserve, countersignedWire } = await makeLifecycle();
  const decoded = decodeAdminTxWire(countersignedWire);
  const ix1 = decoded.instructions[1];
  if (ix1 === undefined) assert.fail("decoded tx has no instruction 1");
  ix1.data[0] = (ix1.data[0] ?? 0) ^ 0xff;
  const verdict = verifyResumeCountersign(
    decoded,
    ctxFor(initiator.address, reserve.address),
    "submit",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /discriminator/);
});

test("resume verify: wrong mint at account position 0 is refused naming the position", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle({
    mint: OPERATOR,
  });
  const verdict = verifyResumeCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /account 0 \(mint\)/);
});

test("resume verify: wrong PDA-1 at account position 1 is refused naming the position", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle({
    mintState: OPERATOR,
  });
  const verdict = verifyResumeCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /account 1 \(PDA-1 MintState\)/);
});

test("resume verify: STALE nonce — live nonce differs from the tx's — is refused as stale", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const verdict = verifyResumeCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address, { liveNonceValue: STALE_NONCE }),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /stale nonce/);
});

test("resume verify: a 3-instruction tx is refused naming the count", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const decoded = decodeAdminTxWire(issuerOnlyWire);
  const ix0 = decoded.instructions[0];
  if (ix0 === undefined) assert.fail("decoded tx has no instruction 0");
  const tampered = {
    ...decoded,
    instructions: [...decoded.instructions, ix0],
  };
  const verdict = verifyResumeCountersign(
    tampered,
    ctxFor(initiator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /expected exactly 2 instructions, got 3/);
});

test("resume verify: an already-signed Reserve slot is refused at the countersign stage", async () => {
  const { initiator, reserve, countersignedWire } = await makeLifecycle();
  const verdict = verifyResumeCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(initiator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /already signed/);
});

test("resume verify: an unsigned Reserve slot is refused at the submit stage", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const verdict = verifyResumeCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
    "submit",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /is not signed/);
});
