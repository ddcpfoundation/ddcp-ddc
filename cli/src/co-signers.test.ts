// Offline unit tests for the distinct co-signer check (co-signers.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { address, type Address } from "@solana/kit";
import { decideDistinctCoSigners } from "./co-signers.js";

const ISSUER: Address = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const OPERATOR: Address = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
const RESERVE: Address = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const FRESH: Address = address("EYzWKVdZ4b6Sav47vN3vjcM6GQmnUq1KqP6rqdqisEuV");
const live = { issuer: ISSUER, operator: OPERATOR, reserve: RESERVE };

test("co-signers: a fresh key for each role passes", () => {
  for (const role of [0, 1, 2]) {
    assert.equal(decideDistinctCoSigners({ ...live, role, newSigner: FRESH }), undefined);
  }
});

test("co-signers: each of the six cross-role keys is refused, naming the role that holds it", () => {
  const cases: Array<[number, Address, string]> = [
    [0, OPERATOR, "the current Operator key"],
    [0, RESERVE, "the current Reserve key"],
    [1, ISSUER, "the current Issuer key"],
    [1, RESERVE, "the current Reserve key"],
    [2, ISSUER, "the current Issuer key"],
    [2, OPERATOR, "the current Operator key"],
  ];
  for (const [role, newSigner, holder] of cases) {
    const refusal = decideDistinctCoSigners({ ...live, role, newSigner });
    assert.ok(refusal !== undefined, `role ${role} -> ${newSigner} must be refused`);
    assert.ok(refusal.startsWith("REFUSED "));
    assert.ok(refusal.includes(holder));
    assert.ok(refusal.includes("Nothing was signed and nothing was sent."));
  }
});

test("co-signers: rotating a role to its own current key passes", () => {
  assert.equal(decideDistinctCoSigners({ ...live, role: 0, newSigner: ISSUER }), undefined);
  assert.equal(decideDistinctCoSigners({ ...live, role: 1, newSigner: OPERATOR }), undefined);
  assert.equal(decideDistinctCoSigners({ ...live, role: 2, newSigner: RESERVE }), undefined);
});

test("co-signers: a role outside 0..2 is left to the program's InvalidRole check", () => {
  assert.equal(decideDistinctCoSigners({ ...live, role: 3, newSigner: OPERATOR }), undefined);
});

test("co-signers: a rotation that separates two roles sharing one key passes", () => {
  const shared = { issuer: ISSUER, operator: ISSUER, reserve: RESERVE };
  assert.equal(decideDistinctCoSigners({ ...shared, role: 1, newSigner: FRESH }), undefined);
});

test("co-signers: a rotation that leaves two other roles on one key is refused", () => {
  const shared = { issuer: ISSUER, operator: ISSUER, reserve: RESERVE };
  const refusal = decideDistinctCoSigners({ ...shared, role: 2, newSigner: FRESH });
  assert.ok(refusal !== undefined);
  assert.ok(refusal.includes("the Issuer and Operator keys are already one key"));
  assert.ok(refusal.includes("Nothing was signed and nothing was sent."));
});
