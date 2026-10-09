import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  isFullySignedTransaction,
} from "@solana/kit";
import { assembleMintTokensTransaction } from "./mint-tx.js";
import { applyReserveCountersignature } from "./countersign-apply.js";

// Hermetic: throwaway issuer + reserve per run; the assembled tx's reserveAuthority
// is the throwaway reserve's address, so its empty Reserve slot matches the key the
// test applies. Observed kit behaviors pinned here (from the pre-write
// probe): the wire decoder normalizes empty (all-zero) signature slots to
// null; partiallySignTransaction MERGES (issuer signature preserved
// byte-for-byte); a non-required-signer key is refused with a SolanaError
// ("... not a signer ...").
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

async function fixture() {
  const issuer = await generateKeyPairSigner();
  const reserve = await generateKeyPairSigner();
  const { transaction } = await assembleMintTokensTransaction({
    mint: MINT,
    destination: DESTINATION,
    mintState: MINT_STATE,
    issuerAuthority: issuer.address,
    reserveAuthority: reserve.address,
    token2022Program: TOKEN_2022,
    amount: 1_000_000n,
    nonceAccount: NONCE_ACCOUNT,
    nonceAuthority: issuer.address,
    nonceValue: NONCE_VALUE,
    initiatorSigner: issuer,
  });
  const wire = Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(transaction), "base64"),
  );
  const before = getTransactionDecoder().decode(wire);
  return { issuer, reserve, wire, before };
}

test("countersign apply: Reserve slot fills; issuer signature and messageBytes byte-identical; result fully signed", async () => {
  const { issuer, reserve, wire, before } = await fixture();
  const issuerSigBefore = before.signatures[issuer.address];
  if (issuerSigBefore == null) assert.fail("fixture: issuer slot must be signed");
  const messageBytesBefore = Uint8Array.from(before.messageBytes);

  const after = await applyReserveCountersignature(wire, reserve);

  // (1) both slots present, non-null, 64 bytes, non-zero.
  const issuerSigAfter = after.signatures[issuer.address];
  const reserveSigAfter = after.signatures[reserve.address];
  if (issuerSigAfter == null) assert.fail("issuer slot must remain signed");
  if (reserveSigAfter == null) assert.fail("reserve slot must be signed after apply");
  assert.equal(issuerSigAfter.length, 64);
  assert.equal(reserveSigAfter.length, 64);
  assert.ok(
    reserveSigAfter.some((b) => b !== 0),
    "reserve signature must be non-zero",
  );

  // (2) issuer signature byte-identical before/after — not clobbered.
  assert.deepEqual(
    Uint8Array.from(issuerSigAfter),
    Uint8Array.from(issuerSigBefore),
  );

  // (3) messageBytes unchanged — Reserve signed the same message.
  assert.deepEqual(Uint8Array.from(after.messageBytes), messageBytesBefore);

  // (4) kit's fully-signed predicate holds.
  assert.equal(isFullySignedTransaction(after), true);
});

test("countersign apply: a stray key (not a required signer) is rejected by kit — no countersignature injection", async () => {
  const { wire } = await fixture();
  const stray = await generateKeyPairSigner();
  // Observed kit behavior: partiallySignTransaction throws a SolanaError
  // naming the non-signer address problem; assert that rejection explicitly.
  await assert.rejects(
    applyReserveCountersignature(wire, stray),
    /not a signer/,
  );
});
