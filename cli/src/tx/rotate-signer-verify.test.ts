// Offline rotate-signer verify tests (I-8). Since D-210 the replacement also
// carries the incoming key's signature, given before the Reserve's: the
// lifecycle below is Operator, then incoming key, then Reserve. Fixtures are built the way
// update-fee-verify.test.ts builds them (generic durable-nonce assembly + a
// throwaway countersign), but over the Operator->Reserve FRAME: I-8 is Operator-initiated
// (fee-payer / nonce authority = Operator, over the Operator nonce account) and
// Reserve-countersigned (contrast I-6, which is Issuer-countersigned). The frame
// reaches the verify as a live-derived argument (factory descriptor), never
// from the wire; there is no PDA-3 (I-8 has no CPI). role + new_pubkey are
// wire-fed confirm items, surfaced and never judged — an out-of-range role
// (>2) still verifies OK and lands in the extraction for the human confirm
// gate + the on-chain InvalidRole check (pinned below).
// The ctx carries the ISSUER nonce account while the frame and wire use the
// Operator nonce account — the happy paths passing pins that the FRAME governs
// checks b/c/e, and that Reserve (not Issuer) is the required countersigner.

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
import { buildRotateSignerInstruction } from "../instructions/rotate-signer.js";
import { assembleDurableNonceTransaction } from "./durable-nonce-tx.js";
import { applyReserveCountersignature } from "./countersign-apply.js";
import type { SignerFrame } from "./admin-verify-core.js";
import {
  decodeAdminTxWire,
  type CountersignContext,
} from "./countersign-verify.js";
import { verifyRotateSignerCountersign } from "./rotate-signer-verify.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const OPERATOR_NONCE_ACCOUNT = address(
  "Sd4959ZK3E2hnyt9o2RHLVxe9NX4Z7Z2ZPcWjaNsnMf",
);
const ISSUER_NONCE_ACCOUNT = address(
  "Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE",
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";
// "Wrong countersigner" stand-in: a real address distinct from the generated
// Reserve signer — pins that the frame's Reserve countersigner is what's checked.
// Also serves as the inert ctx.liveIssuer.
const ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const STALE_NONCE = "6Ghu56Lum8acRdYbtK4aLyNNnJK9TF4fRfNmimDd3FdY";

function wireOf(tx: Transaction): Uint8Array {
  return Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(tx), "base64"),
  );
}

async function makeLifecycle(
  params: { role: number; newPubkey?: Address } = { role: 0 },
) {
  const operator = await generateKeyPairSigner(); // initiator
  const reserve = await generateKeyPairSigner(); // countersigner
  const incoming = await generateKeyPairSigner(); // the key installed (D-210)
  const newPubkey = params.newPubkey ?? incoming.address;
  const { transaction } = await assembleDurableNonceTransaction(
    buildRotateSignerInstruction({
      mint: MINT,
      mintState: MINT_STATE,
      operatorAuthority: operator.address,
      reserveAuthority: reserve.address,
      role: params.role,
      newPubkey,
    }),
    {
      nonceAccount: OPERATOR_NONCE_ACCOUNT,
      nonceAuthority: operator.address,
      nonceValue: NONCE_VALUE,
    },
    operator,
  );
  const operatorOnlyWire = wireOf(transaction);
  // applyReserveCountersignature is signer-agnostic (merges by pubkey): the
  // incoming key signs first, then the Reserve.
  const incomingSigned = await applyReserveCountersignature(operatorOnlyWire, incoming);
  const incomingSignedWire = wireOf(incomingSigned);
  const countersigned = await applyReserveCountersignature(incomingSignedWire, reserve);
  const countersignedWire = wireOf(countersigned);
  return {
    operator,
    reserve,
    incoming,
    operatorOnlyWire,
    incomingSignedWire,
    countersignedWire,
  };
}

function frameFor(operatorAddress: Address, reserveAddress: Address): SignerFrame {
  return {
    initiator: operatorAddress,
    initiatorLabel: "Operator",
    countersigner: reserveAddress,
    countersignerLabel: "Reserve",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
  };
}

function ctxFor(
  liveReserve: Address,
  overrides: Partial<CountersignContext> = {},
): CountersignContext {
  return {
    liveIssuer: ISSUER,
    liveReserve,
    liveNonceValue: NONCE_VALUE,
    issuerNonceAccount: ISSUER_NONCE_ACCOUNT,
    mint: MINT,
    mintStatePda: MINT_STATE,
    token2022Program: TOKEN_2022,
    programId: PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM,
    ...overrides,
  };
}

