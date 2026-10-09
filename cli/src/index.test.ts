import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_LIST,
  VERSION,
  banner,
  formatUnknownCommand,
  resolveCommand,
} from "./index.js";

test("VERSION is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("banner includes the version", () => {
  assert.ok(banner().includes(VERSION));
});

// The dispatcher's pure resolver: bare `admin` is help, every registered word
// resolves, anything else is refused by name and never falls through to the
// banner silently.
test("resolveCommand: bare is help; every user command and admin subcommand resolves; the list names shield, unshield and both transfer commands", () => {
  assert.deepEqual(resolveCommand([]), { kind: "help" });
  for (const name of ["state", "setup-privacy", "balance", "apply-pending", "shield", "unshield", "confidential-transfer", "public-transfer"] as const) {
    assert.deepEqual(resolveCommand([name, "--keypair", "x"]), { kind: "user", name });
  }
  for (const name of ["serialize", "countersign", "submit", "issuance-pause", "publish-reserve-statement", "cancel"] as const) {
    assert.deepEqual(resolveCommand(["admin", name]), { kind: "admin", name });
  }
  assert.match(COMMAND_LIST, /apply-pending, shield, unshield, confidential-transfer, public-transfer, admin serialize/);
});

test("resolveCommand: an unknown first word, admin plus an unknown second word, and bare admin each refuse by name", () => {
  assert.deepEqual(resolveCommand(["deposit"]), { kind: "unknown", word: "deposit" });
  assert.deepEqual(resolveCommand(["admin", "mint"]), { kind: "unknown-admin", word: "mint" });
  assert.deepEqual(resolveCommand(["admin"]), { kind: "admin-missing" });
  assert.equal(formatUnknownCommand({ kind: "unknown", word: "deposit" }), 'unknown command "deposit"');
  assert.equal(formatUnknownCommand({ kind: "unknown-admin", word: "mint" }), 'unknown admin command "mint"');
  assert.equal(
    formatUnknownCommand({ kind: "admin-missing" }),
    "admin needs a subcommand: serialize, countersign, submit, issuance-pause, publish-reserve-statement, cancel",
  );
  assert.equal(formatUnknownCommand({ kind: "help" }), undefined);
  assert.equal(formatUnknownCommand({ kind: "user", name: "shield" }), undefined);
  for (const line of [formatUnknownCommand({ kind: "unknown", word: "x" }), formatUnknownCommand({ kind: "admin-missing" })]) {
    assert.ok(line !== undefined);
    assert.doesNotMatch(line, /ddc|DDC/);
  }
});
