// Tests for the confidential-balance decrypt helpers, against REAL
// ciphertexts from the production /node entry — the SDK's own encrypt is the
// fixture generator, so nothing here restates a byte layout. Failure paths
// exercise the thrown-exception discipline converted to
// { readable: false } values, and the recombination pins the 16-bit split of
// the pending balance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/node";
import {
  decryptDecryptableBalance,
  decryptPendingBalance,
  encryptDecryptableBalance,
  DECRYPTABLE_BALANCE_BYTES,
  DECRYPTABLE_BALANCE_MODULUS,
  PENDING_BALANCE_LO_BIT_LENGTH,
} from "./confidential-balance.js";
import {
  addWithLoHiCiphertexts,
  subtractWithLoHiCiphertexts,
} from "./vendor/confidentialTransferArithmetic.js";

test("decryptDecryptableBalance: roundtrip, tampered bytes, and wrong key are the three surfaces", () => {
  const ae = new AeKey();
  const aeBytes = new Uint8Array(ae.toBytes());
  const good = new Uint8Array(ae.encrypt(1_500_000n).toBytes());
  assert.deepEqual(decryptDecryptableBalance(aeBytes, good), {
    readable: true,
    baseUnits: 1_500_000n,
  });
  const tampered = decryptDecryptableBalance(aeBytes, new Uint8Array(36).fill(7));
  assert.equal(tampered.readable, false);
  assert.ok(!tampered.readable && /AES decryption failed/.test(tampered.reason));
  const otherKey = new Uint8Array(new AeKey().toBytes());
  const wrongKey = decryptDecryptableBalance(otherKey, good);
  assert.equal(wrongKey.readable, false);
});

test("decryptPendingBalance: limbs recombine at the 16-bit split; all-zero limbs read as zero; a wrong key fails as a value", () => {
  assert.equal(PENDING_BALANCE_LO_BIT_LENGTH, 16n);
  const kp = new ElGamalKeypair();
  const secretBytes = new Uint8Array(kp.secret().toBytes());
  const pubkey = kp.pubkey();
  // pending total 70,000 splits as lo 4,464 and hi 1 (70,000 >> 16).
  const lo = new Uint8Array(pubkey.encryptU64(4_464n).toBytes());
  const hi = new Uint8Array(pubkey.encryptU64(1n).toBytes());
  assert.deepEqual(decryptPendingBalance(secretBytes, lo, hi), {
    readable: true,
    baseUnits: 70_000n,
  });
  // The fresh account's state: all-zero limbs decrypt to zero (a measurement,
  // now pinned in-suite).
  const zero = new Uint8Array(64);
  assert.deepEqual(decryptPendingBalance(secretBytes, zero, zero), {
    readable: true,
    baseUnits: 0n,
  });
  const otherSecret = new Uint8Array(new ElGamalKeypair().secret().toBytes());
  const wrongKey = decryptPendingBalance(otherSecret, lo, hi);
  assert.equal(wrongKey.readable, false);
  assert.ok(!wrongKey.readable && /ElGamal decryption failed/.test(wrongKey.reason));
});

// THE BORROW CASE, built exactly as the chain builds it. Token-2022 adds the
// transfer amount's limbs to the pending pair and then subtracts the fee's
// limbs, each from its own limb: for 100 DDC sent under 100 bps capped at 1
// DDC the gross 101,000,000 splits as lo 9,024 and hi 1,541, the fee
// 1,000,000 as lo 16,960 and hi 15, which leaves lo NEGATIVE at -7,936 and hi
// at 1,526. The ciphertexts are built with the vendored arithmetic, never by
// hand, so the fixture is the program's own composition.
test("decryptPendingBalance: a fee-bearing credit leaves the lo limb NEGATIVE and the pair still reads the net amount", () => {
  const kp = new ElGamalKeypair();
  const secretBytes = new Uint8Array(kp.secret().toBytes());
  const pubkey = kp.pubkey();
  const zero = new Uint8Array(64);
  const enc = (v: bigint) => new Uint8Array(pubkey.encryptU64(v).toBytes());
  const credit = (amount: bigint, fee: bigint) =>
    subtractWithLoHiCiphertexts(
      addWithLoHiCiphertexts(zero, enc(amount), zero, PENDING_BALANCE_LO_BIT_LENGTH),
      enc(fee),
      zero,
      PENDING_BALANCE_LO_BIT_LENGTH,
    );
  const lo = credit(9_024n, 16_960n);
  const hi = credit(1_541n, 15n);
  assert.deepEqual(decryptPendingBalance(secretBytes, lo, hi), {
    readable: true,
    baseUnits: 100_000_000n,
  });
  // A wrong key fails the straight read AND the negated one: the sign attempt
  // widens the readable range, never the set of keys that can read.
  const otherSecret = new Uint8Array(new ElGamalKeypair().secret().toBytes());
  assert.equal(decryptPendingBalance(otherSecret, lo, hi).readable, false);
  // A pair that recombines BELOW zero is refused by name, never displayed: no
  // sequence of credits and fees produces one, because a fee never exceeds the
  // amount it is taken from.
  const negative = decryptPendingBalance(secretBytes, credit(0n, 7_936n), zero);
  assert.equal(negative.readable, false);
  assert.ok(!negative.readable && /never negative/.test(negative.reason));
});

