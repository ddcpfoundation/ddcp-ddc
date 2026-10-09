// Offline unit tests for the 3.4 cancel helpers: the live broadcast path is
// proven by a real devnet run, never mocked.
//
// CONVENTION EXCEPTION, DELIBERATE: the two coupling-assert tests at the end
// call runAdminCancel, the command entry function, where every other test in
// this file exercises a pure helper. Taken for the same reason
// entry-ordering.test.ts took it: the property under test is the position of
// a check inside that function, which exists nowhere else. They stay offline
// because the coupling assert refuses before loadSignerFromFile and before
// createRpc, and each passes --config at a path that does not exist so a real
// ~/.ddc/config.json cannot influence the result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRole, address } from "@solana/kit";
import {
  ISSUER_NONCE_ACCOUNT,
  OPERATOR_NONCE_ACCOUNT,
  SYSTEM_PROGRAM,
  SYSVAR_RECENT_BLOCKHASHES,
} from "../constants.js";
import {
  buildAdvanceNonceInstruction,
  formatCancelInspection,
  parseCancelArgs,
  runAdminCancel,
} from "./admin-cancel.js";

const ISSUER_V2 = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const NONCE_VALUE = "5YYHuxxXuTUv5XTKVqdhCeVMrsBc4b6BpXUmzANFwL6A";

// A --config path that never exists: forces the absent-file branch of
// resolveConfig, so a real ~/.ddc/config.json cannot influence the result.
const MISSING_CONFIG = join(
  tmpdir(),
  "ddc-admin-cancel-no-such-config-file.json",
);

test("sysvar constant is the recent-blockhashes sysvar (digit-1 spelling)", () => {
  assert.equal(
    SYSVAR_RECENT_BLOCKHASHES,
    "SysvarRecentB1ockHashes11111111111111111111",
  );
});

test("advance-nonce instruction: System program, data [4,0,0,0], three accounts in the on-chain-verified order and roles", () => {
  const ix = buildAdvanceNonceInstruction(
    ISSUER_NONCE_ACCOUNT,
    SYSVAR_RECENT_BLOCKHASHES,
    ISSUER_V2,
  );
  assert.equal(ix.programAddress, SYSTEM_PROGRAM);
  assert.deepEqual(Array.from(ix.data), [4, 0, 0, 0]);
  assert.equal(Buffer.from(ix.data).toString("hex"), "04000000");
  assert.equal(ix.accounts.length, 3);
  const [a0, a1, a2] = ix.accounts;
  if (a0 === undefined || a1 === undefined || a2 === undefined) {
    assert.fail("instruction must have all three accounts");
  }
  assert.equal(a0.address, ISSUER_NONCE_ACCOUNT);
  assert.equal(a0.role, AccountRole.WRITABLE);
  assert.equal(a1.address, SYSVAR_RECENT_BLOCKHASHES);
  assert.equal(a1.role, AccountRole.READONLY);
  assert.equal(a2.address, ISSUER_V2);
  assert.equal(a2.role, AccountRole.READONLY_SIGNER);
});

test("cancel inspection (issuer): nonce account, current value, authority, fee payer, and the WILL ADVANCE line all appear", () => {
  const out = formatCancelInspection({
    nonceLabel: "issuer",
    nonceAccount: ISSUER_NONCE_ACCOUNT,
    currentNonceValue: NONCE_VALUE,
    nonceAuthority: ISSUER_V2,
    feePayer: ISSUER_V2,
  });
  assert.ok(
    out.includes(`nonce account  : ${ISSUER_NONCE_ACCOUNT} (issuer)`),
  );
  assert.ok(out.includes(`nonce value    : ${NONCE_VALUE} (current)`));
  assert.ok(out.includes(`nonce authority: ${ISSUER_V2}`));
  assert.ok(out.includes(`fee payer      : ${ISSUER_V2} (issuer signer)`));
  assert.ok(
    out.includes(
      `WILL ADVANCE the issuer nonce FROM ${NONCE_VALUE} — this invalidates any pending transaction pinned to it.`,
    ),
  );
});

test("cancel inspection (operator): every issuer-labeled line carries the operator label instead, and no line says issuer", () => {
  const out = formatCancelInspection({
    nonceLabel: "operator",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
    currentNonceValue: NONCE_VALUE,
    nonceAuthority: ISSUER_V2,
    feePayer: ISSUER_V2,
  });
  assert.ok(out.includes(`nonce account  : ${OPERATOR_NONCE_ACCOUNT} (operator)`));
  assert.ok(out.includes(`fee payer      : ${ISSUER_V2} (operator signer)`));
  assert.ok(
    out.includes(
      `WILL ADVANCE the operator nonce FROM ${NONCE_VALUE} — this invalidates any pending transaction pinned to it.`,
    ),
  );
  // The whole point of the parameterisation: no issuer wording survives on
  // the operator path.
  assert.equal(out.toLowerCase().includes("issuer"), false);
});

test("parseCancelArgs: issuer maps to the issuer nonce account", () => {
  assert.deepEqual(parseCancelArgs("issuer"), {
    nonceRole: "issuer",
    nonceAccount: ISSUER_NONCE_ACCOUNT,
  });
});

test("parseCancelArgs: operator maps to the operator nonce account", () => {
  assert.deepEqual(parseCancelArgs("operator"), {
    nonceRole: "operator",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
  });
});

test("parseCancelArgs: a missing selector throws the usage message", () => {
  assert.throws(
    () => parseCancelArgs(undefined),
    /usage — admin cancel <issuer\|operator>/,
  );
});

test("parseCancelArgs: reserve is refused by name, and the message says why there is no reserve nonce", () => {
  assert.throws(() => parseCancelArgs("reserve"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /must be exactly one of/);
    assert.match(err.message, /got "reserve"/);
    assert.match(err.message, /no reserve nonce account/);
    return true;
  });
});

test("parseCancelArgs: an unrelated value is refused, not silently defaulted", () => {
  assert.throws(() => parseCancelArgs("ISSUER"), /got "ISSUER"/);
});

test("coupling assert: selector operator with --role issuer is refused, before any key load", async () => {
  await assert.rejects(
    () =>
      runAdminCancel([
        "admin",
        "cancel",
        "operator",
        "--config",
        MISSING_CONFIG,
        "--keypair",
        "/tmp/ddc-no-such-keypair.json",
        "--role",
        "issuer",
      ]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /does not match the selected/);
      // Both halves: the coupling message IS what surfaces, and the keypair
      // file was never opened.
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );
});

test("coupling assert: selector issuer with --role operator is refused in the mirror direction", async () => {
  await assert.rejects(
    () =>
      runAdminCancel([
        "admin",
        "cancel",
        "issuer",
        "--config",
        MISSING_CONFIG,
        "--keypair",
        "/tmp/ddc-no-such-keypair.json",
        "--role",
        "operator",
      ]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /does not match the selected/);
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );
});
