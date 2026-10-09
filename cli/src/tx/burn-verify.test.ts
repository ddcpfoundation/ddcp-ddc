// Offline burn-verify tests. Fixtures are built exactly the way
// resume-verify.test.ts builds them — assemble (via the generic
// durable-nonce pipe) + a throwaway Reserve countersign — so both signature
// states are available. PDA-5 reaches the verify as the live-derived
// argument (factory descriptor), never from the wire; amount and source
// are wire-fed confirm items and are surfaced, not judged — a swapped
// source therefore verifies OK and lands in the extraction for the human
// confirm gate (pinned below), the same contract as mint's destination.

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
import { buildBurnTokensInstruction } from "../instructions/burn-tokens.js";
import { assembleDurableNonceTransaction } from "./durable-nonce-tx.js";
import { applyReserveCountersignature } from "./countersign-apply.js";
import {
  decodeAdminTxWire,
  type CountersignContext,
} from "./countersign-verify.js";
import { verifyBurnCountersign } from "./burn-verify.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const SOURCE = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const PDA5 = address("EcwNe3hodPbgUr4GVZn6Rp547c7vbdxSx6jw9aQfDfXU");
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
  overrides: Partial<{
    mint: Address;
    mintState: Address;
    redemptionAuthority: Address;
  }> = {},
) {
  const initiator = await generateKeyPairSigner();
  const reserve = await generateKeyPairSigner();
  const { transaction } = await assembleDurableNonceTransaction(
    buildBurnTokensInstruction({
      mint: overrides.mint ?? MINT,
      source: SOURCE,
      mintState: overrides.mintState ?? MINT_STATE,
      redemptionAuthority: overrides.redemptionAuthority ?? PDA5,
      issuerAuthority: initiator.address,
      reserveAuthority: reserve.address,
      token2022Program: TOKEN_2022,
      amount: 250_000n,
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

test("burn verify: a good tx passes at both stages and extracts amount + source", async () => {
  const { initiator, reserve, issuerOnlyWire, countersignedWire } =
    await makeLifecycle();
  const atCountersign = verifyBurnCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
    PDA5,
  );
  assert.equal(atCountersign.ok, true);
  if (!atCountersign.ok) assert.fail("must pass");
  assert.equal(atCountersign.amount, 250_000n);
  assert.equal(atCountersign.source, SOURCE);
  const atSubmit = verifyBurnCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(initiator.address, reserve.address),
    PDA5,
    "submit",
  );
  assert.equal(atSubmit.ok, true);
  if (!atSubmit.ok) assert.fail("must pass");
  assert.equal(atSubmit.amount, 250_000n);
  assert.equal(atSubmit.source, SOURCE);
});

test("burn verify: wrong PDA-5 at account position 3 is refused naming the position", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle({
    redemptionAuthority: OPERATOR,
  });
  const verdict = verifyBurnCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
    PDA5,
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /account 3 \(PDA-5\)/);
});

test("burn verify: a swapped source is NOT structurally refused — it surfaces in the extraction for the confirm gate", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const decoded = decodeAdminTxWire(issuerOnlyWire);
  const ix0 = decoded.instructions[0];
  const ix1 = decoded.instructions[1];
  if (ix0 === undefined || ix1 === undefined) {
    assert.fail("decoded tx must have both instructions");
  }
  const tamperedIx1 = {
    ...ix1,
    accounts: ix1.accounts.map((a, i) => (i === 1 ? OPERATOR : a)),
  };
  const verdict = verifyBurnCountersign(
    { ...decoded, instructions: [ix0, tamperedIx1] },
    ctxFor(initiator.address, reserve.address),
    PDA5,
  );
  // Wire-fed confirm items are self-consistent by construction: the structural
  // verify passes and the countersigner's --confirm-source comparison is the
  // gate that catches a wrong source.
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass structurally");
  assert.equal(verdict.source, OPERATOR);
});

test("burn verify: a source-less ix1 is refused via the rebuild", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const decoded = decodeAdminTxWire(issuerOnlyWire);
  const ix0 = decoded.instructions[0];
  const ix1 = decoded.instructions[1];
  if (ix0 === undefined || ix1 === undefined) {
    assert.fail("decoded tx must have both instructions");
  }
  const firstAccount = ix1.accounts[0];
  if (firstAccount === undefined) {
    assert.fail("instruction 1 must have a first account");
  }
  const tamperedIx1 = { ...ix1, accounts: [firstAccount] };
  const verdict = verifyBurnCountersign(
    { ...decoded, instructions: [ix0, tamperedIx1] },
    ctxFor(initiator.address, reserve.address),
    PDA5,
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /no source account/);
});

test("burn verify: tampered ix1 discriminator is refused naming the discriminator", async () => {
  const { initiator, reserve, countersignedWire } = await makeLifecycle();
  const decoded = decodeAdminTxWire(countersignedWire);
  const ix1 = decoded.instructions[1];
  if (ix1 === undefined) assert.fail("decoded tx has no instruction 1");
  ix1.data[0] = (ix1.data[0] ?? 0) ^ 0xff;
  const verdict = verifyBurnCountersign(
    decoded,
    ctxFor(initiator.address, reserve.address),
    PDA5,
    "submit",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /discriminator/);
});

test("burn verify: STALE nonce — live nonce differs from the tx's — is refused as stale", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const verdict = verifyBurnCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address, { liveNonceValue: STALE_NONCE }),
    PDA5,
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /stale nonce/);
});