test("rotate-signer verify: the incoming step passes on the Operator-signed tx and extracts role + new_pubkey", async () => {
  const { operator, reserve, incoming, operatorOnlyWire } = await makeLifecycle();
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(operatorOnlyWire),
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
    "countersign",
    true,
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass");
  assert.equal(verdict.role, 0);
  assert.equal(verdict.newPubkey, incoming.address);
});

test("rotate-signer verify: the Reserve's countersign passes once the incoming key has signed", async () => {
  const { operator, reserve, incoming, incomingSignedWire } = await makeLifecycle();
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(incomingSignedWire),
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass");
  assert.equal(verdict.newPubkey, incoming.address);
});

test("rotate-signer verify: the Reserve's countersign is refused while the incoming key has not signed, naming it and the --incoming step", async () => {
  const { operator, reserve, incoming, operatorOnlyWire } = await makeLifecycle();
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(operatorOnlyWire),
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.ok(verdict.reason.includes(`incoming key slot ${incoming.address} is not signed`));
  assert.ok(verdict.reason.includes("admin countersign --incoming"));
});

test("rotate-signer verify: the incoming step is refused once the incoming key has already signed", async () => {
  const { operator, reserve, incomingSignedWire } = await makeLifecycle();
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(incomingSignedWire),
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
    "countersign",
    true,
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /incoming key slot .* is already signed/);
});

test("rotate-signer verify: a fully signed tx passes at the submit stage with the same role + new_pubkey", async () => {
  const { operator, reserve, incoming, countersignedWire } = await makeLifecycle();
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
    "submit",
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass");
  assert.equal(verdict.role, 0);
  assert.equal(verdict.newPubkey, incoming.address);
});

test("rotate-signer verify: STALE nonce — live nonce differs from the tx's — is refused as stale", async () => {
  const { operator, reserve, incomingSignedWire } = await makeLifecycle();
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(incomingSignedWire),
    ctxFor(reserve.address, { liveNonceValue: STALE_NONCE }),
    frameFor(operator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /stale nonce/);
});

test("rotate-signer verify: a frame naming a countersigner other than the wire's Reserve is refused at the slot check (Reserve is required)", async () => {
  const { operator, reserve, incomingSignedWire } = await makeLifecycle();
  // The wire carries operator + the generated Reserve + the incoming key; the
  // frame names ISSUER as the countersigner — no signature slot exists for
  // it. Pins that Reserve (the frame countersigner), not Issuer, is what I-8
  // requires.
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(incomingSignedWire),
    ctxFor(reserve.address),
    frameFor(operator.address, ISSUER),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /no signature slot/);
});

test("rotate-signer verify: an out-of-range role (5) is NOT judged — it surfaces in the extraction for the confirm gate", async () => {
  const { operator, reserve, incoming, incomingSignedWire } = await makeLifecycle({
    role: 5,
  });
  // Wire-fed confirm items are self-consistent by construction: the
  // structural verify passes; the countersign --confirm-target-role gate and
  // the on-chain InvalidRole (6005) check are what reject role > 2.
  const verdict = verifyRotateSignerCountersign(
    decodeAdminTxWire(incomingSignedWire),
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass structurally");
  assert.equal(verdict.role, 5);
  assert.equal(verdict.newPubkey, incoming.address);
});

test("rotate-signer verify: a replacement with the Reserve's own current key has two slots and passes the Reserve's countersign with no incoming step", async () => {
  // Self-rotation: the new key is the Reserve, whose one signature covers
  // both of its account positions.
  const operator = await generateKeyPairSigner();
  const reserve = await generateKeyPairSigner();
  const { transaction } = await assembleDurableNonceTransaction(
    buildRotateSignerInstruction({
      mint: MINT,
      mintState: MINT_STATE,
      operatorAuthority: operator.address,
      reserveAuthority: reserve.address,
      role: 2,
      newPubkey: reserve.address,
    }),
    {
      nonceAccount: OPERATOR_NONCE_ACCOUNT,
      nonceAuthority: operator.address,
      nonceValue: NONCE_VALUE,
    },
    operator,
  );
  const decoded = decodeAdminTxWire(wireOf(transaction));
  assert.equal(decoded.signatures.length, 2);
  const verdict = verifyRotateSignerCountersign(
    decoded,
    ctxFor(reserve.address),
    frameFor(operator.address, reserve.address),
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass");
  assert.equal(verdict.newPubkey, reserve.address);
});
