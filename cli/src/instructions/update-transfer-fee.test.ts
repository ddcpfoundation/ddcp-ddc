import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  getU16Decoder,
  getU64Decoder,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  buildUpdateTransferFeeInstruction,
  UPDATE_TRANSFER_FEE_DISCRIMINATOR,
} from "./update-transfer-fee.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const PDA3 = address("48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function build(
  newFeeBasisPoints = 250,
  newMaximumFee = 5_000_000n,
  newMinimumFee = 1_000n,
) {
  return buildUpdateTransferFeeInstruction({
    mint: MINT,
    feeAuthority: PDA3,
    mintState: MINT_STATE,
    issuerAuthority: ISSUER,
    operatorAuthority: OPERATOR,
    token2022Program: TOKEN_2022,
    newFeeBasisPoints,
    newMaximumFee,
    newMinimumFee,
  });
}

test("update_transfer_fee discriminator is computed and equals 876a394d5df7d29e", () => {
  assert.equal(
    Buffer.from(UPDATE_TRANSFER_FEE_DISCRIMINATOR).toString("hex"),
    "876a394d5df7d29e",
  );
});

test("update_transfer_fee instruction data is disc ++ u16 LE bps ++ u64 LE max ++ u64 LE min, 26 bytes, on the program", () => {
  const ix = build(250, 5_000_000n, 1_000n);
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 26);
  assert.equal(
    Buffer.from(ix.data.subarray(0, 8)).toString("hex"),
    "876a394d5df7d29e",
  );
  // 250 = 0x00fa, u16 LE
  assert.equal(Buffer.from(ix.data.subarray(8, 10)).toString("hex"), "fa00");
  // 5_000_000 = 0x4c4b40, u64 LE
  assert.equal(
    Buffer.from(ix.data.subarray(10, 18)).toString("hex"),
    "404b4c0000000000",
  );
  // 1_000 = 0x03e8, u64 LE
  assert.equal(
    Buffer.from(ix.data.subarray(18, 26)).toString("hex"),
    "e803000000000000",
  );
});

test("update_transfer_fee data round-trips: bps@8, max@10, min@18 decode back to the inputs", () => {
  const ix = build(9_999, 123_456_789n, 42n);
  assert.equal(getU16Decoder().decode(ix.data.subarray(8, 10)), 9_999);
  assert.equal(getU64Decoder().decode(ix.data.subarray(10, 18)), 123_456_789n);
  assert.equal(getU64Decoder().decode(ix.data.subarray(18, 26)), 42n);
});

test("update_transfer_fee accounts are the six I-6 accounts, in order, with correct roles", () => {
  const ix = build();
  assert.equal(ix.accounts.length, 6);
  const [a0, a1, a2, a3, a4, a5] = ix.accounts;
  if (
    a0 === undefined ||
    a1 === undefined ||
    a2 === undefined ||
    a3 === undefined ||
    a4 === undefined ||
    a5 === undefined
  ) {
    assert.fail("instruction must have all six accounts");
  }
  assert.equal(a0.address, MINT);
  assert.equal(a0.role, AccountRole.WRITABLE);
  // PDA-3 CPI-signs SetTransferFee on-chain via invoke_signed — READONLY
  // here, never a transaction-level signer.
  assert.equal(a1.address, PDA3);
  assert.equal(a1.role, AccountRole.READONLY);
  // PDA-1 is WRITABLE in I-6: minimum_fee is written directly.
  assert.equal(a2.address, MINT_STATE);
  assert.equal(a2.role, AccountRole.WRITABLE);
  assert.equal(a3.address, ISSUER);
  assert.equal(a3.role, AccountRole.READONLY_SIGNER);
  assert.equal(a4.address, OPERATOR);
  assert.equal(a4.role, AccountRole.READONLY_SIGNER);
  assert.equal(a5.address, TOKEN_2022);
  assert.equal(a5.role, AccountRole.READONLY);
});
