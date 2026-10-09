// The rename script (scripts/rename-currency.py) refuses while a fork still
// names an address or key of the Foundation's devnet demonstration outside
// its test files. Its list of those values must hold every address and key in
// the README's two instance tables and both durable-nonce accounts of
// constants.ts, so that a new reference genesis cannot leave the list behind.
//
// In the reference repository the README tables name the demonstration
// program, the first entry of the list, and every value there must be on the
// list. In a fork that has replaced the tables with its own deployment's,
// the tables and the nonce accounts must name none of the listed values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ISSUER_NONCE_ACCOUNT, OPERATOR_NONCE_ACCOUNT } from "./constants.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ELGAMAL_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** Every address or key in the table rows of the README's instance section. */
function readmeInstanceValues(): string[] {
  const readme = repoFile("README.md");
  const start = readme.indexOf("\n## The deployed reference instance\n");
  assert.ok(start >= 0, "README has no section \"The deployed reference instance\"");
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);
  const values = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const value = match[1]!;
      if (BASE58.test(value) || ELGAMAL_BASE64.test(value)) values.add(value);
    }
  }
  return [...values];
}

/** The values of the DEMONSTRATION tuple in the rename script, in order. */
function scriptList(): string[] {
  const script = repoFile("scripts/rename-currency.py");
  const block = /\nDEMONSTRATION = \(\n([\s\S]*?)\n\)\n/.exec(script);
  assert.ok(block, "scripts/rename-currency.py has no DEMONSTRATION tuple");
  return [...block[1]!.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]!);
}

test("demonstration addresses: the rename script's list holds every address of the README instance tables and both nonce accounts", () => {
  const list = scriptList();
  const fromReadme = readmeInstanceValues();
  const nonces = [ISSUER_NONCE_ACCOUNT as string, OPERATOR_NONCE_ACCOUNT as string];
  assert.ok(list.length > 0, "the list is empty");
  assert.equal(new Set(list).size, list.length, "the list repeats a value");
  if (fromReadme.includes(list[0]!)) {
    // The reference repository: nothing in the tables or the nonces may be missing.
    const missing = [...fromReadme, ...nonces].filter((value) => !list.includes(value));
    assert.deepEqual(missing, [], `missing from the rename script's list: ${missing.join(", ")}`);
  } else {
    // A fork that replaced its tables: none of the Foundation's values may remain.
    const left = [...fromReadme, ...nonces].filter((value) => list.includes(value));
    assert.deepEqual(left, [], `the Foundation's devnet values are still named: ${left.join(", ")}`);
  }
});
