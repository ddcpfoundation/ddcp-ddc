import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFeeCeiling } from "./fee-ceiling.js";

const ceilings = { feeCeilingBasisPoints: 100, feeCeilingBaseUnits: 1_000_000n };

test("decideFeeCeiling accepts a fee exactly at both ceilings", () => {
  assert.equal(decideFeeCeiling({ newFeeBasisPoints: 100, newMaximumFee: 1_000_000n, ...ceilings }), undefined);
});

test("decideFeeCeiling accepts zero under zero ceilings", () => {
  assert.equal(decideFeeCeiling({ newFeeBasisPoints: 0, newMaximumFee: 0n, feeCeilingBasisPoints: 0, feeCeilingBaseUnits: 0n }), undefined);
});

test("decideFeeCeiling refuses a rate one above the ceiling with the sentence of record", () => {
  assert.equal(
    decideFeeCeiling({ newFeeBasisPoints: 150, newMaximumFee: 1_000_000n, ...ceilings }),
    "REFUSED \u2014 the requested rate (150 bps) is above the ceiling this currency set at issuance (100 bps). No instruction can raise the ceiling. Nothing was built and nothing was sent. Restate a rate at or below 100 bps.",
  );
});

test("decideFeeCeiling refuses a maximum above the ceiling with the sentence of record", () => {
  assert.equal(
    decideFeeCeiling({ newFeeBasisPoints: 100, newMaximumFee: 2_000_000n, ...ceilings }),
    "REFUSED \u2014 the requested maximum fee (2.000000 DDC) is above the ceiling this currency set at issuance (1.000000 DDC). No instruction can raise the ceiling. Nothing was built and nothing was sent. Restate a maximum at or below 1.000000 DDC.",
  );
});

test("decideFeeCeiling judges the rate before the maximum when both are above", () => {
  const sentence = decideFeeCeiling({ newFeeBasisPoints: 101, newMaximumFee: 1_000_001n, ...ceilings });
  assert.ok(sentence !== undefined && sentence.includes("requested rate (101 bps)"));
});
