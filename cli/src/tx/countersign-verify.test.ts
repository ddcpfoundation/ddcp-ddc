import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Address,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import { assembleMintTokensTransaction, type MintTxInput } from "./mint-tx.js";
import {
  decodeAdminTxWire,
  verifyMintCountersign,
  type CountersignContext,
} from "./countersign-verify.js";

// Hermetic: throwaway initiator per run plays the live issuer. Tamper
// strategies used below: BAD ASSEMBLER INPUTS for wrong-mint and
// wrong-nonce-account; TARGETED MUTATION of the decoded structure for the
// discriminator, 3-instruction, Reserve-already-signed, and fee-payer cases;
// CTX VARIATION for rotated-issuer, Reserve-mismatch, and stale-nonce.
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";
// "Wrong" stand-ins: real, distinct devnet addresses.
const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
const OPERATOR_NONCE = address("Sd4959ZK3E2hnyt9o2RHLVxe9NX4Z7Z2ZPcWjaNsnMf");
const STALE_NONCE = "6Ghu56Lum8acRdYbtK4aLyNNnJK9TF4fRfNmimDd3FdY";

async function makeDecoded(overrides: Partial<MintTxInput> = {}) {
  const initiator = await generateKeyPairSigner();
  const { transaction } = await assembleMintTokensTransaction({
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
    ...overrides,
  });
  const wire = Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(transaction), "base64"),
  );
  return { initiator, decoded: decodeAdminTxWire(wire) };
}

function ctxFor(
  liveIssuer: Address,
  overrides: Partial<CountersignContext> = {},
): CountersignContext {
  return {
    liveIssuer,
    liveReserve: RESERVE,
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

test("countersign verify: good issuer-signed tx passes; extracted amount and destination equal the known inputs (display path)", async () => {
  const { initiator, decoded } = await makeDecoded();
  const verdict = verifyMintCountersign(decoded, ctxFor(initiator.address));
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("verdict must be ok");
  assert.equal(verdict.amount, 1_000_000n);
  assert.equal(verdict.destination, DESTINATION);
});

test("countersign verify: tampered ix1 discriminator is refused naming the discriminator", async () => {
  const { initiator, decoded } = await makeDecoded();
  const ix1 = decoded.instructions[1];
  if (ix1 === undefined) assert.fail("decoded tx has no instruction 1");
  ix1.data[0] = (ix1.data[0] ?? 0) ^ 0xff;
  const verdict = verifyMintCountersign(decoded, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /discriminator/);
});

test("countersign verify: wrong mint at account position 0 is refused naming the position", async () => {
  const { initiator, decoded } = await makeDecoded({ mint: OPERATOR });
  const verdict = verifyMintCountersign(decoded, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /account 0 \(mint\)/);
});

test("countersign verify: wrong PDA-1 at account position 2 is refused naming the position", async () => {
  const { initiator, decoded } = await makeDecoded({ mintState: OPERATOR });
  const verdict = verifyMintCountersign(decoded, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /account 2 \(PDA-1 MintState\)/);
});

test("countersign verify: ISSUER ROTATED IN TRANSIT — live issuer differs from the tx's — is refused at the fee-payer slot", async () => {
  const { decoded } = await makeDecoded();
  const verdict = verifyMintCountersign(decoded, ctxFor(OPERATOR));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /not the live on-chain issuer/);
});

test("countersign verify: Reserve mismatch — live Reserve differs from the embedded one — is refused at the slot check", async () => {
  const { initiator, decoded } = await makeDecoded();
  const verdict = verifyMintCountersign(
    decoded,
    ctxFor(initiator.address, { liveReserve: OPERATOR }),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /no signature slot for the live on-chain Reserve/);
});

test("countersign verify: a 3-instruction tx is refused naming the count", async () => {
  const { initiator, decoded } = await makeDecoded();
  const ix0 = decoded.instructions[0];
  if (ix0 === undefined) assert.fail("decoded tx has no instruction 0");
  const tampered = {
    ...decoded,
    instructions: [...decoded.instructions, ix0],
  };
  const verdict = verifyMintCountersign(tampered, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /expected exactly 2 instructions, got 3/);
});

test("countersign verify: ix0 over the WRONG nonce account is refused naming the nonce account", async () => {
  const { initiator, decoded } = await makeDecoded({
    nonceAccount: OPERATOR_NONCE,
  });
  const verdict = verifyMintCountersign(decoded, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /not the issuer nonce account/);
});

test("countersign verify: STALE nonce — live nonce differs from the tx's — is refused as stale", async () => {
  const { initiator, decoded } = await makeDecoded();
  const verdict = verifyMintCountersign(
    decoded,
    ctxFor(initiator.address, { liveNonceValue: STALE_NONCE }),
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /stale nonce/);
});

test("countersign verify: an already-signed Reserve slot is refused", async () => {
  const { initiator, decoded } = await makeDecoded();
  const tampered = {
    ...decoded,
    signatures: decoded.signatures.map((s) =>
      s.address === RESERVE ? { ...s, signed: true } : s,
    ),
  };
  const verdict = verifyMintCountersign(tampered, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /already signed/);
});

test("countersign verify: fee payer differing from the live issuer is refused", async () => {
  const { initiator, decoded } = await makeDecoded();
  const tampered = { ...decoded, feePayer: OPERATOR };
  const verdict = verifyMintCountersign(tampered, ctxFor(initiator.address));
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /fee payer/);
});
