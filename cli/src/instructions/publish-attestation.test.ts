import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address, getU64Encoder, getU32Encoder } from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  buildPublishAttestationInstruction,
  PUBLISH_ATTESTATION_DISCRIMINATOR,
  MAX_ATTESTATION_URI_BYTES,
} from "./publish-attestation.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const ATTESTATION = address("7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");

function build(amount: bigint, uri: string) {
  return buildPublishAttestationInstruction({
    mint: MINT,
    attestation: ATTESTATION,
    mintState: MINT_STATE,
    reserveAuthority: RESERVE,
    amount,
    uri,
  });
}

test("publish_attestation discriminator is computed, 8 bytes, and equals 7726782d56169137", () => {
  assert.equal(PUBLISH_ATTESTATION_DISCRIMINATOR.length, 8);
  assert.equal(
    Buffer.from(PUBLISH_ATTESTATION_DISCRIMINATOR).toString("hex"),
    "7726782d56169137",
  );
});

test("publish_attestation data layout: disc(8) ++ amount u64 LE(8) ++ uri len u32 LE(4) ++ uri bytes(N) = 20 + N", () => {
  const uri = "https://example.org/attestation/devnet-m2cli-smoke.json";
  const uriBytes = new TextEncoder().encode(uri);
  const amount = 601000000n;
  const ix = build(amount, uri);
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 20 + uriBytes.length);
  assert.equal(Buffer.from(ix.data.subarray(0, 8)).toString("hex"), "7726782d56169137");
  assert.deepEqual(ix.data.subarray(8, 16), getU64Encoder().encode(amount));
  assert.deepEqual(ix.data.subarray(16, 20), getU32Encoder().encode(uriBytes.length));
  assert.deepEqual(ix.data.subarray(20), uriBytes);
});

test("publish_attestation accounts are the four I-7 accounts, in order, with correct roles (PDA-2 writable, PDA-1 readonly)", () => {
  const ix = build(1n, "u");
  assert.equal(ix.accounts.length, 4);
  const [a0, a1, a2, a3] = ix.accounts;
  if (a0 === undefined || a1 === undefined || a2 === undefined || a3 === undefined) {
    assert.fail("instruction must have all four accounts");
  }
  assert.equal(a0.address, MINT);
  assert.equal(a0.role, AccountRole.READONLY);
  assert.equal(a1.address, ATTESTATION);
  assert.equal(a1.role, AccountRole.WRITABLE);
  assert.equal(a2.address, MINT_STATE);
  assert.equal(a2.role, AccountRole.READONLY);
  assert.equal(a3.address, RESERVE);
  assert.equal(a3.role, AccountRole.READONLY_SIGNER);
});

test("publish_attestation empty uri builds (len 0 is legal, only > 128 is rejected)", () => {
  const ix = build(0n, "");
  assert.equal(ix.data.length, 20);
  assert.deepEqual(ix.data.subarray(16, 20), getU32Encoder().encode(0));
});

test("publish_attestation URI at exactly 128 bytes builds; data is 148 bytes", () => {
  const ix = build(0n, "x".repeat(128));
  assert.equal(ix.data.length, 148);
});

test("publish_attestation guards on UTF-8 BYTE length, not char length: a 65-char multi-byte URI over 128 bytes is rejected", () => {
  // '\u00F1' (n-tilde) is 2 UTF-8 bytes. 65 of them = 130 bytes from 65 chars —
  // over the 128 BYTE bound though only 65 characters. Proves the guard is
  // byte-based, not char-based.
  const uri = "\u00F1".repeat(65);
  assert.equal(new TextEncoder().encode(uri).length, 130);
  assert.ok(uri.length < MAX_ATTESTATION_URI_BYTES, "char length is under 128");
  assert.throws(
    () => build(0n, uri),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("130"), "message names the byte length");
      assert.ok(err.message.includes("InvalidAttestationUri"), "message names the on-chain error");
      return true;
    },
  );
});
