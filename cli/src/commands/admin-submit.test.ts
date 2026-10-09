// Offline unit tests for the submit-stage PURE helpers only, per convention:
// the live broadcast path is proven by a real devnet run, never mocked.

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
import { assembleMintTokensTransaction } from "../tx/mint-tx.js";
import { applyReserveCountersignature } from "../tx/countersign-apply.js";
import {
  decodeAdminTxWire,
  verifyMintCountersign,
  type CountersignContext,
} from "../tx/countersign-verify.js";
import { jsonWithBigints } from "../tx/broadcast.js";
import {
  assertEnvelopeFullySigned,
  formatBurnSubmitInspection,
  formatRotateSignerSubmitInspection,
  formatSubmitInspection,
  formatUpdateFeeSubmitInspection,
  sha256HexOf,
} from "./admin-submit.js";

// Hermetic: a throwaway initiator plays the live issuer and a throwaway Reserve
// signer plays the live Reserve, so the COUNTERSIGNED state can be produced
// offline. Fixed addresses mirror countersign-verify.test.ts.
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";
const STALE_NONCE = "6Ghu56Lum8acRdYbtK4aLyNNnJK9TF4fRfNmimDd3FdY";
const ISSUER_V2 = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");

function wireOf(tx: Transaction): Uint8Array {
  return Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(tx), "base64"),
  );
}

async function makeLifecycle() {
  const initiator = await generateKeyPairSigner();
  const reserve = await generateKeyPairSigner();
  const { transaction } = await assembleMintTokensTransaction({
    mint: MINT,
    destination: DESTINATION,
    mintState: MINT_STATE,
    issuerAuthority: initiator.address,
    reserveAuthority: reserve.address,
    token2022Program: TOKEN_2022,
    amount: 1_000_000n,
    nonceAccount: NONCE_ACCOUNT,
    nonceAuthority: initiator.address,
    nonceValue: NONCE_VALUE,
    initiatorSigner: initiator,
  });
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

test("submit verify: a countersigned tx passes the submit stage and extracts amount + destination", async () => {
  const { initiator, reserve, countersignedWire } = await makeLifecycle();
  const verdict = verifyMintCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(initiator.address, reserve.address),
    "submit",
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("verdict must be ok");
  assert.equal(verdict.amount, 1_000_000n);
  assert.equal(verdict.destination, DESTINATION);
});

test("submit verify: an issuer-only (not countersigned) tx is refused at the submit stage", async () => {
  const { initiator, reserve, issuerOnlyWire } = await makeLifecycle();
  const verdict = verifyMintCountersign(
    decodeAdminTxWire(issuerOnlyWire),
    ctxFor(initiator.address, reserve.address),
    "submit",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /is not signed/);
});

test("submit verify: a countersigned tx against a MOVED live nonce is refused as stale", async () => {
  const { initiator, reserve, countersignedWire } = await makeLifecycle();
  const verdict = verifyMintCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(initiator.address, reserve.address, { liveNonceValue: STALE_NONCE }),
    "submit",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /stale nonce/);
});

test("submit verify: default (countersign) stage still refuses a countersigned tx — countersign-stage behavior unchanged", async () => {
  const { initiator, reserve, countersignedWire } = await makeLifecycle();
  const verdict = verifyMintCountersign(
    decodeAdminTxWire(countersignedWire),
    ctxFor(initiator.address, reserve.address),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /already signed/);
});

test("fully-signed gate: passes the countersigned wire; refuses the issuer-only wire naming the unsigned Reserve slot", async () => {
  const { reserve, issuerOnlyWire, countersignedWire } = await makeLifecycle();
  assert.doesNotThrow(() => assertEnvelopeFullySigned(countersignedWire));
  assert.throws(
    () => assertEnvelopeFullySigned(issuerOnlyWire),
    (err: unknown) =>
      err instanceof Error &&
      /SUBMIT REFUSED \(not fully signed\)/.test(err.message) &&
      err.message.includes(reserve.address),
  );
});

