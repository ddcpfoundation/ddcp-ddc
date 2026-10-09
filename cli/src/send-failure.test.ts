// The send-failure refusal: the pure reader and formatter, the
// BroadcastFailure that tx/broadcast.ts throws on an on-chain err and on poll
// exhaustion, and the kit's preflight error passing through unchanged. The
// poll is shortened by its test-only parameter so no test waits a minute. The
// BUILT ENTRY is spawned once, against a local endpoint answering every
// request with the preflight error code, to prove the entry routes the code
// to this refusal; `state` sends nothing, so that run tests the routing only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  getSolanaErrorFromJsonRpcError,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { readTransportFailure } from "./network-failure.js";
import { formatSendFailure, readSendFailure } from "./send-failure.js";
import { BroadcastFailure, broadcastAndConfirm, broadcastRecord } from "./tx/broadcast.js";
import type { SolanaRpc } from "./rpc.js";

function preflight(err: unknown): unknown {
  return getSolanaErrorFromJsonRpcError({
    code: -32002,
    message: "Transaction simulation failed",
    data: { err, logs: [], accounts: null, unitsConsumed: 0n, returnData: null },
  });
}

function fakeRpc(send: () => Promise<unknown>, status: () => Promise<unknown>): SolanaRpc {
  return {
    sendTransaction: () => ({ send }),
    getSignatureStatuses: () => ({ send: status }),
  } as unknown as SolanaRpc;
}

const FAST = { attempts: 2, intervalMs: 1 };
const WIRE = "AA==" as Base64EncodedWireTransaction;

function resetRecord(): void {
  broadcastRecord.begun = false;
  broadcastRecord.signature = undefined;
}

test("send failure: the reader and the transport reader are disjoint across every shape either recognizes", () => {
  const onChain = new BroadcastFailure("X FAILED on-chain", { kind: "on-chain", signature: "S1", errJson: "{}" });
  const unconfirmed = new BroadcastFailure("not confirmed", { kind: "unconfirmed", signature: "S2", attempts: 30, intervalMs: 2000 });
  const custom = preflight({ InstructionError: [1, { Custom: 6000 }] });
  const fetchFailed = new TypeError("fetch failed");
  const http = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Forbidden", statusCode: 403 });
  for (const e of [onChain, unconfirmed, custom]) {
    assert.ok(readSendFailure(e) !== undefined);
    assert.equal(readTransportFailure(e), undefined);
  }
  for (const e of [fetchFailed, http]) {
    assert.equal(readSendFailure(e), undefined);
    assert.ok(readTransportFailure(e) !== undefined);
  }
  assert.equal(readSendFailure(new Error("PUBLIC TRANSFER FAILED on-chain: {} (signature S3)")), undefined);
  assert.equal(readSendFailure("not an error"), undefined);
});

test("send failure: a preflight refusal reads its deepest cause and flags an already-processed transaction only", () => {
  const custom = readSendFailure(preflight({ InstructionError: [1, { Custom: 6000 }] }));
  assert.deepEqual(custom, { kind: "preflight", causeLine: "Custom program error: #6000 (instruction #2)", alreadyProcessed: false });
  const done = readSendFailure(preflight("AlreadyProcessed"));
  assert.ok(done !== undefined && done.kind === "preflight");
  assert.equal(done.alreadyProcessed, true);
  const bare = readSendFailure(preflight(undefined));
  assert.deepEqual(bare, { kind: "preflight", causeLine: "Transaction simulation failed", alreadyProcessed: false });
});

