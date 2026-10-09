import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address } from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  buildResumeIssuanceInstruction,
  RESUME_ISSUANCE_DISCRIMINATOR,
} from "./resume-issuance.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");

function build() {
  return buildResumeIssuanceInstruction({
    mint: MINT,
    mintState: MINT_STATE,
    issuerAuthority: ISSUER,
    reserveAuthority: RESERVE,
  });
}

test("resume_issuance discriminator is computed and equals e10ad2de30200b92", () => {
  assert.equal(
    Buffer.from(RESUME_ISSUANCE_DISCRIMINATOR).toString("hex"),
    "e10ad2de30200b92",
  );
});

test("resume_issuance instruction data is exactly the 8 discriminator bytes (no params), on the program", () => {
  const ix = build();
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 8);
  assert.equal(Buffer.from(ix.data).toString("hex"), "e10ad2de30200b92");
});

test("resume_issuance accounts are the four I-5 accounts, in order, with correct roles", () => {
  const ix = build();
  assert.equal(ix.accounts.length, 4);
  const [a0, a1, a2, a3] = ix.accounts;
  if (
    a0 === undefined ||
    a1 === undefined ||
    a2 === undefined ||
    a3 === undefined
  ) {
    assert.fail("instruction must have all four accounts");
  }
  assert.equal(a0.address, MINT);
  assert.equal(a0.role, AccountRole.READONLY);
  assert.equal(a1.address, MINT_STATE);
  assert.equal(a1.role, AccountRole.WRITABLE);
  assert.equal(a2.address, ISSUER);
  assert.equal(a2.role, AccountRole.READONLY_SIGNER);
  assert.equal(a3.address, RESERVE);
  assert.equal(a3.role, AccountRole.READONLY_SIGNER);
});
