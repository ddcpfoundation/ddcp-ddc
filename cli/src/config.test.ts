import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTargetBlock,
  requireSigningIdentity,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
} from "./config.js";
import {
  COMMITMENT,
  DDC_MINT,
  DEVNET_RPC_URL,
  PROGRAM_ID,
} from "./constants.js";

// A --config path that never exists: exercises the absent-file path
// hermetically, without ever reading the real ~/.ddc/config.json.
const missingConfig = join(
  tmpdir(),
  `ddc-cli-test-no-such-config-${process.pid}.json`,
);

test("resolveConfig falls back to constants defaults (absent config file)", () => {
  const cfg = resolveConfig(["--config", missingConfig]);
  assert.equal(cfg.rpcUrl, DEVNET_RPC_URL);
  assert.equal(cfg.commitment, COMMITMENT);
  assert.equal(cfg.mint, DDC_MINT);
  assert.equal(cfg.programId, PROGRAM_ID);
  assert.deepEqual(cfg.source, {
    rpcUrl: "default",
    mint: "default",
    program: "default",
  });
});

test("flags override defaults and are recorded as source=flag", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--rpc-url", "http://127.0.0.1:8899",
    "--mint", "Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp",
  ]);
  assert.equal(cfg.rpcUrl, "http://127.0.0.1:8899");
  assert.equal(cfg.mint, "Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp");
  assert.equal(cfg.programId, PROGRAM_ID);
  assert.deepEqual(cfg.source, {
    rpcUrl: "flag",
    mint: "flag",
    program: "default",
  });
});

test("a bad --mint address throws a clear error", () => {
  assert.throws(
    () => resolveConfig(["--config", missingConfig, "--mint", "not-a-valid-address"]),
    /Invalid --mint/,
  );
});

test("config-file values apply, and flags beat the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-test-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ rpc_url: "http://file.example:8899" }));
    const fromFile = resolveConfig(["--config", path]);
    assert.equal(fromFile.rpcUrl, "http://file.example:8899");
    assert.equal(fromFile.source.rpcUrl, "file");

    const flagWins = resolveConfig([
      "--config", path,
      "--rpc-url", "http://flag.example:8899",
    ]);
    assert.equal(flagWins.rpcUrl, "http://flag.example:8899");
    assert.equal(flagWins.source.rpcUrl, "flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed config JSON throws an error naming the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-test-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, "{ not json");
    assert.throws(
      () => resolveConfig(["--config", path]),
      (err: unknown) => err instanceof Error && err.message.includes(path),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --keypair/--role plumbing: flag-only signing identity.

test("--keypair and --role issuer are carried through", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--keypair", "/tmp/k.json",
    "--role", "issuer",
  ]);
  assert.equal(cfg.keypair, "/tmp/k.json");
  assert.equal(cfg.role, "issuer");
});

test("--role operator and --role reserve are each accepted", () => {
  assert.equal(
    resolveConfig(["--config", missingConfig, "--role", "operator"]).role,
    "operator",
  );
  assert.equal(
    resolveConfig(["--config", missingConfig, "--role", "reserve"]).role,
    "reserve",
  );
});

test("an invalid --role throws naming the value and all three valid roles", () => {
  assert.throws(
    () => resolveConfig(["--config", missingConfig, "--role", "treasurer"]),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("treasurer") &&
      err.message.includes("issuer") &&
      err.message.includes("operator") &&
      err.message.includes("reserve"),
  );
});

test("absent --keypair/--role resolve to undefined (read-only commands unaffected)", () => {
  const cfg = resolveConfig(["--config", missingConfig]);
  assert.equal(cfg.keypair, undefined);
  assert.equal(cfg.role, undefined);
});

test("requireSigningIdentity returns both when present", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--keypair", "/tmp/k.json",
    "--role", "reserve",
  ]);
  assert.deepEqual(requireSigningIdentity(cfg), {
    keypairPath: "/tmp/k.json",
    role: "reserve",
  });
});

test("requireSigningIdentity without --keypair throws naming --keypair", () => {
  const cfg = resolveConfig(["--config", missingConfig, "--role", "issuer"]);
  assert.throws(() => requireSigningIdentity(cfg), /--keypair is required/);
});

test("requireSigningIdentity without --role throws naming --role", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--keypair", "/tmp/k.json",
  ]);
  assert.throws(() => requireSigningIdentity(cfg), /--role is required/);
});

// requireWalletIdentity — the USER-command contract: keypair only, --role
// refused BY NAME. Same hermetic --config path as every test above: nothing
// here reads a real config file.

