import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AccountRole, address, getU64Decoder } from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  MINT_TOKENS_DISCRIMINATOR,
  buildMintTokensInstruction,
} from "./mint-tokens.js";

// Six distinct real devnet addresses, so the account-order assertions cannot
// pass by coincidence.
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function build(amount: bigint) {
  return buildMintTokensInstruction({
    mint: MINT,
    destination: DESTINATION,
    mintState: MINT_STATE,
    issuerAuthority: ISSUER,
    reserveAuthority: RESERVE,
    token2022Program: TOKEN_2022,
    amount,
  });
}

test("mint_tokens discriminator is computed and equals 3b8418f67a2708f3", () => {
  const independent = createHash("sha256")
    .update("global:mint_tokens")
    .digest()
    .subarray(0, 8);
  assert.equal(
    Buffer.from(MINT_TOKENS_DISCRIMINATOR).toString("hex"),
    "3b8418f67a2708f3",
  );
  assert.deepEqual(Buffer.from(MINT_TOKENS_DISCRIMINATOR), independent);
});

test("mint_tokens instruction data is discriminator ++ u64 LE amount, 16 bytes, on the program", () => {
  const ix = build(1_000_000n);
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 16);
  assert.equal(
    Buffer.from(ix.data.subarray(0, 8)).toString("hex"),
    "3b8418f67a2708f3",
  );
  assert.equal(getU64Decoder().decode(ix.data.subarray(8, 16)), 1_000_000n);
});

test("mint_tokens accounts are the six I-2 accounts, in order, with correct roles", () => {
  const ix = build(1n);
  assert.equal(ix.accounts.length, 6);
  assert.deepEqual(
    ix.accounts.map((a) => [a.address, a.role]),
    [
      [MINT, AccountRole.WRITABLE],
      [DESTINATION, AccountRole.WRITABLE],
      [MINT_STATE, AccountRole.READONLY],
      [ISSUER, AccountRole.READONLY_SIGNER],
      [RESERVE, AccountRole.READONLY_SIGNER],
      [TOKEN_2022, AccountRole.READONLY],
    ],
  );
});
