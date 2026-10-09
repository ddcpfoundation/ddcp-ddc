// Confidential-account key derivation — the `solana-conf-bal/v1` recipe,
// implemented DIRECTLY against @solana/zk-sdk and NOT via
// @solana-program/token-2022. The accepted cost of that choice is that this
// build owns the recipe and an upstream change to it arrives here with no
// signal. The upstream-recipe watch (confidential-keys.test.ts) runs against THIS file.
//
// THE RECIPE, in words, so the watch can be run without reading upstream:
//   1. public seed = owner pubkey bytes (32) || mint pubkey bytes (32)
//   2. message     = b"solana-conf-bal/v1" || public seed
//   3. signature   = the wallet's Ed25519 signature over that message, 64 bytes
//   4. ONE signature yields BOTH secrets: ConfidentialKeys.fromSignature(sig)
//      returns one object, and .elgamal() and .ae() come off it. The mixing
//      function is HKDF-SHA512 INSIDE the SDK; it is not implemented here and
//      must not be.
//
// WHY ONE SIGNATURE SUFFICES: Ed25519 signing is deterministic — the same key
// over the same message yields the same 64 bytes every time. Upstream requests
// a separate signature per key and gets identical results for exactly that
// reason. The property does NOT hold on passkey/WebAuthn authenticators, whose
// ECDSA signing is randomized by specification, so a passkey wallet cannot use
// this derivation route at all (the SDK ships a separate PRF path for them).
//
// The binding is per (owner, mint): stable across token-account close-and-
// reopen, and no key is reused across mints. This is upstream's convention,
// not a requirement of the SDK — the SDK's seed is caller-controlled. Matching
// it IS the interoperability contract.
//
// IMPORT NOTE: @solana/zk-sdk publishes NO root export — only /node, /web and
// /bundler. Production code imports /node. The test-only oracle reaches
// upstream, which imports /bundler; those are two INDEPENDENT WebAssembly
// instances and no object may cross between them, so every comparison is made
// on extracted bytes.
//
// No free() call is made on the WASM handles below. That MATCHES upstream,
// which also does not; it is a deliberate match, not an oversight.

import {
  createSignableMessage,
  getAddressEncoder,
  getTupleEncoder,
  type Address,
  type MessagePartialSigner,
} from "@solana/kit";
import { ConfidentialKeys } from "@solana/zk-sdk/node";

export interface DerivedConfidentialKeys {
  /** ElGamal public key, raw bytes — goes on-chain in ConfigureAccount. */
  elgamalPublicKey: Uint8Array;
  /** ElGamal secret key, raw bytes — NEVER written to disk or logged. */
  elgamalSecretKey: Uint8Array;
  /** AE key for `decryptable_available_balance`, raw bytes. */
  aeKey: Uint8Array;
}

/**
 * The public seed: owner bytes followed by mint bytes. Built with the same
 * tuple encoder upstream uses rather than a hand-rolled concatenation, so the
 * byte layout is read from the encoder and is not an inference on our side.
 */
export function confidentialKeySeed(owner: Address, mint: Address): Uint8Array {
  const encoder = getTupleEncoder([getAddressEncoder(), getAddressEncoder()]);
  return new Uint8Array(encoder.encode([owner, mint]));
}

/**
 * The exact message the wallet is asked to sign. Exposed separately so a
 * command can show the operator what it is about to be asked to approve, and
 * so the oracle can assert the domain tag directly.
 */
export function confidentialKeyMessage(
  owner: Address,
  mint: Address,
): Uint8Array {
  return new Uint8Array(
    ConfidentialKeys.signerMessage(confidentialKeySeed(owner, mint)),
  );
}

/**
 * Derive both confidential-account secrets from ONE wallet signature.
 *
 * Requests exactly one signature. The error path fails closed and names the
 * signer, never any key material.
 */
export async function deriveConfidentialKeys({
  signer,
  owner,
  mint,
}: {
  signer: MessagePartialSigner;
  owner: Address;
  mint: Address;
}): Promise<DerivedConfidentialKeys> {
  const message = confidentialKeyMessage(owner, mint);
  const [signatures] = await signer.signMessages([
    createSignableMessage(message),
  ]);
  const signature = signatures?.[signer.address];
  if (signature == null) {
    throw new Error(
      `signer ${signer.address} did not return a signature over the derivation message`,
    );
  }
  // ONE fromSignature call: both secrets come off the SAME object. Deriving
  // them from two separate calls would also work today by Ed25519
  // determinism, but it is not the rule.
  const keys = ConfidentialKeys.fromSignature(new Uint8Array(signature));
  const elgamal = keys.elgamal();
  return {
    elgamalPublicKey: new Uint8Array(elgamal.pubkey().toBytes()),
    elgamalSecretKey: new Uint8Array(elgamal.secret().toBytes()),
    aeKey: new Uint8Array(keys.ae().toBytes()),
  };
}
