// The product install census. The
// product install is `npm ci --omit=dev --omit=optional --ignore-scripts`.
// `--omit=dev` alone keeps `typescript`, which the lockfile marks
// `devOptional` because every `@solana/kit` sub-package declares it an
// OPTIONAL peer; `--omit=optional` drops it, and nothing else, today. These
// tests read the tracked lockfile and fail when a dependency move changes
// what that command drops or what it ships: a new optional or devOptional
// entry would be dropped by the product install and must be reviewed first,
// and a changed product set changes what must be attributed on distribution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface LockEntry {
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  license?: string;
}

const LOCK = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, LockEntry>;
};
const ENTRIES = Object.entries(LOCK.packages).filter(([path]) => path !== "");

test("install census: the entries dropped by --omit=optional are exactly typescript", () => {
  const dropped = ENTRIES.filter(([, e]) => e.optional === true || e.devOptional === true).map(([path]) => path).sort();
  assert.deepEqual(dropped, ["node_modules/typescript"]);
});

test("install census: the entries dropped by --omit=dev are exactly @types/node and the top-level undici-types", () => {
  const dropped = ENTRIES.filter(([, e]) => e.dev === true).map(([path]) => path).sort();
  assert.deepEqual(dropped, ["node_modules/@types/node", "node_modules/undici-types"]);
});

test("install census: the product set is 54 entries, 49 MIT, 4 Apache-2.0 and @solana/zk-sdk declaring none", () => {
  const product = ENTRIES.filter(([, e]) => e.dev !== true && e.devOptional !== true && e.optional !== true);
  const counts: Record<string, number> = {};
  for (const [, e] of product) {
    const key = e.license ?? "(none)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  assert.equal(product.length, 54);
  assert.deepEqual(counts, { MIT: 49, "Apache-2.0": 4, "(none)": 1 });
  assert.deepEqual(product.filter(([, e]) => e.license === undefined).map(([path]) => path), ["node_modules/@solana/zk-sdk"]);
});
