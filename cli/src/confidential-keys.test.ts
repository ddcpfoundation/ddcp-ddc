// Byte-identity oracle for the confidential-key derivation plus the
// one-signature assertion.
//
// THIS FILE IS ONE OF THREE ORACLES PERMITTED TO IMPORT FROM
// @solana-program/token-2022/confidential. Production code never imports that
// subpath; the three oracles are the sole exception.
//
// The import pulls in @solana/zk-sdk/bundler, whose loader relies on Node's
// EXPERIMENTAL WebAssembly module import. Expect an ExperimentalWarning on
// stderr during the gate from the commit that lands this file onward — it is
// not a regression.
//
// IMPORTANT FAILURE-MODE NOTE. If this file ever fails to LOAD, the reporter
// shows failing tests, which looks identical to the recipe having drifted —
// the exact thing the oracle exists to detect. Tell them apart by reading the
// error: a load failure names a module resolution or WebAssembly problem; a
// drift failure is an assertion mismatch on bytes.
//
// Offline and pure, per convention: no network, and no live path is mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  type MessagePartialSigner,
} from "@solana/kit";
import {
  deriveAeKey,
  deriveElGamalKeypair,
} from "@solana-program/token-2022/confidential";
import { DDC_MINT } from "./constants.js";
import {
  confidentialKeyMessage,
  deriveConfidentialKeys,
} from "./confidential-keys.js";

const DOMAIN_TAG = "solana-conf-bal/v1";
const DOMAIN_TAG_HEX = "736f6c616e612d636f6e662d62616c2f7631";

/**
 * Wraps a signer and counts signMessages calls. Used to assert the rule —
 * ONE signature yields both keys — as a behavior rather than
 * as a comment.
 */
function countingSigner(inner: MessagePartialSigner): {
  signer: MessagePartialSigner;
  calls: () => number;
} {
  let calls = 0;
  const signer: MessagePartialSigner = {
    address: inner.address,
    signMessages: async (messages) => {
      calls += 1;
      return await inner.signMessages(messages);
    },
  };
  return { signer, calls: () => calls };
}

test("message is exactly the 18 bytes of the domain tag, nothing appended", async () => {
  const message = confidentialKeyMessage();
  const tagBytes = new TextEncoder().encode(DOMAIN_TAG);
  assert.equal(tagBytes.length, 18);
  assert.equal(message.length, 18);
  assert.equal(Buffer.from(message).toString("hex"), DOMAIN_TAG_HEX);
  assert.deepEqual(message, tagBytes);
});

test("the superseded tag-owner-mint message is not produced, nor requested of the wallet", async () => {
  const inner = await generateKeyPairSigner();
  const encoder = getAddressEncoder();
  const superseded = new Uint8Array([
    ...new TextEncoder().encode(DOMAIN_TAG),
    ...encoder.encode(inner.address),
    ...encoder.encode(DDC_MINT),
  ]);
  assert.equal(superseded.length, 18 + 64);
  assert.notDeepEqual(confidentialKeyMessage(), superseded);

  // What the wallet is actually asked to sign, captured at the signer.
  const asked: Uint8Array[] = [];
  const recording: MessagePartialSigner = {
    address: inner.address,
    signMessages: async (messages) => {
      for (const m of messages) asked.push(new Uint8Array(m.content));
      return await inner.signMessages(messages);
    },
  };
  await deriveConfidentialKeys({ signer: recording });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], new TextEncoder().encode(DOMAIN_TAG));
  assert.notDeepEqual(asked[0], superseded);
});

test("ORACLE: all three derived byte strings are identical to upstream's", async () => {
  const signer = await generateKeyPairSigner();

  const ours = await deriveConfidentialKeys({ signer });

  // Upstream, via the sole permitted /confidential import, on its default
  // path: no publicSeed argument, so the empty seed. Two INDEPENDENT
  // WebAssembly instances are live here (ours /node, upstream's /bundler), so
  // only extracted bytes are compared — never handles.
  const theirKeypair = await deriveElGamalKeypair({ signer });
  const theirAeKey = await deriveAeKey({ signer });

  // Upstream returns the ElGamal public key as an Address (base58); decode it
  // back to bytes rather than encoding ours to a string.
  const theirPubkeyBytes = new Uint8Array(
    getAddressEncoder().encode(theirKeypair.elgamalPubkey),
  );

  assert.deepEqual(
    ours.elgamalPublicKey,
    theirPubkeyBytes,
    "ElGamal public key diverged from upstream",
  );
  assert.deepEqual(
    ours.elgamalSecretKey,
    new Uint8Array(theirKeypair.secretKey),
    "ElGamal secret key diverged from upstream",
  );
  assert.deepEqual(
    ours.aeKey,
    new Uint8Array(theirAeKey),
    "AE key diverged from upstream",
  );
});

test("ONE signature yields BOTH secrets, not one per key", async () => {
  const inner = await generateKeyPairSigner();
  const { signer, calls } = countingSigner(inner);
  const result = await deriveConfidentialKeys({ signer });
  assert.equal(calls(), 1, "derivation must request exactly one signature");
  assert.ok(result.elgamalPublicKey.length > 0);
  assert.ok(result.elgamalSecretKey.length > 0);
  assert.ok(result.aeKey.length > 0);
});

test("a signer returning no signature is refused, naming the signer", async () => {
  const inner = await generateKeyPairSigner();
  const silent: MessagePartialSigner = {
    address: inner.address,
    signMessages: async () => [{}],
  };
  await assert.rejects(
    () =>
      deriveConfidentialKeys({ signer: silent }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(inner.address), "must name the signer");
      return true;
    },
  );
});
