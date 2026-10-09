// The mint authority set `state` prints (mint-authorities.ts), pinned against
// the frozen reference mint fixture (test-fixtures/mint-devnet.b64, 638
// bytes, see mint-transfer-fee.test.ts for its capture) and against copies of
// it altered byte by byte. Expected values were decoded independently of this
// module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { address, getAddressEncoder } from "@solana/kit";
import { decodeMintAuthorities, extensionName, formatMintAuthorityLines } from "./mint-authorities.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const PDA1 = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const OTHER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
// The withheld-fee ElGamal public key of the reference mint, bytes 32 to 64 of
// the ConfidentialTransferFeeConfig value in the fixture, decoded separately.
const WITHHELD_FEE_KEY = "dvHT4Aldldboa/o8o0RZLCo09MLXx2UlOwPTZFcNCkM=";

function fixture(): Uint8Array {
  const b64 = readFileSync(new URL("../../test-fixtures/mint-devnet.b64", import.meta.url), "utf8").trim();
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** Offset of the value of the first TLV entry of `type` in the fixture. */
function valueOffset(bytes: Uint8Array, type: number): number {
  let o = 166;
  while (o + 4 <= bytes.length) {
    const t = bytes[o]! | (bytes[o + 1]! << 8);
    const l = bytes[o + 2]! | (bytes[o + 3]! << 8);
    if (t === type) return o + 4;
    o += 4 + l;
  }
  throw new Error(`no type ${type}`);
}

test("mint authorities: the reference mint fixture decodes to its genesis authority set", () => {
  const m = decodeMintAuthorities(fixture());
  assert.equal(m.mintAuthority, PDA1);
  assert.equal(m.freezeAuthority, null);
  assert.deepEqual(m.extensions, [4, 1, 16, 18, 19]);
  assert.deepEqual(m.confidentialTransfer, { authority: null, autoApprove: true, auditorKey: null });
  assert.equal(m.confidentialTransferFeeAuthority, address("8dUrmv8uu9aG1NZVt7AHNnAediUL26BjEfsZMeSovLwN"));
  assert.equal(m.withheldFeeKey, WITHHELD_FEE_KEY);
  assert.deepEqual(m.metadataPointer, {
    authority: address("AZvcdvxNyAjvYLaXFbUGv412vvUbWrq7vFux5AHPvBF3"),
    metadataAddress: MINT,
  });
  assert.deepEqual(m.tokenMetadata, {
    updateAuthority: address("8ejzuK8YjjDTLq6b1ZKf3kve1XvYmb1CYsbaF9wUvvqV"),
    name: "ddc", // rename-currency: keep (captured from the reference mint)
    symbol: "DDC", // rename-currency: keep (captured from the reference mint)
    uri: "",
  });
});

test("mint authorities: the state lines for the reference mint fixture", () => {
  const lines = formatMintAuthorityLines(decodeMintAuthorities(fixture()), { mint: MINT, mintStatePda: PDA1 });
  assert.deepEqual(lines, [
    "mintAuthority  : GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B (the program's PDA-1)",
    "freezeAuth     : none (no account can be frozen)",
    "extensions     : ConfidentialTransferMint, TransferFeeConfig, ConfidentialTransferFeeConfig, MetadataPointer, TokenMetadata (5)",
    "ctAuthority    : none (automatic approval and the auditor key below are permanent)",
    "ctAutoApprove  : true",
    "ctAuditorKey   : none",
    "ctFeeAuthority : 8dUrmv8uu9aG1NZVt7AHNnAediUL26BjEfsZMeSovLwN",
    `withheldFeeKey : ${WITHHELD_FEE_KEY} (ElGamal public key fixed at genesis; its secret decrypts the fee of each confidential transfer)`,
    "mdPointerAuth  : AZvcdvxNyAjvYLaXFbUGv412vvUbWrq7vFux5AHPvBF3 (metadata at 9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa, the mint itself)",
    "mdUpdateAuth   : 8ejzuK8YjjDTLq6b1ZKf3kve1XvYmb1CYsbaF9wUvvqV",
    'metadata       : name "ddc", symbol "DDC", uri ""', // rename-currency: keep (captured from the reference mint)
  ]);
});

test("mint authorities: a Freeze Authority, a Confidential Transfer authority and an auditor key are printed when present", () => {
  const bytes = fixture();
  const key = getAddressEncoder().encode(OTHER);
  bytes.set([1, 0, 0, 0], 46);
  bytes.set(key, 50);
  const ct = valueOffset(bytes, 4);
  bytes.set(key, ct);
  bytes[ct + 32] = 0;
  bytes.fill(7, ct + 33, ct + 65);
  const m = decodeMintAuthorities(bytes);
  assert.equal(m.freezeAuthority, OTHER);
  assert.deepEqual(m.confidentialTransfer, {
    authority: OTHER,
    autoApprove: false,
    auditorKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const lines = formatMintAuthorityLines(m, { mint: MINT, mintStatePda: PDA1 });
  assert.ok(lines.includes(`freezeAuth     : ${OTHER}`));
  assert.ok(lines.includes(`ctAuthority    : ${OTHER} (can change automatic approval and the auditor key below)`));
  assert.ok(lines.includes("ctAutoApprove  : false"));
});

test("mint authorities: the withheld-fee key line follows the key bytes, and a mint without the extension says so", () => {
  const bytes = fixture();
  const ctFee = valueOffset(bytes, 16);
  bytes.fill(9, ctFee + 32, ctFee + 64);
  const changed = decodeMintAuthorities(bytes);
  assert.equal(changed.withheldFeeKey, Buffer.alloc(32, 9).toString("base64"));
  assert.equal(changed.confidentialTransferFeeAuthority, address("8dUrmv8uu9aG1NZVt7AHNnAediUL26BjEfsZMeSovLwN"));
  const without = { ...decodeMintAuthorities(fixture()), withheldFeeKey: undefined };
  const lines = formatMintAuthorityLines(without, { mint: MINT, mintStatePda: PDA1 });
  assert.ok(lines.includes("withheldFeeKey : no ConfidentialTransferFeeConfig extension"));
});

test("mint authorities: a mint authority other than PDA-1 is marked as such", () => {
  const lines = formatMintAuthorityLines(decodeMintAuthorities(fixture()), { mint: MINT, mintStatePda: OTHER });
  assert.equal(lines[0], `mintAuthority  : ${PDA1} (NOT the program's PDA-1)`);
});

test("mint authorities: a TLV entry overrunning the account data throws by name", () => {
  const bytes = fixture().subarray(0, 600);
  assert.throws(() => decodeMintAuthorities(bytes), /overruns the account data/);
});

test("mint authorities: data shorter than the base mint throws by name", () => {
  assert.throws(() => decodeMintAuthorities(new Uint8Array(40)), /shorter than the 82-byte base mint/);
});

test("mint authorities: an unknown extension type is named by number", () => {
  assert.equal(extensionName(19), "TokenMetadata");
  assert.equal(extensionName(4000), "type 4000");
});