test("requireWalletIdentity returns the keypair path when --keypair alone is stated", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--keypair", "/tmp/k.json",
  ]);
  // deepEqual, not a field check: this also pins that NO role field is returned.
  assert.deepEqual(requireWalletIdentity(cfg), { keypairPath: "/tmp/k.json" });
});

test("requireWalletIdentity refuses a stated --role BY NAME, not silently", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--keypair", "/tmp/k.json",
    "--role", "issuer",
  ]);
  assert.throws(() => requireWalletIdentity(cfg), /--role does not apply/);
});

test("requireWalletIdentity without --keypair throws naming --keypair", () => {
  const cfg = resolveConfig(["--config", missingConfig]);
  assert.throws(() => requireWalletIdentity(cfg), /--keypair is required/);
});

test("requireWalletIdentity with a role and no keypair reports the ROLE first", () => {
  // Ordering pin: a person who typed --role on a user command is following
  // admin documentation, so correcting that comes before the missing flag.
  // The role message DOES contain the characters "--keypair" (it says to
  // state it), hence the exact-phrase negative assertion below.
  const cfg = resolveConfig(["--config", missingConfig, "--role", "issuer"]);
  assert.throws(() => requireWalletIdentity(cfg), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /--role does not apply/);
    assert.doesNotMatch(err.message, /--keypair is required/);
    return true;
  });
});

test("formatTargetBlock names cluster, mint and program with their sources", () => {
  const cfg = resolveConfig(["--config", missingConfig]);
  const block = formatTargetBlock(cfg);
  assert.match(block, /^TARGET cluster : /m);
  assert.match(block, /^TARGET mint    : /m);
  assert.match(block, /^TARGET program : /m);
  assert.ok(block.includes(DEVNET_RPC_URL));
  assert.ok(block.includes(DDC_MINT));
  assert.ok(block.includes(PROGRAM_ID));
  assert.equal(block.split("\n").length, 3);
});

test("formatTargetBlock reports the source of each value, not just the value", () => {
  const overridden = resolveConfig([
    "--config", missingConfig,
    "--rpc-url", "https://example.invalid/rpc",
  ]);
  const block = formatTargetBlock(overridden);
  // The cluster was stated on the command line; mint and program were not.
  assert.match(block, /TARGET cluster : https:\/\/example\.invalid\/rpc \(flag\)/);
  assert.match(block, /TARGET mint    : .* \(default\)/);
  assert.match(block, /TARGET program : .* \(default\)/);
});

test("requireStatedCluster refuses a silently defaulted cluster, naming both ways to state one", () => {
  const cfg = resolveConfig(["--config", missingConfig]);
  assert.equal(cfg.source.rpcUrl, "default");
  assert.throws(() => requireStatedCluster(cfg), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /--broadcast requires an explicitly stated cluster/);
    assert.match(err.message, /--rpc-url/);
    assert.match(err.message, /rpc_url/);
    return true;
  });
});

test("requireStatedCluster passes when the cluster is stated by flag", () => {
  const cfg = resolveConfig([
    "--config", missingConfig,
    "--rpc-url", "https://example.invalid/rpc",
  ]);
  assert.equal(cfg.source.rpcUrl, "flag");
  assert.doesNotThrow(() => requireStatedCluster(cfg));
});

// A user command that sends without --broadcast names its own
// action in the refusal. The two assertions that earn their keep are the
// anchored opening and the doesNotMatch — the fixed half of the message
// (--rpc-url / rpc_url) is true under any action and proves nothing here.
test("requireStatedCluster names the caller's action in the refusal and never --broadcast when one is given", () => {
  const cfg = resolveConfig(["--config", missingConfig]);
  assert.equal(cfg.source.rpcUrl, "default");
  assert.throws(() => requireStatedCluster(cfg, "setup-privacy"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^setup-privacy requires an explicitly stated cluster/);
    assert.doesNotMatch(err.message, /--broadcast/);
    assert.match(err.message, /--rpc-url/);
    assert.match(err.message, /rpc_url/);
    return true;
  });
  // The one-argument form is byte-for-byte the admin wording the six admin callers rely on.
  assert.throws(() => requireStatedCluster(cfg), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^--broadcast requires an explicitly stated cluster/);
    return true;
  });
  // A stated cluster passes with an action exactly as it does without one.
  const stated = resolveConfig(["--config", missingConfig, "--rpc-url", "https://example.invalid/rpc"]);
  assert.doesNotThrow(() => requireStatedCluster(stated, "setup-privacy"));
});
