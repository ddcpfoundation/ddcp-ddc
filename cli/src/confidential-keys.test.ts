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
  type Address,
  type MessagePartialSigner,
} from "@solana/kit";
import {
  deriveAeKeyForOwnerMint,
  deriveElGamalKeypairForOwnerMint,
} from "@solana-program/token-2022/confidential";
import { DDC_MINT } from "./constants.js";
import {
  confidentialKeyMessage,
  confidentialKeySeed,
  deriveConfidentialKeys,
} from "./confidential-keys.js";

const DOMAIN_TAG = "solana-conf-bal/v1";

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

test("seed is owner bytes followed by mint bytes, 64 bytes total", async () => {
  const signer = await generateKeyPairSigner();
  const owner: Address = signer.address;
  const seed = confidentialKeySeed(owner, DDC_MINT);
  const encoder = getAddressEncoder();
  const ownerBytes = new Uint8Array(encoder.encode(owner));
  const mintBytes = new Uint8Array(encoder.encode(DDC_MINT));
  assert.equal(ownerBytes.length, 32);
  assert.equal(mintBytes.length, 32);
  assert.equal(seed.length, 64);
  assert.deepEqual(seed.subarray(0, 32), ownerBytes);
  assert.deepEqual(seed.subarray(32, 64), mintBytes);
});

test("message is the literal domain tag followed by the 64-byte seed", async () => {
  const signer = await generateKeyPairSigner();
  const message = confidentialKeyMessage(signer.address, DDC_MINT);
  const tagBytes = new TextEncoder().encode(DOMAIN_TAG);
  assert.equal(tagBytes.length, 18);
  assert.equal(message.length, tagBytes.length + 64);
  assert.equal(
    new TextDecoder().decode(message.subarray(0, tagBytes.length)),
    DOMAIN_TAG,
  );
  assert.deepEqual(
    message.subarray(tagBytes.length),
    confidentialKeySeed(signer.address, DDC_MINT),
  );
});

test("ORACLE: all three derived byte strings are identical to upstream's", async () => {
  const signer = await generateKeyPairSigner();
  const owner: Address = signer.address;

  const ours = await deriveConfidentialKeys({ signer, owner, mint: DDC_MINT });

  // Upstream, via the sole permitted /confidential import. Two INDEPENDENT
  // WebAssembly instances are live here (ours /node, upstream's /bundler), so
  // only extracted bytes are compared — never handles.
  const theirKeypair = await deriveElGamalKeypairForOwnerMint({
    signer,
    owner,
    mint: DDC_MINT,
  });
  const theirAeKey = await deriveAeKeyForOwnerMint({
    signer,
    owner,
    mint: DDC_MINT,
  });

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
  const result = await deriveConfidentialKeys({
    signer,
    owner: inner.address,
    mint: DDC_MINT,
  });
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
      deriveConfidentialKeys({
        signer: silent,
        owner: inner.address,
        mint: DDC_MINT,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(inner.address), "must name the signer");
      return true;
    },
  );
});
