// Offline unit tests for the I-7 publish-reserve-statement PURE surface only, per
// convention (mirrors admin-pause.test.ts): the live broadcast path and the
// interactive prompt are proven by a real devnet run, never mocked here.
// runAdminPublishReserveStatement is NOT called. The Reserve role-guard is exercised
// via assertRoleAuthority — the exact function the command calls before
// signing — against the real devnet PDA-1 snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { address } from "@solana/kit";
import { decodeMintState } from "../mint-state.js";
import { assertRoleAuthority } from "../role-guard.js";
import {
  parsePublishReserveStatementArgs,
  formatPublishReserveStatementInspection,
} from "./admin-publish-reserve-statement.js";

const fixtureUrl = new URL(
  "../../test-fixtures/pda1-mintstate-devnet.b64",
  import.meta.url,
);
const state = decodeMintState(
  Uint8Array.from(
    Buffer.from(readFileSync(fixtureUrl, "utf8").trim(), "base64"),
  ),
);

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const ATTESTATION = address("7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP");
const NON_AUTHORITY = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

test("publish role-guard: reserve authority with stated role reserve passes", () => {
  assert.doesNotThrow(() => assertRoleAuthority("reserve", state.reserve, state));
});

test("publish role-guard: a non-authority stated as reserve is refused, naming role, got key, expected key", () => {
  assert.throws(
    () => assertRoleAuthority("reserve", NON_AUTHORITY, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("reserve"), "names the role");
      assert.ok(err.message.includes(NON_AUTHORITY), "names the key it got");
      assert.ok(err.message.includes(state.reserve), "names the key it expected");
      return true;
    },
  );
});

test("publish role-guard: right key wrong role — issuer key stated as reserve is refused", () => {
  assert.throws(
    () => assertRoleAuthority("reserve", state.issuer, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("reserve"), "names the role");
      assert.ok(err.message.includes(state.issuer), "names the key it got");
      assert.ok(err.message.includes(state.reserve), "names the key it expected");
      return true;
    },
  );
});

test("parsePublishReserveStatementArgs: valid amount + uri returns parsed triple", () => {
  const r = parsePublishReserveStatementArgs("601000000", "https://example.org/a.json");
  assert.equal(r.amount, 601000000n);
  assert.equal(r.uri, "https://example.org/a.json");
  assert.equal(r.uriByteLength, new TextEncoder().encode("https://example.org/a.json").length);
});

test("parsePublishReserveStatementArgs: missing amount or uri throws usage", () => {
  assert.throws(() => parsePublishReserveStatementArgs(undefined, "u"), /usage/);
  assert.throws(() => parsePublishReserveStatementArgs("1", undefined), /usage/);
});

test("parsePublishReserveStatementArgs: non-integer amount throws", () => {
  assert.throws(() => parsePublishReserveStatementArgs("1.5", "u"), /non-negative integer/);
  assert.throws(() => parsePublishReserveStatementArgs("-1", "u"), /non-negative integer/);
  assert.throws(() => parsePublishReserveStatementArgs("0x10", "u"), /non-negative integer/);
});

test("parsePublishReserveStatementArgs: URI over 128 BYTES throws, naming the byte length", () => {
  const uri = "\u00F1".repeat(65); // 130 bytes from 65 chars
  assert.throws(
    () => parsePublishReserveStatementArgs("0", uri),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("130"), "names the byte length");
      return true;
    },
  );
});

test("parsePublishReserveStatementArgs: URI at exactly 128 bytes is accepted", () => {
  const r = parsePublishReserveStatementArgs("0", "x".repeat(128));
  assert.equal(r.uriByteLength, 128);
});

test("publish inspection block contains amount (as RESERVE base units), uri+bytelength, PDA-2, the OVERWRITE line, and the NOT-a-mint-gate line", () => {
  const out = formatPublishReserveStatementInspection({
    mint: MINT,
    mintStatePda: MINT_STATE,
    attestationPda: ATTESTATION,
    reserveAuthority: state.reserve,
    amount: 601000000n,
    uri: "https://example.org/a.json",
    uriByteLength: 26,
  });
  assert.ok(out.includes(`PDA-2 (target)    : ${ATTESTATION}`));
  assert.ok(out.includes("601000000 base units (6 dp, the reserve's value in the currency's unit of account)"));
  assert.ok(out.includes("https://example.org/a.json (26 bytes)"));
  assert.ok(out.includes("WILL OVERWRITE the PDA-2 record (AttestationRecord)"));
  assert.ok(out.includes("NOT a mint gate — I-2 never reads PDA-2"));
});
