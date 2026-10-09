import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeMintTransferFee,
  decodeMintTransferFeeConfig,
} from "./mint-transfer-fee.js";

// Frozen devnet fixture (test-fixtures/mint-devnet.b64): the reference mint
// 9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa, 638 bytes, captured
// 2026-09-29 at finalized commitment (context slot 505,664,632), before any
// holder account or supply existed. Both fee schedules are the genesis
// schedule: epoch 1170, 0 bps, 0 maximum. The pin is against the FIXTURE,
// not the live cluster; a later fee change moves the cluster, never this
// file. Non-zero and differing schedule values are covered by the synthetic
// mint further down.
test("decodeMintTransferFee decodes the frozen reference mint fixture: 0 bps, maximum 0", () => {
  const b64 = readFileSync(
    new URL("../../test-fixtures/mint-devnet.b64", import.meta.url),
    "utf8",
  ).trim();
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  assert.equal(bytes.length, 638);
  const fee = decodeMintTransferFee(bytes);
  assert.equal(fee.basisPoints, 0);
  assert.equal(fee.maximumFee, 0n);
});

test("decodeMintTransferFee throws on data too short for a Token-2022 extensions mint", () => {
  assert.throws(
    () => decodeMintTransferFee(new Uint8Array(100)),
    /must extend past the account-type byte at 165/,
  );
});

test("decodeMintTransferFee throws when no TransferFeeConfig TLV entry exists", () => {
  // 170 zero bytes: valid length, TLV starts with type 0 (uninitialized).
  assert.throws(
    () => decodeMintTransferFee(new Uint8Array(170)),
    /no TransferFeeConfig extension \(TLV type 1\)/,
  );
});

// The same fixture, all six schedule fields. No fee change has ever been
// made on this mint, so the older and newer schedules are both the genesis
// schedule (epoch 1170, 0 bps, 0 max) and carry the same parameters. On a
// mint whose last fee change differs from its predecessor they would not:
// that records that a change once happened, not that one is pending.
function loadFixture(): Uint8Array {
  const b64 = readFileSync(
    new URL("../../test-fixtures/mint-devnet.b64", import.meta.url),
    "utf8",
  ).trim();
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  assert.equal(bytes.length, 638);
  return bytes;
}

test("decodeMintTransferFeeConfig reads both schedules and epochs off the frozen reference mint fixture", () => {
  const config = decodeMintTransferFeeConfig(loadFixture());
  assert.deepEqual(config, {
    older: { epoch: 1170n, maximumFee: 0n, basisPoints: 0 },
    newer: { epoch: 1170n, maximumFee: 0n, basisPoints: 0 },
  });
});

test("decodeMintTransferFee and decodeMintTransferFeeConfig agree on the newer schedule", () => {
  const bytes = loadFixture();
  const fee = decodeMintTransferFee(bytes);
  const config = decodeMintTransferFeeConfig(bytes);
  assert.equal(fee.basisPoints, config.newer.basisPoints);
  assert.equal(fee.maximumFee, config.newer.maximumFee);
});

// A synthetic Token-2022 mint: 166 bytes of base and account type, then a
// 32-byte type-3 (MintCloseAuthority) entry the walk must skip, then the
// 108-byte type-1 value with a distinct known value in every field.
function syntheticMint(configLen: number): Uint8Array {
  const bytes = new Uint8Array(166 + 4 + 32 + 4 + configLen);
  const view = new DataView(bytes.buffer);
  bytes[165] = 1;
  view.setUint16(166, 3, true);
  view.setUint16(168, 32, true);
  bytes.fill(0xaa, 170, 202);
  view.setUint16(202, 1, true);
  view.setUint16(204, configLen, true);
  const value = 206;
  bytes.fill(0xbb, value, value + 32);
  bytes.fill(0xcc, value + 32, value + 64);
  if (configLen >= 108) {
    view.setBigUint64(value + 64, 555_555n, true);
    view.setBigUint64(value + 72, 7n, true);
    view.setBigUint64(value + 80, 12_345n, true);
    view.setUint16(value + 88, 250, true);
    view.setBigUint64(value + 90, 9n, true);
    view.setBigUint64(value + 98, 67_890n, true);
    view.setUint16(value + 106, 375, true);
  }
  return bytes;
}

test("decodeMintTransferFeeConfig reads six known fields past a foreign TLV entry", () => {
  const bytes = syntheticMint(108);
  assert.equal(bytes.length, 314);
  assert.deepEqual(decodeMintTransferFeeConfig(bytes), {
    older: { epoch: 7n, maximumFee: 12_345n, basisPoints: 250 },
    newer: { epoch: 9n, maximumFee: 67_890n, basisPoints: 375 },
  });
  assert.deepEqual(decodeMintTransferFee(bytes), {
    basisPoints: 375,
    maximumFee: 67_890n,
  });
});

test("decodeMintTransferFeeConfig refuses a 107-byte TransferFeeConfig value by name", () => {
  assert.throws(
    () => decodeMintTransferFeeConfig(syntheticMint(107)),
    /TransferFeeConfig value must be exactly 108 bytes, got 107/,
  );
});

test("decodeMintTransferFeeConfig throws when no TransferFeeConfig TLV entry exists", () => {
  assert.throws(
    () => decodeMintTransferFeeConfig(new Uint8Array(170)),
    /no TransferFeeConfig extension \(TLV type 1\)/,
  );
});
