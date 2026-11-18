// Client-side decryption of a token account's confidential figures — the
// reading layer `balance` displays and `shield`/`apply-pending` compute
// from. Byte-in, figure-out: key material arrives as the raw bytes
// deriveConfidentialKeys returns and is never logged; WASM handles are
// rebuilt here exactly as tx/confidential-setup-tx.ts does.
//
// FAILURE IS A VALUE, NOT AN EXCEPTION, AT THIS SURFACE. The SDK's decrypt
// calls THROW on tamper, wrong key or out-of-range plaintext (the documented
// `undefined` never happens), and `AeCiphertext.fromBytes`
// can return undefined at parse. Both are caught here and returned as a
// { readable: false } result naming the reason, because for `balance` an
// unreadable figure is a DISPLAY CASE with honest copy ("UNREADABLE", never
// zero, never guessed), not a crash.
//
// BOUNDS, from the pinned-source reads: the pending limbs are 16
// and 32 bits by construction, both inside the SDK's 2^32 decrypt wall, so a
// throw on a limb means tamper, a wrong key or a SIGN, not size — EXCEPT under
// accumulated credits: many deposits can push the hi limb's SUM past 2^32
// while each deposit stays legal. That case decrypts nowhere client-side and
// surfaces here as readable: false; the same honest copy covers it.
// PENDING_BALANCE_LO_BIT_LENGTH = 16 governs the recombination shift, and
// the LO limb is SIGNED: see decryptPendingBalance.
//
// ONE FUNCTION HERE WRITES RATHER THAN READS, AND IT THROWS. The failure-as-a-
// value discipline above is a DISPLAY rule: an unreadable figure has honest copy.
// `encryptDecryptableBalance` produces the bytes that BECOME the user's balance
// copy, and a wrong copy has no honest display — the command must stop before it
// sends. The guard it carries is not decoration: the SDK's AES encrypt does NOT
// range-check, and a value at or above 2^64 wraps SILENTLY (2^64 encrypts to 0,
// 2^64 + 5 to 5, measured at the pinned SDK). Nothing on-chain validates this
// copy either, so an unguarded wrap would be written, accepted, and displayed as
// the holder's balance with no signal anywhere.

import {
  AeCiphertext,
  AeKey,
  ElGamalCiphertext,
  ElGamalSecretKey,
} from "@solana/zk-sdk/node";
import {
  subtractAmountFromCiphertext,
  subtractWithLoHiCiphertexts,
} from "./vendor/confidentialTransferArithmetic.js";

/** A decrypted figure, or the named reason it could not be read. */
export type DecryptResult =
  | { readable: true; baseUnits: bigint }
  | { readable: false; reason: string };

/** The 16-bit split point of the pending balance (read at pinned source). */
export const PENDING_BALANCE_LO_BIT_LENGTH = 16n;

/**
 * Decrypt the 36-byte AES `decryptable_available_balance` copy — the ONLY
 * practical read path for the confidential figure, since the 64-bit ElGamal
 * copy sits beyond the client decrypt wall.
 */
