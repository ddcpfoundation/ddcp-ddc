import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address } from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  buildPauseIssuanceInstruction,
  PAUSE_ISSUANCE_DISCRIMINATOR,
} from "./pause-issuance.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const AUTHORITY = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");

function build() {
  return buildPauseIssuanceInstruction({
    mint: MINT,
    mintState: MINT_STATE,
    authority: AUTHORITY,
  });
}

test("pause_issuance discriminator is computed, 8 bytes, and equals c70d81ec90b58a98", () => {
  assert.equal(PAUSE_ISSUANCE_DISCRIMINATOR.length, 8);
  assert.equal(
    Buffer.from(PAUSE_ISSUANCE_DISCRIMINATOR).toString("hex"),
    "c70d81ec90b58a98",
  );
});

test("pause_issuance instruction data is exactly the 8 discriminator bytes (no params), on the program", () => {
  const ix = build();
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 8);
  assert.equal(Buffer.from(ix.data).toString("hex"), "c70d81ec90b58a98");
  assert.deepEqual(ix.data, Uint8Array.from(PAUSE_ISSUANCE_DISCRIMINATOR));
});

test("pause_issuance accounts are the three I-4 accounts, in order, with correct roles", () => {
  const ix = build();
  assert.equal(ix.accounts.length, 3);
  const [a0, a1, a2] = ix.accounts;
  if (a0 === undefined || a1 === undefined || a2 === undefined) {
    assert.fail("instruction must have all three accounts");
  }
  assert.equal(a0.address, MINT);
  assert.equal(a0.role, AccountRole.READONLY);
  assert.equal(a1.address, MINT_STATE);
  assert.equal(a1.role, AccountRole.WRITABLE);
  assert.equal(a2.address, AUTHORITY);
  assert.equal(a2.role, AccountRole.READONLY_SIGNER);
});

const NON_AUTHORITY = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Documents the builder boundary: it is authority-AGNOSTIC by design. It places
// whatever address it is given at slot 2 without validating that the address is one
// of the three PDA-1 authorities. The any-1-of-3 safety is enforced at the command
// layer (role-guard against live PDA-1) and on-chain (Unauthorized 6001) — NOT here.
// Do not add authority validation to this pure builder.
test("builder is authority-agnostic: an arbitrary non-authority address builds and lands at slot 2", () => {
  const ix = buildPauseIssuanceInstruction({
    mint: MINT,
    mintState: MINT_STATE,
    authority: NON_AUTHORITY,
  });
  assert.equal(ix.accounts.length, 3);
  const a2 = ix.accounts[2];
  if (a2 === undefined) {
    assert.fail("instruction must have the authority account at slot 2");
  }
  assert.equal(a2.address, NON_AUTHORITY);
  assert.equal(a2.role, AccountRole.READONLY_SIGNER);
});
