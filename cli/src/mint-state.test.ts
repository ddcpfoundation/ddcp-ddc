import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeMintState } from "./mint-state.js";

// Real devnet PDA-1 snapshot: the MintState of the reference mint
// 9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa, PDA-1
// GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B, captured 2026-09-29 with the
// genesis-settled ceilings of 100 bps and 1,000,000 base units.
const fixtureUrl = new URL(
  "../test-fixtures/pda1-mintstate-devnet.b64",
  import.meta.url,
);
const fixture = Uint8Array.from(
  Buffer.from(readFileSync(fixtureUrl, "utf8").trim(), "base64"),
);

test("decodeMintState decodes the devnet PDA-1 snapshot", () => {
  const state = decodeMintState(fixture);
  assert.equal(state.issuer, "3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
  assert.equal(state.operator, "CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
  assert.equal(state.reserve, "Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
  assert.equal(state.pauseActive, false);
  assert.equal(state.minimumFee, 0n);
  assert.equal(state.feeCeilingBasisPoints, 100);
  assert.equal(state.feeCeilingBaseUnits, 1_000_000n);
  assert.equal(state.bump, 255);
});

test("decodeMintState reads the fee ceilings at offsets 113 and 115", () => {
  const withCeilings = fixture.slice();
  const view = new DataView(withCeilings.buffer, withCeilings.byteOffset, withCeilings.byteLength);
  // A PDA-1 written before the ceilings existed carries zeros here.
  withCeilings.fill(0, 113, 123);
  const before = decodeMintState(withCeilings);
  assert.equal(before.feeCeilingBasisPoints, 0);
  assert.equal(before.feeCeilingBaseUnits, 0n);
  view.setUint16(113, 250, true);
  view.setBigUint64(115, 12_345n, true);
  const state = decodeMintState(withCeilings);
  assert.equal(state.feeCeilingBasisPoints, 250);
  assert.equal(state.feeCeilingBaseUnits, 12_345n);
  assert.equal(state.minimumFee, 0n);
  assert.equal(state.bump, 255);
});

test("decodeMintState throws on truncated data", () => {
  assert.throws(() => decodeMintState(fixture.subarray(0, 177)), /178 bytes/);
});

test("decodeMintState throws on a corrupted discriminator", () => {
  const corrupted = fixture.slice();
  corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
  assert.throws(() => decodeMintState(corrupted), /discriminator mismatch/);
});
