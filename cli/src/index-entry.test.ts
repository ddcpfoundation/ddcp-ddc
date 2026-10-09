// The built entry point, spawned as a process. The resolver tests in
// index.test.ts import index.js and never execute it; a guard that was false
// through a symlink left the installed binary inert while every one of those
// tests passed. So this suite is the ONLY place the artifact runs: three
// shapes through a symlink to dist/index.js, the shape `bin` installs, plus
// the real path as the pair, plus an import-only control proving main does
// not run on import.
//
// PATHS COME FROM import.meta.url (compiled, this file sits beside index.js).
// The spawn is process.execPath with no shell; stdout and stderr are asserted
// by equality, never by absence of a substring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_LIST, banner } from "./index.js";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
const HELP = `${banner()}\n${COMMAND_LIST}\n`;

function spawnEntry(argv: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [...argv], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withSymlink<T>(run: (link: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-entry-test-"));
  try {
    const link = join(dir, "ddc");
    symlinkSync(ENTRY, link);
    return run(link);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("entry: bare invocation THROUGH A SYMLINK prints the banner and the list and exits 0, byte-equal to the real path", () => {
  const viaLink = withSymlink((link) => spawnEntry([link]));
  const viaReal = spawnEntry([ENTRY]);
  assert.equal(viaLink.status, 0);
  assert.equal(viaLink.stderr, "");
  assert.equal(viaLink.stdout, HELP);
  assert.deepEqual(viaLink, viaReal);
});

test("entry: an unknown command through the symlink refuses by name, then prints the banner and the list, exit 2", () => {
  const r = withSymlink((link) => spawnEntry([link, "frobnicate"]));
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, `unknown command "frobnicate"\n${HELP}`);
});

test("entry: importing index.js in a fresh process runs nothing: empty stdout, empty stderr, exit 0", () => {
  const r = spawnEntry(["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)});`]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "");
});
