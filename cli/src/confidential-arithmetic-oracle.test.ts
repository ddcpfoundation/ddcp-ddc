// ORACLE for the vendored ciphertext arithmetic.
// The file under test is cli/src/vendor/confidentialTransferArithmetic.ts: the
// upstream file with an attribution header prepended and NOTHING else changed.
// The first test below is the drift
// tripwire, anchored on the header as PINNED TEXT and on the body as a PINNED
// HASH, so neither half rests on a line count that can rot.
//
// THE EXPECTATIONS ARE CONSTRUCTED, NEVER CAPTURED. Every
// expected ciphertext is built by asking the SDK to encrypt a DIFFERENT
// plaintext under a SEPARATELY COMPUTED opening, using PedersenOpening's own
// add / subtract / multiplyByU64. Nothing here runs the function under test
// and pastes its output, and nothing shares a code path with it: the vendored
// file is pure @noble/curves and touches no WebAssembly at all.
//
// ONE WASM INSTANCE, so the confidential-keys.ts caveat does not apply here.
// The three existing oracles reach upstream, which imports /bundler, and must
// keep everything on extracted bytes because no object may cross between two
// instances. This file imports /node only. Comparisons are still made on
// bytes, because bytes are what the vendored file speaks.
//
// PATHS COME FROM import.meta.url, NEVER FROM process.argv[1] OR cwd. Node
// realpaths an ESM entry point but leaves argv[1] as typed, and this suite has
// already paid once for that difference.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ElGamalCiphertext,
  ElGamalKeypair,
  GroupedElGamalCiphertext3Handles,
  PedersenOpening,
} from "@solana/zk-sdk/node";
import {
  addWithLoHiCiphertexts,
  extractCiphertextFromGroupedBytes,
  subtractAmountFromCiphertext,
  subtractWithLoHiCiphertexts,
} from "./vendor/confidentialTransferArithmetic.js";

/** The attribution header, verbatim. The file must begin with exactly these bytes. */
const VENDOR_HEADER = `// VENDORED FILE. The ONLY modification is this header, prepended for
// attribution. Everything below it is byte-identical to upstream.
//   origin   @solana-program/token-2022 0.15.0,
//            src/confidentialTransferArithmetic.ts
//   project  https://github.com/solana-program/token-2022
//   commit   74b48bf67f6ebc541a7589a9a44e05dd11fea7d4
//   license  Apache License 2.0; see NOTICE and LICENSE-Apache-2.0 at the
//            repository root
//   body     118 lines, sha256
//            3d1baace3f564f9d3927fd15ada99c9b43f635bb6caacb856201e3c46319affa
// DO NOT EDIT BELOW THIS LINE. An edit here is a fork, not a fix: this copy is
// DELETED rather than maintained once @solana/zk-sdk publishes ElGamalCiphertext
// arithmetic. confidential-arithmetic-oracle.test.ts pins this
// header verbatim and hashes the body after it, so a change to either fails.

`;

/** Upstream pins, from @solana-program/token-2022 0.15.0 at commit 74b48bf6. */
const VENDORED_SHA256 = "3d1baace3f564f9d3927fd15ada99c9b43f635bb6caacb856201e3c46319affa";
const VENDORED_LINES = 118;
const LICENSE_SHA256 = "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9";
const LICENSE_LINES = 176;

const BIT_LENGTH = 16n;
const SCALE = 1n << BIT_LENGTH;
const CIPHERTEXT_BYTES = 64;
const COMMITMENT_BYTES = 32;

const bytesOf = (url: URL): Buffer => readFileSync(url);
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const lineCount = (b: Buffer): number => b.toString("utf8").split("\n").length - 1;
const commitmentHalf = (b: Uint8Array): Uint8Array => b.slice(0, COMMITMENT_BYTES);

/** fromBytes returns undefined at parse failure; reading it is an assertion. */
function parseCiphertext(bytes: Uint8Array): ElGamalCiphertext {
  const ciphertext = ElGamalCiphertext.fromBytes(bytes);
  assert.ok(ciphertext !== undefined, "the SDK did not parse these 64 bytes as an ElGamal ciphertext");
  return ciphertext;
}

