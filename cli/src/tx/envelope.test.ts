import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { assembleMintTokensTransaction } from "./mint-tx.js";
import {
  parseAdminTxEnvelope,
  serializeAdminTxEnvelope,
  type AdminTxClaim,
} from "./envelope.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

async function fixture() {
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
  });
  const claim: AdminTxClaim = {
    amountDisplay: "1 DDC",
    amount: "1000000",
    destination: DESTINATION,
    nonceAccount: NONCE_ACCOUNT,
    feePayer: initiator.address,
    initiatorRole: "issuer",
    signedBy: [initiator.address],
    awaitingSignature: "reserve",
  };
  return { transaction, claim };
}

test("envelope round-trip preserves the transaction bytes exactly and the claim", async () => {
  const { transaction, claim } = await fixture();
  const json = serializeAdminTxEnvelope(transaction, claim);
  const parsed = parseAdminTxEnvelope(json);
  const expectedHex = Buffer.from(
    getBase64EncodedWireTransaction(transaction),
    "base64",
  ).toString("hex");
  assert.equal(
    Buffer.from(parsed.transactionBytes).toString("hex"),
    expectedHex,
  );
  assert.deepEqual(parsed.claim, claim);
});

test('envelope parse rejects a wrong "kind" naming the expected kind', async () => {
  const { transaction, claim } = await fixture();
  const bad = JSON.parse(serializeAdminTxEnvelope(transaction, claim));
  bad.kind = "ddc-admin-tx-v0";
  assert.throws(
    () => parseAdminTxEnvelope(JSON.stringify(bad)),
    /kind mismatch.*ddc-admin-tx-v1/,
  );
});

test("envelope parse rejects malformed JSON naming the problem", () => {
  assert.throws(() => parseAdminTxEnvelope("{not json"), /not valid JSON/);
});

test('envelope parse rejects a missing "transaction" field naming it', async () => {
  const { transaction, claim } = await fixture();
  const bad = JSON.parse(serializeAdminTxEnvelope(transaction, claim));
  delete bad.transaction;
  assert.throws(
    () => parseAdminTxEnvelope(JSON.stringify(bad)),
    /"transaction"/,
  );
});