test("sha256 is computed and deterministic: stable across calls, known empty-input vector, sensitive to one byte flip", () => {
  assert.equal(
    sha256HexOf(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(sha256HexOf(bytes), sha256HexOf(Uint8Array.from([1, 2, 3, 4])));
  assert.notEqual(sha256HexOf(bytes), sha256HexOf(Uint8Array.from([1, 2, 3, 5])));
});

test("inspection block: amount/DDC, destination, fee payer, nonce, pre-supply, and the sha256 all appear", () => {
  const sha = "ab".repeat(32);
  const out = formatSubmitInspection({
    amount: 1_000_000n,
    destination: DESTINATION,
    feePayer: ISSUER_V2,
    nonceValue: NONCE_VALUE,
    supplyBaseUnits: "600000000",
    sha256Hex: sha,
  });
  assert.ok(out.includes("1000000 base units = 1.000000 DDC"));
  assert.ok(out.includes(`destination    : ${DESTINATION}`));
  assert.ok(out.includes(`fee payer      : ${ISSUER_V2} (live issuer)`));
  assert.ok(out.includes(`nonce value    : ${NONCE_VALUE}`));
  assert.ok(out.includes("600000000 base units = 600.000000 DDC"));
  assert.ok(out.includes(`wire sha256    : ${sha}`));
});

test("burn inspection block: amount/DDC, source, fee payer, nonce, pre-supply, the DECREASE label, and the sha256 all appear", () => {
  const sha = "cd".repeat(32);
  const SOURCE = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
  const out = formatBurnSubmitInspection({
    amount: 250_000n,
    source: SOURCE,
    feePayer: ISSUER_V2,
    nonceValue: NONCE_VALUE,
    supplyBaseUnits: "601000000",
    sha256Hex: sha,
  });
  assert.ok(out.includes("250000 base units = 0.250000 DDC"));
  assert.ok(out.includes(`source         : ${SOURCE}`));
  assert.ok(out.includes(`fee payer      : ${ISSUER_V2} (live issuer)`));
  assert.ok(out.includes(`nonce value    : ${NONCE_VALUE}`));
  assert.ok(out.includes("601000000 base units = 601.000000 DDC"));
  assert.ok(out.includes("supply and source balance DECREASE"));
  assert.ok(out.includes(`wire sha256    : ${sha}`));
});

test("update-fee inspection block: will-set triple, current (pre) newer_transfer_fee line, operator fee payer, and the sha256 all appear", () => {
  const sha = "ef".repeat(32);
  const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
  const out = formatUpdateFeeSubmitInspection({
    newFeeBasisPoints: 250,
    newMaximumFee: 5_000_000n,
    newMinimumFee: 1_000n,
    currentBasisPoints: 100,
    currentMaximumFee: 1_000_000n,
    currentMinimumFee: 0n,
    feePayer: OPERATOR,
    nonceValue: NONCE_VALUE,
    sha256Hex: sha,
  });
  assert.ok(out.includes("instruction    : update_transfer_fee"));
  assert.ok(
    out.includes(
      "will set       : fee 250 bps, maximum 5000000 base units = 5.000000 DDC, minimum 1000 base units = 0.001000 DDC",
    ),
  );
  assert.ok(out.includes("current (pre)  : fee 100 bps, maximum 1000000 base units (newer_transfer_fee), minimum 0 base units (PDA-1)"));
  assert.ok(out.includes("two epochs after the epoch this lands in (Token-2022 schedules newer_transfer_fee at the current epoch + 2)"));
  assert.ok(out.includes(`fee payer      : ${OPERATOR} (live operator)`));
  assert.ok(out.includes(`nonce value    : ${NONCE_VALUE}`));
  assert.ok(out.includes(`wire sha256    : ${sha}`));
});

test("rotate inspection block: target-role + name, new signer, CURRENT holder from live PDA-1, irreversibility warning, operator fee payer, nonce, and the sha256 all appear", () => {
  const sha = "12".repeat(32);
  const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
  const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
  const out = formatRotateSignerSubmitInspection({
    role: 0,
    newPubkey: DESTINATION,
    liveIssuer: ISSUER_V2,
    liveOperator: OPERATOR,
    liveReserve: RESERVE,
    feePayer: OPERATOR,
    nonceValue: NONCE_VALUE,
    sha256Hex: sha,
  });
  assert.ok(out.includes("instruction    : rotate_signer"));
  assert.ok(out.includes("Reserve countersigner slot signed"));
  assert.ok(
    out.includes(
      `will rotate    : target-role 0 (Issuer) -> new signer ${DESTINATION}`,
    ),
  );
  assert.ok(
    out.includes(
      `current (pre)  : role 0 (Issuer) authority is ${ISSUER_V2} (live PDA-1)`,
    ),
  );
  assert.ok(out.includes("IRREVERSIBLE"));
  assert.ok(out.includes("recovery requires another Operator+Reserve rotate_signer"));
  assert.ok(out.includes(`fee payer      : ${OPERATOR} (live operator)`));
  assert.ok(out.includes(`nonce value    : ${NONCE_VALUE}`));
  assert.ok(out.includes(`wire sha256    : ${sha}`));
  // Role -> current-holder mapping pins for the other two live roles: the
  // before/after line must name the holder of the TARGET role, not a fixed
  // field.
  const outReserve = formatRotateSignerSubmitInspection({
    role: 2,
    newPubkey: DESTINATION,
    liveIssuer: ISSUER_V2,
    liveOperator: OPERATOR,
    liveReserve: RESERVE,
    feePayer: OPERATOR,
    nonceValue: NONCE_VALUE,
    sha256Hex: sha,
  });
  assert.ok(
    outReserve.includes(
      `current (pre)  : role 2 (Reserve) authority is ${RESERVE} (live PDA-1)`,
    ),
  );
  const outOperator = formatRotateSignerSubmitInspection({
    role: 1,
    newPubkey: DESTINATION,
    liveIssuer: ISSUER_V2,
    liveOperator: OPERATOR,
    liveReserve: RESERVE,
    feePayer: OPERATOR,
    nonceValue: NONCE_VALUE,
    sha256Hex: sha,
  });
  assert.ok(
    outOperator.includes(
      `current (pre)  : role 1 (Operator) authority is ${OPERATOR} (live PDA-1)`,
    ),
  );
});

test("rotate inspection block: role > 2 renders the unknown/rejected-on-chain form without throwing", () => {
  const sha = "34".repeat(32);
  const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
  const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
  const out = formatRotateSignerSubmitInspection({
    role: 5,
    newPubkey: DESTINATION,
    liveIssuer: ISSUER_V2,
    liveOperator: OPERATOR,
    liveReserve: RESERVE,
    feePayer: OPERATOR,
    nonceValue: NONCE_VALUE,
    sha256Hex: sha,
  });
  assert.ok(out.includes("target-role 5 (unknown (rejected on-chain))"));
  assert.ok(
    out.includes(
      "current (pre)  : role 5 does not exist on PDA-1 (roles are 0..2) — the transaction will be REJECTED on-chain (InvalidRole)",
    ),
  );
  assert.ok(out.includes("IRREVERSIBLE"));
});

test("jsonWithBigints: bigints in RPC-shaped objects stringify as decimal strings", () => {
  assert.equal(
    jsonWithBigints({ slot: 123n, confirmationStatus: "confirmed", err: null }),
    '{"slot":"123","confirmationStatus":"confirmed","err":null}',
  );
});
