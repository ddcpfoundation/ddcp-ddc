import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getAddressDecoder,
  getU8Decoder,
  type Address,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import {
  buildRotateSignerInstruction,
  ROTATE_SIGNER_DISCRIMINATOR,
} from "./rotate-signer.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
// Rotation target — a real, distinct devnet address (the payer), used only
// as the new_pubkey value; never a role signer here.
const NEW_SIGNER = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
// The default/all-zeros pubkey ("1" x 32 base58 -> 32 zero bytes). Used ONLY
// to pin new_pubkey placement with a known, encoder-independent hex anchor.
// The builder has no !=default guard by design (that bound is on-chain
// InvalidPubkey 6004 + the --confirm-new-signer gate); this offline builder
// test deliberately exercises it to get the zero-byte anchor.
const ZERO_PUBKEY = address("11111111111111111111111111111111");

function build(role = 1, newPubkey: Address = NEW_SIGNER) {
  return buildRotateSignerInstruction({
    mint: MINT,
    mintState: MINT_STATE,
    operatorAuthority: OPERATOR,
    reserveAuthority: RESERVE,
    role,
    newPubkey,
  });
}

test("rotate_signer discriminator is computed and equals c687351b15cb0800", () => {
  assert.equal(
    Buffer.from(ROTATE_SIGNER_DISCRIMINATOR).toString("hex"),
    "c687351b15cb0800",
  );
});

test("rotate_signer instruction data is disc ++ role u8 ++ new_pubkey 32B, 41 bytes, on the program", () => {
  const ix = build(2, NEW_SIGNER);
  assert.equal(ix.programAddress, PROGRAM_ID);
  assert.equal(ix.data.length, 41);
  assert.equal(
    Buffer.from(ix.data.subarray(0, 8)).toString("hex"),
    "c687351b15cb0800",
  );
  // role = 2, u8 @ byte 8
  assert.equal(Buffer.from(ix.data.subarray(8, 9)).toString("hex"), "02");
  // new_pubkey occupies bytes 9..41 (placement / no-clobber). This reuses the
  // encoder; the zero-pubkey anchor test below is the encoder-independent pin.
  assert.equal(ix.data.subarray(9, 41).length, 32);
  assert.equal(
    Buffer.from(ix.data.subarray(9, 41)).toString("hex"),
    Buffer.from(getAddressEncoder().encode(NEW_SIGNER)).toString("hex"),
  );
});

test("rotate_signer new_pubkey lands at byte 9 as raw 32 bytes — zero-pubkey hex anchor (encoder-independent)", () => {
  const ix = build(0, ZERO_PUBKEY);
  // role = 0
  assert.equal(Buffer.from(ix.data.subarray(8, 9)).toString("hex"), "00");
  // "1" x 32 base58 decodes to 32 zero bytes — a fixed hex anchor that does
  // not reuse getAddressEncoder, independently pinning offset 9 and length 32.
  assert.equal(
    Buffer.from(ix.data.subarray(9, 41)).toString("hex"),
    "00".repeat(32),
  );
  assert.equal(ix.data.length, 41);
});

test("rotate_signer data round-trips: role@8, new_pubkey@9 decode back to the inputs", () => {
  const ix = build(2, NEW_SIGNER);
  assert.equal(getU8Decoder().decode(ix.data.subarray(8, 9)), 2);
  assert.equal(getAddressDecoder().decode(ix.data.subarray(9, 41)), NEW_SIGNER);
});

test("rotate_signer accounts are the four I-8 accounts, in order, with correct roles", () => {
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
  // mint: READONLY — PDA-derivation seed input, no CPI.
  assert.equal(a0.address, MINT);
  assert.equal(a0.role, AccountRole.READONLY);
  // PDA-1 MintState: WRITABLE — the rotated authority pubkey is written.
  assert.equal(a1.address, MINT_STATE);
  assert.equal(a1.role, AccountRole.WRITABLE);
  // Operator + Reserve: the 2-of-2 readonly signers (Operator initiates, Reserve
  // countersigns). No PDA-3, no token-2022 (contrast I-6).
  assert.equal(a2.address, OPERATOR);
  assert.equal(a2.role, AccountRole.READONLY_SIGNER);
  assert.equal(a3.address, RESERVE);
  assert.equal(a3.role, AccountRole.READONLY_SIGNER);
});
