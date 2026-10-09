import { test } from "node:test";
import assert from "node:assert/strict";
import { address, getAddressEncoder } from "@solana/kit";
import {
  decodeReserveStatement,
  formatReserveStatementLines,
  formatReserveStatementUri,
} from "./reserve-statement.js";

// The program's ATTESTATION_RECORD_DISCRIMINATOR (program/src/state.rs).
const DISCRIMINATOR = [0x21, 0x89, 0x0d, 0xc1, 0x27, 0xe8, 0xd8, 0x3f];
const PDA2 = address("7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const OTHER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const URI = "https://example.org/ddc/devnet-test-instrument-no-reserve-no-value"; // rename-currency: keep (captured from the reference mint)

// Builds a record from the program's layout, written field by field here
// rather than through the decoder's offsets.
function record(f: { amount: bigint; ts: bigint; publisher: Uint8Array; uri: Uint8Array; bump: number }): Uint8Array {
  const out = new Uint8Array(185);
  const view = new DataView(out.buffer);
  out.set(DISCRIMINATOR, 0);
  view.setBigUint64(8, f.amount, true);
  view.setBigInt64(16, f.ts, true);
  out.set(f.publisher, 24);
  out.set(f.uri, 56);
  out[184] = f.bump;
  return out;
}

const published = record({
  amount: 0n,
  ts: 1_790_798_628n,
  publisher: Uint8Array.from(getAddressEncoder().encode(RESERVE)),
  uri: new TextEncoder().encode(URI),
  bump: 255,
});

test("reserve statement: decodes the statement of zero on the reference mint", () => {
  const s = decodeReserveStatement(published);
  assert.equal(s.amount, 0n);
  assert.equal(s.publishedAt, 1_790_798_628n);
  assert.equal(s.publisher, RESERVE);
  assert.equal(new TextDecoder().decode(s.uriBytes), URI);
  assert.equal(s.bump, 255);
});

test("reserve statement: state prints the publisher, time, figure and URI", () => {
  assert.deepEqual(formatReserveStatementLines(decodeReserveStatement(published), { pda: PDA2, reserve: RESERVE }), [
    "reserveStmt    : 7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP (PDA-2, bump 255)",
    "reserveStmtBy  : Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez (the reserve key in PDA-1)",
    "reserveStmtAt  : 2026-09-30T20:03:48Z (cluster clock at publication; the time of measurement is in the document)",
    "reserveAmount  : 0 base units (6 dp, the reserve's value in the currency's unit of account)",
    `reserveStmtUri : "${URI}"`,
  ]);
});

test("reserve statement: a publisher that is no longer the reserve key is named as such", () => {
  const lines = formatReserveStatementLines(decodeReserveStatement(published), { pda: PDA2, reserve: OTHER });
  assert.equal(lines[1], "reserveStmtBy  : Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez (NOT the reserve key in PDA-1 now)");
});

test("reserve statement: the genesis record reads as none published", () => {
  const genesis = record({ amount: 0n, ts: 0n, publisher: new Uint8Array(32), uri: new Uint8Array(0), bump: 254 });
  const s = decodeReserveStatement(genesis);
  assert.equal(s.publisher, null);
  assert.equal(s.uriBytes.length, 0);
  assert.deepEqual(formatReserveStatementLines(s, { pda: PDA2, reserve: RESERVE }), [
    "reserveStmt    : 7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP (PDA-2, bump 254)",
    "reserveStmtBy  : none published",
  ]);
});

test("reserve statement: a URI of the full 128 bytes is read whole", () => {
  const uri = new TextEncoder().encode("u".repeat(128));
  const s = decodeReserveStatement(record({ amount: 1n, ts: 1n, publisher: new Uint8Array(32).fill(7), uri, bump: 255 }));
  assert.equal(s.uriBytes.length, 128);
});

test("reserve statement: a URI that is not UTF-8 is printed as hex", () => {
  assert.equal(formatReserveStatementUri(Uint8Array.from([0x68, 0xff, 0x00, 0x69])), "not UTF-8, 4 bytes, hex 68ff0069");
  assert.equal(formatReserveStatementUri(new TextEncoder().encode("a\nb")), '"a\\nb"');
});

test("reserve statement: a time outside the calendar range is printed in seconds", () => {
  const s = decodeReserveStatement(
    record({ amount: 5n, ts: 9_000_000_000_000n, publisher: new Uint8Array(32).fill(7), uri: new Uint8Array(0), bump: 255 }),
  );
  const lines = formatReserveStatementLines(s, { pda: PDA2, reserve: RESERVE });
  assert.match(lines[2] ?? "", /^reserveStmtAt  : 9000000000000 unix seconds, outside the calendar range /);
});

test("reserve statement: a wrong length or discriminator is refused", () => {
  assert.throws(() => decodeReserveStatement(published.subarray(0, 184)), /exactly 185 bytes, got 184/);
  const wrong = published.slice();
  wrong.set([DISCRIMINATOR[0]! ^ 1], 0);
  assert.throws(() => decodeReserveStatement(wrong), /discriminator mismatch: expected 21890dc127e8d83f/);
});
