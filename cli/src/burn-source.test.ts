// The burn source check: the program's three source checks, judged by the
// client before anything is signed (burn-source.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import { decideBurnSource, toBurnSourceRead, type BurnSourceExpectation } from "./burn-source.js";
import { deriveRedemptionAuthorityPda } from "./pda.js";
import { DDC_MINT, PROGRAM_ID, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from "./constants.js";

const SOURCE = address("Dm77K7enHmU59Wbe4GN6Vfu2n2BXherKQra348zVU8t7");
const HOLDER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const OTHER_MINT = address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp");

/** A 165-byte token account body: mint at [0:32], owner at [32:64], the rest zero. */
function tokenAccount(mint: Address, owner: Address): Uint8Array {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  return data;
}

async function expectation(): Promise<BurnSourceExpectation> {
  const [redemptionAuthority] = await deriveRedemptionAuthorityPda(PROGRAM_ID, DDC_MINT);
  return { source: SOURCE, mint: DDC_MINT, redemptionAuthority, token2022Program: TOKEN_2022_PROGRAM };
}

function assertRefusal(text: string | undefined, cause: string): void {
  assert.ok(text !== undefined, "expected a refusal");
  assert.ok(text.startsWith("REFUSED " + String.fromCharCode(0x2014) + " the burn source " + SOURCE + " is not the redemption-collection account: "));
  assert.ok(text.includes(cause), "the refusal names its cause: " + cause);
  assert.ok(text.includes("so this transaction could never succeed. Nothing was signed and nothing was sent."));
  assert.ok(text.endsWith("Name the redemption-collection account as the source."));
}

test("burn source: a Token-2022 account holding this mint and owned by PDA-5 passes", async () => {
  const expect = await expectation();
  const read = { exists: true as const, programOwner: TOKEN_2022_PROGRAM, data: tokenAccount(DDC_MINT, expect.redemptionAuthority) };
  assert.equal(decideBurnSource(read, expect), undefined);
});

test("burn source: no account at the address is refused before anything is signed", async () => {
  assertRefusal(decideBurnSource({ exists: false }, await expectation()), "no account exists at that address");
});

test("burn source: an account another program owns is refused naming that program", async () => {
  const expect = await expectation();
  const read = { exists: true as const, programOwner: SYSTEM_PROGRAM, data: tokenAccount(DDC_MINT, expect.redemptionAuthority) };
  assertRefusal(decideBurnSource(read, expect), "the account belongs to the program " + SYSTEM_PROGRAM + ", not to Token-2022");
});

test("burn source: data too short to be a token account is refused naming its length", async () => {
  const expect = await expectation();
  const read = { exists: true as const, programOwner: TOKEN_2022_PROGRAM, data: new Uint8Array(63) };
  assertRefusal(decideBurnSource(read, expect), "its data is 63 bytes, too short to be a token account");
});

test("burn source: a token account for another mint is refused naming both mints", async () => {
  const expect = await expectation();
  const read = { exists: true as const, programOwner: TOKEN_2022_PROGRAM, data: tokenAccount(OTHER_MINT, expect.redemptionAuthority) };
  assertRefusal(decideBurnSource(read, expect), "it holds the mint " + OTHER_MINT + ", not " + DDC_MINT);
});

test("burn source: a holder's own token account is refused naming its owner, the case the program refused with 6001", async () => {
  const expect = await expectation();
  const read = { exists: true as const, programOwner: TOKEN_2022_PROGRAM, data: tokenAccount(DDC_MINT, HOLDER) };
  const text = decideBurnSource(read, expect);
  assertRefusal(text, "its owner is " + HOLDER + ", not PDA-5");
  assert.ok(text !== undefined && text.includes("PDA-5 " + expect.redemptionAuthority));
});

test("burn source: the read converter maps null to absent and base64 data to its bytes", () => {
  assert.deepEqual(toBurnSourceRead(null), { exists: false });
  const read = toBurnSourceRead({ owner: TOKEN_2022_PROGRAM, data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"] });
  assert.ok(read.exists);
  assert.equal(read.programOwner, TOKEN_2022_PROGRAM);
  assert.deepEqual(Array.from(read.data), [1, 2, 3]);
});
