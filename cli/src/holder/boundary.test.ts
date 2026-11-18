// The holder library's boundary, read from source: every file the library
// reaches from holder/index.ts, followed through relative imports. The set is
// pinned by equality, so a new import into the library fails here until the
// list is changed on purpose. Within the set: no command file, no
// administrative module, no configuration or key-file reader and no prompt; no
// use of the console, the process or the file system; no currency placeholder
// in the forms the rename script replaces; and only the pinned packages.
// What the library DOES before a send is tested in holder.test.ts; this test
// sees which files use which, not the order in which code runs.
//
// PATHS COME FROM import.meta.url: this file runs from dist/holder/, the
// sources are in src/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../../src/", import.meta.url);

/** The library's files, relative to cli/src, sorted. */
const EXPECTED_FILES = [
  "confidential-account.ts",
  "confidential-balance.ts",
  "confidential-keys.ts",
  "holder/account.ts",
  "holder/apply-pending.ts",
  "holder/balance.ts",
  "holder/confidential-transfer.ts",
  "holder/context.ts",
  "holder/fees.ts",
  "holder/index.ts",
  "holder/public-transfer.ts",
  "holder/refusal.ts",
  "holder/setup-privacy.ts",
  "holder/shield.ts",
  "holder/state.ts",
  "holder/unshield.ts",
  "mint-authorities.ts",
  "mint-state.ts",
  "mint-transfer-fee.ts",
  "pda.ts",
  "program-addresses.ts",
  "program-upgrade-authority.ts",
  "reserve-statement.ts",
  "rpc.ts",
  "transaction-format.ts",
  "tx/apply-pending-tx.ts",
  "tx/confidential-setup-tx.ts",
  "tx/public-transfer-tx.ts",
  "tx/schedule-headroom.ts",
  "tx/shield-tx.ts",
  "tx/transfer-fee-gross.ts",
  "tx/transfer-fee-split.ts",
  "tx/transfer-proofs.ts",
  "tx/transfer-tx.ts",
  "tx/unshield-proofs.ts",
  "tx/unshield-tx.ts",
  "vendor/confidentialTransferArithmetic.ts",
];

/** The packages the library imports, sorted. */
const EXPECTED_PACKAGES = [
  "@noble/curves/ed25519",
  "@solana-program/token-2022",
  "@solana-program/zk-elgamal-proof",
  "@solana/kit",
  "@solana/zk-sdk/node",
  "node:crypto",
];

const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gs;

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

function readSource(file: string): string {
  return readFileSync(new URL(file, SRC), "utf8");
}

/** Every file reachable from holder/index.ts, and every package any of them imports. */
function libraryClosure(): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const stack = ["holder/index.ts"];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    for (const match of readSource(file).matchAll(IMPORT)) {
      const spec = match[1] as string;
      if (spec.startsWith(".")) {
        stack.push(normalize(dir + spec).replace(/\.js$/, ".ts"));
      } else {
        packages.add(spec);
      }
    }
  }
  return { files: [...seen].sort(), packages: [...packages].sort() };
}

/** The rename script's three patterns (scripts/rename-currency.py, PATTERNS). */
const PLACEHOLDER = [
  /(?<![A-Za-z0-9])ddc(?![a-z0-9pP])/,
  /(?<![A-Za-z0-9])DDC(?![A-Z0-9P])|(?<=[a-z0-9_])DDC(?![A-Z0-9P])/,
  /(?<![A-Za-z0-9])Ddc(?![a-z0-9p])|(?<=[a-z0-9])Ddc(?![a-z0-9p])/,
];

const IO = /console\.|process\.|node:fs|node:readline|node:child_process|node:process/;

test("holder boundary: the library reaches exactly the pinned files and packages, and no command, admin, configuration, key-file or prompt module", () => {
  const { files, packages } = libraryClosure();
  assert.deepEqual(files, EXPECTED_FILES);
  assert.deepEqual(packages, EXPECTED_PACKAGES);
  for (const file of files) {
    assert.ok(!file.startsWith("commands/"), file);
    assert.ok(!file.startsWith("instructions/"), file);
    for (const outside of ["config.ts", "signer.ts", "confirm-prompt.ts", "constants.ts", "amount.ts", "tx/broadcast.ts", "role-guard.ts"]) {
      assert.notEqual(file, outside);
    }
  }
});

test("holder boundary: no library file uses the console, the process or the file system, or carries the currency placeholder", () => {
  const { files } = libraryClosure();
  let lines = 0;
  for (const file of files) {
    const source = readSource(file).split("\n");
    lines += source.length;
    for (const [i, line] of source.entries()) {
      assert.ok(!IO.test(line), `${file}:${i + 1} uses the console, the process or the file system: ${line.trim()}`);
      for (const pattern of PLACEHOLDER) {
        assert.ok(!pattern.test(line), `${file}:${i + 1} carries the currency placeholder: ${line.trim()}`);
      }
    }
  }
  // The scan read the files the first test pins, and they are not empty.
  assert.equal(files.length, EXPECTED_FILES.length);
  assert.ok(lines > 1000, `only ${lines} lines read`);
});

test("holder boundary: each pattern catches what it is for", () => {
  assert.ok(IO.test("  console.log(x);"));
  assert.ok(IO.test('import { readFileSync } from "node:fs";'));
  assert.ok(PLACEHOLDER[0]?.test("run ddc apply-pending"));
  assert.ok(PLACEHOLDER[1]?.test("1.000000 DDC"));
  assert.ok(PLACEHOLDER[2]?.test("formatDdcAmount"));
  assert.ok(!PLACEHOLDER.some((p) => p.test("the ddcp protocol, DDCP Foundation")));
});