test("vendor-arithmetic: the vendored file carries the pinned header verbatim over an unaltered upstream body, and the license copy is byte-identical", () => {
  const source = bytesOf(new URL("../src/vendor/confidentialTransferArithmetic.ts", import.meta.url));
  const header = Buffer.from(VENDOR_HEADER, "utf8");
  assert.deepEqual(source.subarray(0, header.length), header, "the vendored file does not begin with the pinned attribution header");
  const body = source.subarray(header.length);
  assert.equal(sha256(body), VENDORED_SHA256);
  assert.equal(lineCount(body), VENDORED_LINES);
  const license = bytesOf(new URL("../../LICENSE-Apache-2.0", import.meta.url));
  assert.equal(sha256(license), LICENSE_SHA256);
  assert.equal(lineCount(license), LICENSE_LINES);
});

test("vendor-arithmetic: subtractAmountFromCiphertext equals an SDK ciphertext of the reduced plaintext under the SAME opening", () => {
  const keypair = new ElGamalKeypair();
  const pubkey = keypair.pubkey();
  const opening = new PedersenOpening();
  const balance = 1_500_000n;
  const amount = 70_000n;
  const source = new Uint8Array(pubkey.encryptWith(balance, opening).toBytes());
  const actual = subtractAmountFromCiphertext(source, amount);
  // Removing a PUBLIC amount takes amount*G off the commitment and leaves the
  // handle untouched, so the whole ciphertext must equal an encryption of
  // balance - amount under the very same opening.
  const expected = new Uint8Array(pubkey.encryptWith(balance - amount, opening).toBytes());
  assert.equal(actual.length, CIPHERTEXT_BYTES);
  assert.deepEqual(actual, expected);
  assert.deepEqual(commitmentHalf(actual), commitmentHalf(expected));
  assert.equal(keypair.secret().decrypt(parseCiphertext(actual)), balance - amount);
});

test("vendor-arithmetic: subtractWithLoHiCiphertexts equals an SDK ciphertext built from a separately computed opening", () => {
  const keypair = new ElGamalKeypair();
  const pubkey = keypair.pubkey();
  const openingLeft = new PedersenOpening();
  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const available = 1_500_000n;
  const lo = 4_464n;
  const hi = 1n;
  const combined = lo + (hi << BIT_LENGTH);
  const left = new Uint8Array(pubkey.encryptWith(available, openingLeft).toBytes());
  const ctLo = new Uint8Array(pubkey.encryptWith(lo, openingLo).toBytes());
  const ctHi = new Uint8Array(pubkey.encryptWith(hi, openingHi).toBytes());
  const actual = subtractWithLoHiCiphertexts(left, ctLo, ctHi, BIT_LENGTH);
  const expectedOpening = openingLeft.subtract(openingLo).subtract(openingHi.multiplyByU64(SCALE));
  const expected = new Uint8Array(pubkey.encryptWith(available - combined, expectedOpening).toBytes());
  assert.deepEqual(actual, expected);
  assert.deepEqual(commitmentHalf(actual), commitmentHalf(expected));
  assert.equal(keypair.secret().decrypt(parseCiphertext(actual)), available - combined);
});

test("vendor-arithmetic: addWithLoHiCiphertexts equals an SDK ciphertext built from a separately computed opening", () => {
  const keypair = new ElGamalKeypair();
  const pubkey = keypair.pubkey();
  const openingLeft = new PedersenOpening();
  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const supply = 1_500_000n;
  const lo = 4_464n;
  const hi = 1n;
  const combined = lo + (hi << BIT_LENGTH);
  const left = new Uint8Array(pubkey.encryptWith(supply, openingLeft).toBytes());
  const ctLo = new Uint8Array(pubkey.encryptWith(lo, openingLo).toBytes());
  const ctHi = new Uint8Array(pubkey.encryptWith(hi, openingHi).toBytes());
  const actual = addWithLoHiCiphertexts(left, ctLo, ctHi, BIT_LENGTH);
  const expectedOpening = openingLeft.add(openingLo).add(openingHi.multiplyByU64(SCALE));
  const expected = new Uint8Array(pubkey.encryptWith(supply + combined, expectedOpening).toBytes());
  assert.deepEqual(actual, expected);
  assert.deepEqual(commitmentHalf(actual), commitmentHalf(expected));
  assert.equal(keypair.secret().decrypt(parseCiphertext(actual)), supply + combined);
});

