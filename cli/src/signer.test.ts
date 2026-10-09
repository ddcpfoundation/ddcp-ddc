import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressDecoder } from "@solana/kit";
import { loadSignerFromFile } from "./signer.js";

// Hermetic THROWAWAY keypair, generated fresh per test run — no committed
// secret key material anywhere. Standard DER slicing: the last 32 bytes of a
// pkcs8 ed25519 export are the private seed; the last 32 bytes of an spki
// export are the raw public key.
function throwawayKeypair(): { bytes: number[]; expectedAddress: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    bytes: [...seed, ...pub],
    expectedAddress: getAddressDecoder().decode(Uint8Array.from(pub)),
  };
}

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-signer-test-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("round-trip: a written 64-byte keypair file loads and yields its own address", () =>
  withTempDir(async (dir) => {
    const { bytes, expectedAddress } = throwawayKeypair();
    const path = join(dir, "throwaway.json");
    writeFileSync(path, JSON.stringify(bytes));
    const signer = await loadSignerFromFile(path);
    assert.equal(signer.address, expectedAddress);
  }));

test("missing file is rejected with an error naming the path", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "no-such-file.json");
    await assert.rejects(
      loadSignerFromFile(path),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(path) &&
        /missing or not readable/.test(err.message),
    );
  }));

test("malformed JSON is rejected with an error naming the path", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "malformed.json");
    writeFileSync(path, "[64, 12, not json");
    await assert.rejects(
      loadSignerFromFile(path),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(path) &&
        /not valid JSON/.test(err.message),
    );
  }));

test("arrays of the wrong length (32 and 65) are rejected", () =>
  withTempDir(async (dir) => {
    const { bytes } = throwawayKeypair();
    const isLengthError = (path: string) => (err: unknown) =>
      err instanceof Error &&
      err.message.includes(path) &&
      /exactly 64 bytes/.test(err.message);

    const short = join(dir, "short.json");
    writeFileSync(short, JSON.stringify(bytes.slice(0, 32)));
    await assert.rejects(loadSignerFromFile(short), isLengthError(short));

    const long = join(dir, "long.json");
    writeFileSync(long, JSON.stringify([...bytes, 0]));
    await assert.rejects(loadSignerFromFile(long), isLengthError(long));
  }));

test("elements outside 0..255 (or non-integers) are rejected", () =>
  withTempDir(async (dir) => {
    const isByteError = (path: string) => (err: unknown) =>
      err instanceof Error &&
      err.message.includes(path) &&
      /integer in 0\.\.255/.test(err.message);

    const over = join(dir, "over.json");
    const overBytes = throwawayKeypair().bytes;
    overBytes[10] = 256;
    writeFileSync(over, JSON.stringify(overBytes));
    await assert.rejects(loadSignerFromFile(over), isByteError(over));

    const frac = join(dir, "frac.json");
    const fracBytes = throwawayKeypair().bytes;
    fracBytes[10] = 3.5;
    writeFileSync(frac, JSON.stringify(fracBytes));
    await assert.rejects(loadSignerFromFile(frac), isByteError(frac));
  }));

// Security pin. Confirmed against the installed kit 7.0.0 sources
// (@solana/keys createKeyPairFromBytes): kit does NOT trust the stored public
// half — it sign/verify-probes it against the private half and throws on
// mismatch. So the applicable variant of this pin is: a file with a
// mismatched public half is REFUSED (never loaded under the tampered
// address).
test("security: a keypair file whose public half does not match its private half is refused", () =>
  withTempDir(async (dir) => {
    const { bytes } = throwawayKeypair();
    const tampered = [...bytes];
    // Flip one byte inside the PUBLIC half (indexes 32..63).
    tampered[40] = (tampered[40] ?? 0) ^ 0xff;
    const path = join(dir, "tampered.json");
    writeFileSync(path, JSON.stringify(tampered));
    await assert.rejects(
      loadSignerFromFile(path),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(path) &&
        /failed key validation/.test(err.message),
    );
  }));

// Tripwire: non-extractability is asserted BEHAVIORALLY. We reach the loaded
// private CryptoKey directly and prove WebCrypto refuses to export it. This
// fails if someone flips the explicit `false` in signer.ts, if a refactor
// changes the load path, or if a kit bump makes the explicit argument inert.
// It deliberately tests EXPORT BEHAVIOR, not an `.extractable` attribute, so
// a kit-internal rename cannot make it pass vacuously — and the reachability
// guard makes an unreachable/renamed key path FAIL RED here, never pass
// vacuously via a spurious rejection (e.g. a TypeError on undefined).
test("security: the loaded private key is non-extractable (export attempt is refused)", () =>
  withTempDir(async (dir) => {
    const { bytes } = throwawayKeypair();
    const path = join(dir, "throwaway.json");
    writeFileSync(path, JSON.stringify(bytes));
    const signer = await loadSignerFromFile(path);
    const privateKey: CryptoKey = signer.keyPair.privateKey;
    assert.ok(
      privateKey instanceof CryptoKey,
      "loaded signer must expose a real private CryptoKey — if this fails the key path broke",
    );
    // Reason check, matched against the OBSERVED rejection on this runtime
    // (Node 24.10.0): DOMException name "InvalidAccessException", message
    // "key is not extractable" — any other rejection fails the test.
    await assert.rejects(
      () => crypto.subtle.exportKey("pkcs8", privateKey),
      (err: unknown) =>
        err instanceof Error &&
        (err.name === "InvalidAccessException" ||
          /extractable/i.test(err.message)),
    );
  }));