test("encryptDecryptableBalance: 36 bytes, roundtrips by VALUE, and refuses the silent-wrap range", () => {
  const ae = new AeKey();
  const aeBytes = new Uint8Array(ae.toBytes());
  for (const v of [0n, 1_500_000n, DECRYPTABLE_BALANCE_MODULUS - 1n]) {
    const ct = encryptDecryptableBalance(aeBytes, v);
    assert.equal(ct.length, DECRYPTABLE_BALANCE_BYTES);
    // Roundtrip by VALUE, never by byte: the write is randomized, so two
    // encryptions of one figure differ and only the plaintext is stable.
    assert.deepEqual(decryptDecryptableBalance(aeBytes, ct), {
      readable: true,
      baseUnits: v,
    });
  }
  // Two encryptions of one figure under one key differ — the property that
  // forces tx/apply-pending-tx.ts to take the ciphertext as an input.
  assert.notDeepEqual(
    encryptDecryptableBalance(aeBytes, 1_500_000n),
    encryptDecryptableBalance(aeBytes, 1_500_000n),
  );
  // The SDK wraps silently at the u64 boundary: 2^64 encrypts to 0 and 2^64+5
  // to 5, measured at the pinned SDK. Unguarded, that writes a wrong balance
  // copy that nothing on-chain rejects.
  for (const bad of [-1n, DECRYPTABLE_BALANCE_MODULUS, DECRYPTABLE_BALANCE_MODULUS + 5n]) {
    assert.throws(
      () => encryptDecryptableBalance(aeBytes, bad),
      /outside the u64 range/,
      `${bad} must be refused, not wrapped`,
    );
  }
});

// REGRESSION FOR A MACHINE MEASUREMENT, not for this build's own behavior.
// This file's header and confidential-balance.ts's header both state that the
// SDK's AES encrypt WRAPS silently at the u64 boundary, and the range guard's
// whole justification rests on that. Nothing asserted it: the suite pins only
// that OUR guard refuses. If upstream begins raising instead, the guard stays
// correct and its stated reason goes stale in silence — and this same file
// already pins the other machine measurement about this SDK, the
// non-determinism of the AES write, with a real assertion.
//
// DO NOT COPY THIS CALL SITE. The encrypt below deliberately bypasses
// encryptDecryptableBalance, which exists precisely to refuse these values. It
// is the only such bypass in this file; every balance-copy write in this build
// goes through the wrapper. Decryption still goes through the wrapper, so
// exactly one call site is exceptional.
//
// NO doesNotThrow WRAPPER IS NEEDED: the "raises no error" half of the claim is
// carried by the test completing at all — a throw fails it loudly and by name.
test("REGRESSION: the pinned zk-sdk AES encrypt wraps past 2^64 rather than refusing, which is the claim the range guard rests on", () => {
  // 2^64 written out rather than taken from DECRYPTABLE_BALANCE_MODULUS: a
  // check that reads its expectation from the constant under discussion passes
  // at any value of it. The equality PINS that constant instead of trusting it.
  const TWO_POW_64 = 18446744073709551616n;
  assert.equal(DECRYPTABLE_BALANCE_MODULUS, TWO_POW_64);

  const ae = new AeKey();
  const aeBytes = new Uint8Array(ae.toBytes());
  for (const [plaintext, wrapped] of [
    [TWO_POW_64, 0n],
    [TWO_POW_64 + 5n, 5n],
  ] as const) {
    // DO NOT COPY THIS CALL SITE.
    const ciphertext = new Uint8Array(ae.encrypt(plaintext).toBytes());
    assert.equal(ciphertext.length, DECRYPTABLE_BALANCE_BYTES);
    assert.deepEqual(decryptDecryptableBalance(aeBytes, ciphertext), {
      readable: true,
      baseUnits: wrapped,
    });
  }
});