test("send failure: the three refusals state cause, risk and action, and only the unconfirmed one says it may land", () => {
  const refused = formatSendFailure({ kind: "preflight", causeLine: "Blockhash not found", alreadyProcessed: false });
  assert.match(refused, /^TRANSACTION REFUSED -- .*simulation failed: Blockhash not found$/m);
  assert.match(refused, /^This attempt was not forwarded to the network: it moved nothing and no fee was charged\.$/m);
  assert.equal(refused.includes("may"), false);
  const again = formatSendFailure({ kind: "preflight", causeLine: "This transaction has already been processed", alreadyProcessed: true });
  assert.match(again, /an earlier send of this transaction landed\. Do NOT send it again/);
  const failed = formatSendFailure({ kind: "on-chain", signature: "SIG777", errJson: "{\"InstructionError\":[1,{\"Custom\":6000}]}" });
  assert.match(failed, /^TRANSACTION FAILED -- the transaction reached the network and failed there: \{/m);
  assert.match(failed, /^Signature SIG777\. A failed transaction is atomic: it moved nothing, but the network fee was charged\.$/m);
  assert.equal(failed.includes("may"), false);
  const pending = formatSendFailure({ kind: "unconfirmed", signature: "SIG888", attempts: 30, intervalMs: 2000 });
  assert.match(pending, /^TRANSACTION NOT CONFIRMED -- no confirmation after 30 status checks, 2 seconds apart\.$/m);
  assert.match(pending, /^Signature SIG888\. It was sent, and it may still land\.$/m);
  assert.match(pending, /^Do NOT run the command again until you have checked: /m);
  for (const text of [refused, again, failed, pending]) assert.equal(/[^\x20-\x7e\n]/.test(text), false);
});

test("send failure: an on-chain err throws a BroadcastFailure whose message is the one callers always printed", async () => {
  resetRecord();
  const err = { InstructionError: [0, { Custom: 1 }] };
  const rpc = fakeRpc(() => Promise.resolve("SIG444"), () => Promise.resolve({ value: [{ err, confirmationStatus: "processed" }] }));
  await assert.rejects(broadcastAndConfirm(rpc, WIRE, "confirmed", "TEST", FAST), (e: unknown) => {
    assert.ok(e instanceof BroadcastFailure);
    assert.equal(e.message, "TEST FAILED on-chain: {\"InstructionError\":[0,{\"Custom\":1}]} (signature SIG444)");
    assert.deepEqual(e.detail, { kind: "on-chain", signature: "SIG444", errJson: "{\"InstructionError\":[0,{\"Custom\":1}]}" });
    return true;
  });
  assert.deepEqual({ ...broadcastRecord }, { begun: true, signature: "SIG444" });
  resetRecord();
});

test("send failure: an exhausted poll throws a BroadcastFailure naming the signature and the poll it ran", async () => {
  resetRecord();
  const rpc = fakeRpc(() => Promise.resolve("SIG555"), () => Promise.resolve({ value: [null] }));
  await assert.rejects(broadcastAndConfirm(rpc, WIRE, "confirmed", "TEST", FAST), (e: unknown) => {
    assert.ok(e instanceof BroadcastFailure);
    assert.equal(e.message, "broadcast not confirmed after 2 polls " + String.fromCharCode(0x2014) + " signature SIG555; re-ground before ANY retry");
    assert.deepEqual(e.detail, { kind: "unconfirmed", signature: "SIG555", attempts: 2, intervalMs: 1 });
    return true;
  });
  resetRecord();
});

test("send failure: a preflight refusal from the send call passes through broadcastAndConfirm unchanged, before any signature", async () => {
  resetRecord();
  const refusal = preflight({ InstructionError: [1, { Custom: 6000 }] });
  const rpc = fakeRpc(() => Promise.reject(refusal), () => Promise.reject(new Error("unreached")));
  await assert.rejects(broadcastAndConfirm(rpc, WIRE, "confirmed", "TEST", FAST), (e: unknown) => e === refusal);
  assert.deepEqual({ ...broadcastRecord }, { begun: true, signature: undefined });
  assert.equal(readSendFailure(refusal)?.kind, "preflight");
  resetRecord();
});

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

test("send failure entry: the built entry routes the preflight error code to the refusal, no stack, exit 1", async () => {
  const endpoint = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      let id: unknown = 1;
      try { id = (JSON.parse(body) as { id?: unknown }).id ?? 1; } catch { id = 1; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32002, message: "Transaction simulation failed", data: { err: { InstructionError: [1, { Custom: 6000 }] }, logs: [], accounts: null, unitsConsumed: 0, returnData: null } } }));
    });
  });
  const port = await listen(endpoint);
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-send-failure-test-"));
  try {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ rpc_url: `http://127.0.0.1:${port}` }));
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
      const child = spawn(process.execPath, [ENTRY, "state", "--config", config], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end("");
      setTimeout(() => child.kill("SIGKILL"), 20000).unref();
    });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.includes("SolanaError"), false);
    assert.match(r.stderr, /^TRANSACTION REFUSED -- .*simulation failed: Custom program error: #6000 \(instruction #2\)$/m);
    assert.match(r.stderr, /^This attempt was not forwarded to the network: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    endpoint.closeAllConnections();
    endpoint.close();
  }
});