test("vendor-arithmetic: extractCiphertextFromGroupedBytes agrees with the SDK's own grouped decrypt at every handle index", () => {
  const keypairs = [new ElGamalKeypair(), new ElGamalKeypair(), new ElGamalKeypair()];
  const pubkeys = keypairs.map((k) => k.pubkey());
  const amount = 70_000n;
  const grouped = GroupedElGamalCiphertext3Handles.encryptWith(
    pubkeys[0]!,
    pubkeys[1]!,
    pubkeys[2]!,
    amount,
    new PedersenOpening(),
  );
  const groupedBytes = new Uint8Array(grouped.toBytes());
  assert.equal(groupedBytes.length, COMMITMENT_BYTES + 3 * COMMITMENT_BYTES);
  for (let index = 0; index < 3; index += 1) {
    const extracted = extractCiphertextFromGroupedBytes(groupedBytes, index);
    assert.equal(extracted.length, CIPHERTEXT_BYTES);
    // The commitment half is shared by construction; the handle half is what
    // the index selects, and only the matching secret can read it.
    assert.deepEqual(commitmentHalf(extracted), groupedBytes.slice(0, COMMITMENT_BYTES));
    const viaVendored = keypairs[index]!.secret().decrypt(parseCiphertext(extracted));
    const viaSdk = grouped.decrypt(keypairs[index]!.secret(), index);
    assert.equal(viaVendored, amount);
    assert.equal(viaSdk, amount);
    assert.equal(viaVendored, viaSdk);
  }
});

test("vendor-arithmetic: a negative, non-integer or out-of-range handleIndex is refused by name", () => {
  const groupedBytes = new Uint8Array(COMMITMENT_BYTES + 3 * COMMITMENT_BYTES);
  for (const bad of [-1, -2]) {
    assert.throws(() => extractCiphertextFromGroupedBytes(groupedBytes, bad), /handleIndex must be a non-negative integer/);
  }
  assert.throws(() => extractCiphertextFromGroupedBytes(groupedBytes, 1.5), /handleIndex must be a non-negative integer/);
  assert.throws(() => extractCiphertextFromGroupedBytes(groupedBytes, 3), /does not contain handle 3/);
  // The positive control: index 2 is in range on the same buffer, so the three
  // refusals above are refusals and not a buffer that refuses everything.
  assert.equal(extractCiphertextFromGroupedBytes(groupedBytes, 2).length, CIPHERTEXT_BYTES);
});

// REGRESSION FOR A MACHINE MEASUREMENT, not for this build's own behavior,
// in the confidential-balance.test.ts style. Upstream does NOT
// short-circuit a zero amount and the unmodified copy keeps it that way, so
// subtractAmountFromCiphertext is NOT total over its documented domain: at
// zero, @noble/curves 1.9.7 refuses the scalar rather than returning the
// ciphertext unchanged. `unshield` must therefore refuse a zero amount at the
// shape stage, exactly as `shield` does; this test is what
// makes that contract visible instead of discovered.
test("vendor-arithmetic: a zero amount THROWS on the noble scalar rather than returning the ciphertext unchanged", () => {
  const pubkey = new ElGamalKeypair().pubkey();
  const source = new Uint8Array(pubkey.encryptWith(1_500_000n, new PedersenOpening()).toBytes());
  assert.throws(() => subtractAmountFromCiphertext(source, 0n), /invalid scalar/);
  // Paired positive: one base unit is accepted on the same ciphertext, so the
  // refusal above is about the zero and not about the input.
  assert.equal(subtractAmountFromCiphertext(source, 1n).length, CIPHERTEXT_BYTES);
});