export function decryptDecryptableBalance(
  aeKeyBytes: Uint8Array,
  ciphertextBytes: Uint8Array,
): DecryptResult {
  try {
    const ciphertext = AeCiphertext.fromBytes(ciphertextBytes);
    if (ciphertext === undefined) {
      return {
        readable: false,
        reason: "the decryptable balance bytes do not parse as an AES ciphertext",
      };
    }
    return {
      readable: true,
      baseUnits: AeKey.fromBytes(aeKeyBytes).decrypt(ciphertext),
    };
  } catch (err) {
    return {
      readable: false,
      reason: `AES decryption failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** The all-zero ciphertext: both points are the identity, so it holds zero under any key. */
const ZERO_CIPHERTEXT = new Uint8Array(64);

/**
 * Decrypt and recombine the two ElGamal pending limbs: lo (16-bit) plus hi
 * (32-bit) shifted by PENDING_BALANCE_LO_BIT_LENGTH.
 *
 * THE LO LIMB IS SIGNED, AND THE CHAIN MAKES IT SO. Token-2022 credits a
 * fee-bearing transfer by adding the transfer amount's limbs to the pending
 * pair and then subtracting the fee's limbs, each from its own limb and with
 * no borrow between them: a credit whose low 16 bits fall below the fee's
 * leaves the LO limb holding a NEGATIVE figure while the pair still sums to
 * the net amount. The program reads the pair only as one number (its apply
 * adds lo plus hi shifted by 16), so nothing on chain is wrong; a reader that
 * decrypts limbs separately is the only thing that can be. A negative limb
 * wraps past the decrypt wall, so it is read by decrypting its NEGATION,
 * which is small. The HI limb is never negative: a fee never exceeds the
 * amount it is taken from, so the fee's high half never exceeds the amount's.
 */
export function decryptPendingBalance(
  elgamalSecretKeyBytes: Uint8Array,
  pendingLoBytes: Uint8Array,
  pendingHiBytes: Uint8Array,
  pendingCreditCounter: bigint = 0n,
): DecryptResult {
  try {
    const secret = ElGamalSecretKey.fromBytes(elgamalSecretKeyBytes);
    const lo = decryptSignedLowLimb(secret, pendingLoBytes);
    const hi = decryptHighLimb(secret, pendingHiBytes, pendingCreditCounter);
    const baseUnits = lo + (hi << PENDING_BALANCE_LO_BIT_LENGTH);
    if (baseUnits < 0n) {
      return {
        readable: false,
        reason: "the pending limbs recombine to " + baseUnits + ", and a pending balance is never negative",
      };
    }
    return { readable: true, baseUnits };
  } catch (err) {
    return {
      readable: false,
      reason: `ElGamal decryption failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * The LO limb, signed. The straight read covers every non-negative figure; the
 * borrow case is read by negating the ciphertext through the vendored
 * arithmetic (zero minus the limb) and negating the figure. A limb that is
 * neither throws from the second read, so tamper, a wrong key and a figure
 * past the wall all stay unreadable, as they were.
 */
function decryptSignedLowLimb(secret: ElGamalSecretKey, bytes: Uint8Array): bigint {
  try {
    return decryptLimb(secret, bytes, "low");
  } catch {
    const negated = subtractWithLoHiCiphertexts(
      ZERO_CIPHERTEXT,
      bytes,
      ZERO_CIPHERTEXT,
      PENDING_BALANCE_LO_BIT_LENGTH,
    );
    return -decryptLimb(secret, negated, "negated low");
  }
}

/**
 * HIGH-LIMB WRAPS PAST THE DECRYPT WALL. The SDK's decrypt searches 32-bit
 * plaintexts. One credit adds less than 2^32 to the high limb (its amount is
 * under 2^48), but credits accumulate in the pending pair with no plaintext
 * bound, so N credits can leave a high limb up to N * 2^32. When the straight
 * read fails, the limb is read again with k * 2^32 removed, for k = 1, 2, ...:
 * the first k that decodes is the true one, because every smaller k leaves a
 * figure at or above 2^32. k never needs to reach the credit counter, and is
 * capped at HIGH_LIMB_WRAP_LIMIT, which already stands for more than
 * 18 billion whole units pending. A failure past that, a wrong key or tamper
 * stay unreadable, as before. Each attempt is one decrypt, about 0.2 s
 * (measured at the pinned SDK). (D-208 item 2.)
 */
export const HIGH_LIMB_WRAP_LIMIT = 64n;

function decryptHighLimb(secret: ElGamalSecretKey, bytes: Uint8Array, pendingCreditCounter: bigint): bigint {
  const limit = pendingCreditCounter < HIGH_LIMB_WRAP_LIMIT ? pendingCreditCounter : HIGH_LIMB_WRAP_LIMIT;
  return decryptWide(secret, bytes, "high", limit);
}

/**
 * A straight decrypt, then the same figure with k * 2^32 removed for
 * k = 1 .. limit - 1; the first k that decodes is the true one. Rethrows the
 * straight read's error when none does.
 */
function decryptWide(secret: ElGamalSecretKey, bytes: Uint8Array, label: string, limit: bigint): bigint {
  try {
    return decryptLimb(secret, bytes, label);
  } catch (first) {
    for (let k = 1n; k < limit; k += 1n) {
      const shifted = k << 32n;
      try {
        return shifted + decryptLimb(secret, new Uint8Array(subtractAmountFromCiphertext(bytes, shifted)), label);
      } catch {
        // a larger k is the next candidate
      }
    }
    throw first;
  }
}

/**
 * THE BALANCE COPY AGAINST THE BALANCE IT COPIES. The decryptable copy is
 * written by the holder's client and nothing on chain compares it with the
 * encrypted available balance. A credit that lands between a client's read
 * and the execution of its apply or shield is folded into the encrypted
 * balance and left out of the copy; so is the deposit of a second shield run
 * at the same time. A proof built on a short copy fails. The check removes the
 * copy's figure from the encrypted balance and reads what is left: zero is
 * consistent, a positive figure is the amount the copy is short by. A
 * difference past the wide decrypt, or a copy above the balance, is
 * unreadable. (D-208 item 1.)
 */
export type BalanceCopyCheck =
  | { kind: "consistent" }
  | { kind: "short"; missingBaseUnits: bigint }
  | { kind: "unreadable" };

export function checkBalanceCopy(
  elgamalSecretKeyBytes: Uint8Array,
  availableBalanceBytes: Uint8Array,
  copyBaseUnits: bigint,
): BalanceCopyCheck {
  try {
    const secret = ElGamalSecretKey.fromBytes(elgamalSecretKeyBytes);
    const difference =
      copyBaseUnits === 0n
        ? availableBalanceBytes
        : new Uint8Array(subtractAmountFromCiphertext(availableBalanceBytes, copyBaseUnits));
    const missing = decryptWide(secret, difference, "difference", HIGH_LIMB_WRAP_LIMIT);
    return missing === 0n ? { kind: "consistent" } : { kind: "short", missingBaseUnits: missing };
  } catch {
    return { kind: "unreadable" };
  }
}

function decryptLimb(
  secret: ElGamalSecretKey,
  bytes: Uint8Array,
  label: string,
): bigint {
  const ciphertext = ElGamalCiphertext.fromBytes(bytes);
  if (ciphertext === undefined) {
    throw new Error(`the ${label} pending limb does not parse as an ElGamal ciphertext`);
  }
  return secret.decrypt(ciphertext);
}

/**
 * The AES ciphertext width `ConfigureAccount` and `ApplyPendingBalance` both
 * reserve on the wire. Stated as the wire constant it is, not read back from
 * an encoder's declared size — the point is to catch an encoder whose size
 * changed, which asserting against that same size cannot do.
 */
export const DECRYPTABLE_BALANCE_BYTES = 36;

/** Exclusive upper bound of the AES plaintext domain: the u64 the wire carries. */
export const DECRYPTABLE_BALANCE_MODULUS = 1n << 64n;

/**
 * Encrypt a base-unit figure into the 36-byte AES `decryptable_available_balance`
 * copy. NOT deterministic — the same figure under the same key yields different
 * bytes every call (measured on the build machine), so a caller
 * verifying a written copy must decrypt and compare the VALUE, never re-encrypt
 * and compare bytes.
 *
 * Throws rather than returning a value; see the header. The range guard is the
 * reason this function exists as a wrapper at all.
 */
export function encryptDecryptableBalance(
  aeKeyBytes: Uint8Array,
  baseUnits: bigint,
): Uint8Array {
  if (baseUnits < 0n || baseUnits >= DECRYPTABLE_BALANCE_MODULUS) {
    throw new Error(
      `refusing to encrypt ${baseUnits} base units: outside the u64 range this balance copy carries, and the encoder would wrap it silently`,
    );
  }
  const ciphertext = new Uint8Array(
    AeKey.fromBytes(aeKeyBytes).encrypt(baseUnits).toBytes(),
  );
  if (ciphertext.length !== DECRYPTABLE_BALANCE_BYTES) {
    throw new Error(
      `the AES ciphertext is ${ciphertext.length} bytes, not the ${DECRYPTABLE_BALANCE_BYTES} this instruction reserves`,
    );
  }
  return ciphertext;
}
