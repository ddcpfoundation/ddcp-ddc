// Tests pinning the threshold copy and the trigger
// arithmetic it rests on, in the confidential-refusals.test.ts pin style:
// the fixed example figures (51,999 of about 65,000; 65,200) are asserted
// literally so a rounding or grouping change cannot pass as cosmetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCounterFill,
  formatCounterFillingWarning,
  formatCounterFullWarning,
  formatPendingValueWarning,
  groupThousands,
  PENDING_READ_WALL_BASE_UNITS,
  PENDING_VALUE_WARNING_BASE_UNITS,
  roundedCounterCap,
  shouldWarnPendingValue,
} from "./confidential-warnings.js";

test("value threshold: the wall is 2^48, the trigger is exactly half of it, and the boundary is inclusive", () => {
  assert.equal(PENDING_READ_WALL_BASE_UNITS, 281474976710656n);
  assert.equal(PENDING_VALUE_WARNING_BASE_UNITS, 140737488355328n);
  assert.equal(PENDING_VALUE_WARNING_BASE_UNITS * 2n, PENDING_READ_WALL_BASE_UNITS);
  assert.equal(shouldWarnPendingValue(PENDING_VALUE_WARNING_BASE_UNITS - 1n), false);
  assert.equal(shouldWarnPendingValue(PENDING_VALUE_WARNING_BASE_UNITS), true);
});

test("groupThousands: exact rendering with commas every three digits, and negatives refused", () => {
  assert.equal(groupThousands(0n), "0");
  assert.equal(groupThousands(999n), "999");
  assert.equal(groupThousands(1000n), "1,000");
  assert.equal(groupThousands(51999n), "51,999");
  assert.equal(groupThousands(65536n), "65,536");
  assert.equal(groupThousands(4294901760n), "4,294,901,760");
  assert.throws(() => groupThousands(-1n), /non-negative/);
});

test("classifyCounterFill: 75% trigger on the EXACT cap, full/filling split on the ROUNDED cap, exact below 1,000", () => {
  assert.equal(roundedCounterCap(65536n), 65000n);
  assert.equal(roundedCounterCap(800n), 800n);
  assert.equal(classifyCounterFill(49151n, 65536n), "none");
  assert.equal(classifyCounterFill(49152n, 65536n), "filling");
  assert.equal(classifyCounterFill(51999n, 65536n), "filling");
  assert.equal(classifyCounterFill(64999n, 65536n), "filling");
  assert.equal(classifyCounterFill(65000n, 65536n), "full");
  assert.equal(classifyCounterFill(65536n, 65536n), "full");
  // A small cap never rounds to zero: the split point is the exact cap itself.
  assert.equal(classifyCounterFill(599n, 800n), "none");
  assert.equal(classifyCounterFill(600n, 800n), "filling");
  assert.equal(classifyCounterFill(800n, 800n), "full");
});

test("formatPendingValueWarning: headline, the rounded-down wall figure, the exact pending figure, and the margin-not-guarantee close", () => {
  const msg = formatPendingValueWarning(150000000000000n);
  assert.match(msg, /^◎ UNAPPLIED PENDING IS APPROACHING THE LIMIT THIS CLI CAN READ\./);
  assert.match(msg, /150000000\.000000 DDC/);
  assert.match(msg, /about 280,000,000\.000000 DDC/);
  assert.match(msg, /on-chain figures stay exact and no value is lost/);
  assert.match(msg, /stops accepting confidential credits/);
  assert.match(msg, /ddc apply-pending/);
  assert.match(msg, /a margin, not a guarantee — one very large credit can cross the limit between one read and the next\.$/);
});

test("counter warnings: C1 renders the fixed example exactly; C2 carries no fraction and the fixed risk; a small cap renders exactly", () => {
  const filling = formatCounterFillingWarning(51999n, 65536n);
  assert.match(filling, /^◎ YOUR PENDING CREDIT COUNTER IS FILLING: 51,999 credits, out of about 65,000 this account accepts\./);
  assert.match(filling, /refuses further confidential credits, including your own shielded balances/);
  assert.match(filling, /ddc apply-pending/);
  const full = formatCounterFullWarning(65200n);
  assert.match(full, /^◎ YOUR PENDING CREDIT COUNTER IS FULL OR NEARLY FULL: 65,200 credits\./);
  assert.match(full, /may already be refusing confidential credits, including your own shielded balances/);
  assert.doesNotMatch(full, /out of/);
  const small = formatCounterFillingWarning(700n, 800n);
  assert.match(small, /700 credits, out of 800 this account accepts/);
  assert.doesNotMatch(small, /about 800/);
});
