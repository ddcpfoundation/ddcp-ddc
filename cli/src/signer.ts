// Keypair-file loading for admin signing. Loads the
// standard Solana CLI JSON keypair form (array of 64 bytes: 32 private ||
// 32 public) into a kit KeyPairSigner. No config plumbing here; the command
// layer decides WHICH file to load.

import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

/**
 * Load a Solana CLI JSON keypair file and return a kit `KeyPairSigner`.
 *
 * SECURITY — the returned `.address` always reflects the ACTUAL private key:
 * kit's `createKeyPairSignerFromBytes` (via `@solana/keys`
 * `createKeyPairFromBytes`, verified in the installed 7.0.0 sources) does not
 * trust the stored public half — it signs a random probe with the private
 * half and verifies with the public half, throwing on mismatch. A file whose
 * public bytes don't match its private bytes is therefore REFUSED here, not
 * loaded under a wrong address. No separate check is needed in this module.
 *
 * NON-EXTRACTABLE: the private key is imported with `extractable: false`
 * stated explicitly at the call site — not inherited from kit's default —
 * so a future kit default change cannot silently alter the posture.
 * WebCrypto refuses to export the private key after load (behavioral
 * tripwire in signer.test.ts).
 *
 * Error messages name the path and the structural problem ONLY — never any
 * key material.
 */
export async function loadSignerFromFile(
  path: string,
): Promise<KeyPairSigner> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`keypair file missing or not readable: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`keypair file is not valid JSON: ${path}`);
  }

  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(
      `keypair file must be a JSON array of exactly 64 bytes: ${path}`,
    );
  }
  if (
    !parsed.every(
      (b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255,
    )
  ) {
    throw new Error(
      `keypair file contains a non-byte element (every element must be an integer in 0..255): ${path}`,
    );
  }

  try {
    // `false` stated explicitly: non-extractable, regardless of kit's
    // default (see doc comment above).
    return await createKeyPairSignerFromBytes(new Uint8Array(parsed), false);
  } catch {
    // Deliberately NOT passing the underlying error through: the message
    // stays path + structural problem only, with zero key material.
    throw new Error(
      `keypair file failed key validation (stored public half does not match the private half, or the key is unusable): ${path}`,
    );
  }
}
