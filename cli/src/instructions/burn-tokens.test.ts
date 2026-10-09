import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address } from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  buildBurnTokensInstruction,
  BURN_TOKENS_DISCRIMINATOR,
} from "./burn-tokens.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const SOURCE = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const PDA5 = address("EcwNe3hodPbgUr4GVZn6Rp547c7vbdxSx6jw9aQfDfXU");
const ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function build(amount: bigint = 250_000n) {
  return buildBurnTokensInstruction({
    mint: MINT,
    source: SOURCE,
    mintState: MINT_STATE,
    redemptionAuthority: PDA5,
    issuerAuthority: ISSUER,
    reserveAuthority: RESERVE,
    token2022Program: TOKEN_2022,
    amount,
  });
}

test("burn_tokens discriminator is computed and equals 4c0f33fee5d77942", () => {
  assert.equal(
    Buffer.from(BURN_TOKENS_DISCRIMINATOR).toString("hex"),
    "4c0f33fee5d77942",
  );
});

test("burn_tokens instruction data is discriminator ++ u64 LE amount, 16 bytes, on the program", () => {
  const ix = build(250_000n);
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 16);
  assert.equal(
    Buffer.from(ix.data.subarray(0, 8)).toString("hex"),
    "4c0f33fee5d77942",
  );
  // 250_000 = 0x03d090, u64 LE
  assert.equal(
    Buffer.from(ix.data.subarray(8, 16)).toString("hex"),
    "90d0030000000000",
  );
});

test("burn_tokens accounts are the seven I-3 accounts, in order, with correct roles", () => {
  const ix = build();
  assert.equal(ix.accounts.length, 7);
  const [a0, a1, a2, a3, a4, a5, a6] = ix.accounts;
  if (
    a0 === undefined ||
    a1 === undefined ||
    a2 === undefined ||
    a3 === undefined ||
    a4 === undefined ||
    a5 === undefined ||
    a6 === undefined
  ) {
    assert.fail("instruction must have all seven accounts");
  }
  assert.equal(a0.address, MINT);
  assert.equal(a0.role, AccountRole.WRITABLE);
  assert.equal(a1.address, SOURCE);
  assert.equal(a1.role, AccountRole.WRITABLE);
  assert.equal(a2.address, MINT_STATE);
  assert.equal(a2.role, AccountRole.READONLY);
  // PDA-5 CPI-signs on-chain via invoke_signed — READONLY here, never a
  // transaction-level signer.
  assert.equal(a3.address, PDA5);
  assert.equal(a3.role, AccountRole.READONLY);
  assert.equal(a4.address, ISSUER);
  assert.equal(a4.role, AccountRole.READONLY_SIGNER);
  assert.equal(a5.address, RESERVE);
  assert.equal(a5.role, AccountRole.READONLY_SIGNER);
  assert.equal(a6.address, TOKEN_2022);
  assert.equal(a6.role, AccountRole.READONLY);
});
