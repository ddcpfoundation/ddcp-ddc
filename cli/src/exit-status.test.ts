// The exit status rule (exit-status.ts), pinned at the built entry: a thrown
// refusal prints its sentence alone and exits 1, and a typed-CONFIRM abort
// exits 1 having sent nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBase58Decoder } from "@solana/kit";
import { EXIT_NOT_DONE, formatUnrecognizedFailure } from "./exit-status.js";
import { deriveMintStatePda } from "./pda.js";
import { DDC_MINT, PROGRAM_ID } from "./constants.js";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
const PDA1_FIXTURE = Buffer.from(
  readFileSync(new URL("../test-fixtures/pda1-mintstate-devnet.b64", import.meta.url), "utf8").trim(),
  "base64",
);

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function run(args: string[], home: string, stdinText: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env["PATH"] ?? "", HOME: home };
    const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdinText);
    setTimeout(() => child.kill("SIGKILL"), 20000).unref();
  });
}

test("formatUnrecognizedFailure: an Error prints its message alone; an empty message and a non-Error each name what failed", () => {
  assert.equal(EXIT_NOT_DONE, 1);
  assert.equal(formatUnrecognizedFailure(new Error("REFUSED -- the sentence of record.")), "REFUSED -- the sentence of record.");
  assert.equal(formatUnrecognizedFailure(new TypeError("")), "ddc: the command failed with an error that carries no message (TypeError)");
  assert.equal(formatUnrecognizedFailure("plain"), "ddc: the command failed: plain");
});

test("exit status entry: a thrown refusal prints its sentence alone on stderr, no stack and no source line, exit 1", async () => {
  const home = mkdtempSync(join(tmpdir(), "ddc-cli-exit-status-test-"));
  try {
    const r = await run(["admin", "serialize", "burn", "1", "not-an-address"], home, "");
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, 'admin serialize burn: source "not-an-address" is not a valid address\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("exit status entry: a typed-CONFIRM abort at publish-reserve-statement prints ABORTED, sends nothing and exits 1", async () => {
  // A throwaway reserve key; PDA-1 is the devnet snapshot with its reserve slot
  // replaced by this key, so the role guard passes and the prompt is reached.
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const secret = Buffer.from(jwk.d, "base64url");
  const pub = Buffer.from(jwk.x, "base64url");
  const pda1 = Buffer.from(PDA1_FIXTURE);
  pub.copy(pda1, 73);
  const [mintStatePda] = await deriveMintStatePda(PROGRAM_ID, DDC_MINT);
  const methods: string[] = [];
  const endpoint = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      const call = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] };
      methods.push(call.method);
      let result: unknown;
      if (call.method === "getAccountInfo") {
        const data = call.params?.[0] === mintStatePda ? pda1 : Buffer.alloc(185);
        result = { context: { slot: 1 }, value: { data: [data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0, space: data.length } };
      } else if (call.method === "getLatestBlockhash") {
        result = { context: { slot: 1 }, value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 100 } };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not in this stub" } } : { jsonrpc: "2.0", id: call.id, result }));
    });
  });
  const port = await listen(endpoint);
  const home = mkdtempSync(join(tmpdir(), "ddc-cli-exit-status-test-"));
  try {
    const keypair = join(home, "reserve.json");
    writeFileSync(keypair, JSON.stringify([...secret, ...pub]));
    const r = await run(
      ["admin", "publish-reserve-statement", "0", "https://example.org/x", "--keypair", keypair, "--role", "reserve", "--broadcast", "--rpc-url", `http://127.0.0.1:${port}`],
      home,
      "NO\n",
    );
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.endsWith("): ABORTED " + String.fromCharCode(0x2014) + " typed confirmation not received; nothing was broadcast.\n"));
    assert.equal(r.status, 1);
    assert.deepEqual(methods, ["getAccountInfo", "getAccountInfo", "getLatestBlockhash"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    endpoint.closeAllConnections();
    endpoint.close();
  }
});
