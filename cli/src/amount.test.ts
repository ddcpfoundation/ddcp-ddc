// Tests for the DDC amount module: string integer arithmetic, fixed six
// places, a seventh decimal REFUSED with its own no-rounding message, and
// the parse/format round trip exact.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_UNITS_PER_DDC,
  DDC_DECIMALS,
  formatDdcAmount,
  parseDdcAmount,
} from "./amount.js";

test("the scale constants: six decimals, one million base units per DDC", () => {
  assert.equal(DDC_DECIMALS, 6);
  assert.equal(BASE_UNITS_PER_DDC, 1_000_000n);
});

test("parseDdcAmount: plain decimals to base units by string arithmetic", () => {
  assert.equal(parseDdcAmount("0"), 0n);
  assert.equal(parseDdcAmount("1"), 1_000_000n);
  assert.equal(parseDdcAmount("1.5"), 1_500_000n);
  assert.equal(parseDdcAmount("0.000001"), 1n);
  assert.equal(parseDdcAmount("20"), 20_000_000n);
  assert.equal(parseDdcAmount("1.234567"), 1_234_567n);
  assert.equal(parseDdcAmount("007.5"), 7_500_000n);
  assert.equal(
    parseDdcAmount("281474976.710655"),
    281_474_976_710_655n,
  );
});

test("parseDdcAmount: a seventh decimal place is refused with the no-rounding message, never rounded", () => {
  for (const text of ["1.2345678", "0.00000010", "9.99999999"]) {
    assert.throws(
      () => parseDdcAmount(text),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /at most six decimal places/);
        assert.match(err.message, /Nothing is rounded/);
        return true;
      },
    );
  }
});

test("parseDdcAmount: every other malformed shape gets the grammar refusal", () => {
  for (const text of ["", "1.", ".5", "-1", "+1", "1,5", "1.5e3", " 1.5", "1.5 ", "abc", "1..5", "1.5.0"]) {
    assert.throws(() => parseDdcAmount(text), /not a valid DDC amount/);
  }
});

test("formatDdcAmount: fixed six places, numeric only, negatives refused; round trip exact", () => {
  assert.equal(formatDdcAmount(0n), "0.000000");
  assert.equal(formatDdcAmount(1n), "0.000001");
  assert.equal(formatDdcAmount(1_500_000n), "1.500000");
  assert.equal(formatDdcAmount(1_234_567n), "1.234567");
  assert.equal(formatDdcAmount(20_000_000n), "20.000000");
  assert.throws(() => formatDdcAmount(-1n), /must be non-negative/);
  for (const v of [0n, 1n, 999_999n, 1_000_000n, 1_500_000n, 281_474_976_710_655n, 18_446_744_073_709_551_615n]) {
    assert.equal(parseDdcAmount(formatDdcAmount(v)), v);
  }
  assert.equal(formatDdcAmount(parseDdcAmount("1.5")), "1.500000");
  assert.equal(formatDdcAmount(parseDdcAmount("007.5")), "7.500000");
});
