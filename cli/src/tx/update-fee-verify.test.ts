// Offline update-fee verify tests (I-6). Fixtures are built the way
// burn-verify.test.ts builds them (generic durable-nonce assembly + a
// throwaway countersign), but over the OPERATOR FRAME: I-6 is Operator-initiated
// (fee-payer / nonce authority = Operator, over the Operator nonce account) and
// Issuer-countersigned. PDA-3 and the frame reach the verify as
// live-derived arguments (factory descriptor), never from the wire. The
// ctx deliberately carries the ISSUER nonce account while the frame and
// the wire use the OPERATOR nonce account — the happy paths passing pins that
// the FRAME governs checks b/c/e, not ctx.issuerNonceAccount. The fee
// triple is wire-fed confirm items, surfaced and never judged — an
// out-of-bounds triple (min > max) still verifies OK and lands in the
// extraction for the human confirm gate (pinned below).

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
import { buildUpdateTransferFeeInstruction } from "../instructions/update-transfer-fee.js";
import { assembleDurableNonceTransaction } from "./durable-nonce-tx.js";
import { applyReserveCountersignature } from "./countersign-apply.js";
import type { SignerFrame } from "./admin-verify-core.js";
import {
  decodeAdminTxWire,
  type CountersignContext,
} from "./countersign-verify.js";
import { verifyUpdateFeeCountersign } from "./update-fee-verify.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const PDA3 = address("48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu");
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
// "Wrong" stand-ins: real, distinct devnet addresses.
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const STALE_NONCE = "6Ghu56Lum8acRdYbtK4aLyNNnJK9TF4fRfNmimDd3FdY";

function wireOf(tx: Transaction): Uint8Array {
  return Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(tx), "base64"),
  );
}

async function makeLifecycle(
  triple: {
    newFeeBasisPoints: number;
    newMaximumFee: bigint;
    newMinimumFee: bigint;
  } = { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
) {
  const operator = await generateKeyPairSigner(); // initiator
  const issuer = await generateKeyPairSigner(); // countersigner
  const { transaction } = await assembleDurableNonceTransaction(
    buildUpdateTransferFeeInstruction({
      mint: MINT,
      feeAuthority: PDA3,
      mintState: MINT_STATE,
      issuerAuthority: issuer.address,
      operatorAuthority: operator.address,
      token2022Program: TOKEN_2022,
      newFeeBasisPoints: triple.newFeeBasisPoints,
      newMaximumFee: triple.newMaximumFee,
      newMinimumFee: triple.newMinimumFee,
    }),
    {
      nonceAccount: OPERATOR_NONCE_ACCOUNT,
      nonceAuthority: operator.address,
      nonceValue: NONCE_VALUE,
    },
    operator,
  );
  const operatorOnlyWire = wireOf(transaction);
  const countersigned = await applyReserveCountersignature(operatorOnlyWire, issuer);
  const countersignedWire = wireOf(countersigned);
  return { operator, issuer, operatorOnlyWire, countersignedWire };
}

function frameFor(operatorAddress: Address, issuerAddress: Address): SignerFrame {
  return {
    initiator: operatorAddress,
    initiatorLabel: "Operator",
    countersigner: issuerAddress,
    countersignerLabel: "issuer",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
  };
}

function ctxFor(
  liveIssuer: Address,
  overrides: Partial<CountersignContext> = {},
): CountersignContext {
  return {
    liveIssuer,
    liveReserve: RESERVE,
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

test("update-fee verify: a good Operator-initiated tx passes at countersign and extracts the fee triple", async () => {
  const { operator, issuer, operatorOnlyWire } = await makeLifecycle();
  const verdict = verifyUpdateFeeCountersign(
    decodeAdminTxWire(operatorOnlyWire),
    ctxFor(issuer.address),
    PDA3,
    frameFor(operator.address, issuer.address),
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass");
  assert.equal(verdict.newFeeBasisPoints, 250);
  assert.equal(verdict.newMaximumFee, 5_000_000n);
  assert.equal(verdict.newMinimumFee, 1_000n);
});

test("update-fee verify: a countersigned tx passes at the submit stage with the same triple", async () => {
  const { operator, issuer, countersignedWire } = await makeLifecycle();
  const verdict = verifyUpdateFeeCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(issuer.address),
    PDA3,
    frameFor(operator.address, issuer.address),
    "submit",
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass");
  assert.equal(verdict.newFeeBasisPoints, 250);
  assert.equal(verdict.newMaximumFee, 5_000_000n);
  assert.equal(verdict.newMinimumFee, 1_000n);
});

test("update-fee verify: STALE nonce — live nonce differs from the tx's — is refused as stale", async () => {
  const { operator, issuer, operatorOnlyWire } = await makeLifecycle();
  const verdict = verifyUpdateFeeCountersign(
    decodeAdminTxWire(operatorOnlyWire),
    ctxFor(issuer.address, { liveNonceValue: STALE_NONCE }),
    PDA3,
    frameFor(operator.address, issuer.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /stale nonce/);
});

test("update-fee verify: a wire whose issuer differs from the frame countersigner is refused at the slot check", async () => {
  const { operator, issuer, operatorOnlyWire } = await makeLifecycle();
  // Frame names Reserve as the countersigner; the wire carries the issuer
  // fixture — no signature slot exists for the frame's countersigner.
  const verdict = verifyUpdateFeeCountersign(
    decodeAdminTxWire(operatorOnlyWire),
    ctxFor(issuer.address),
    PDA3,
    frameFor(operator.address, RESERVE),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /no signature slot/);
});

test("update-fee verify: an out-of-bounds fee triple (min > max) is NOT judged — it surfaces in the extraction for the confirm gate", async () => {
  const { operator, issuer, operatorOnlyWire } = await makeLifecycle({
    newFeeBasisPoints: 250,
    newMaximumFee: 1_000n,
    newMinimumFee: 2_000_000n,
  });
  // Wire-fed confirm items are self-consistent by construction: the
  // structural verify passes and the countersign confirm gate
  // (plus the on-chain FeeBoundsInvalid check) is what judges the values.
  const verdict = verifyUpdateFeeCountersign(
    decodeAdminTxWire(operatorOnlyWire),
    ctxFor(issuer.address),
    PDA3,
    frameFor(operator.address, issuer.address),
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("must pass structurally");
  assert.equal(verdict.newFeeBasisPoints, 250);
  assert.equal(verdict.newMaximumFee, 1_000n);
  assert.equal(verdict.newMinimumFee, 2_000_000n);
});
