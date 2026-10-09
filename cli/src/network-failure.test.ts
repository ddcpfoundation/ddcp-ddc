// The network-failure refusal: the pure classifier and formatter, the
// broadcast record of tx/broadcast.ts, and the BUILT ENTRY spawned against a
// closed port, a closed proxy port and a proxy that refuses to tunnel. The
// spawn is asynchronous because the refusing proxy lives in this process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Base64EncodedWireTransaction } from "@solana/kit";
import { formatNetworkFailure, readTransportFailure } from "./network-failure.js";
import { broadcastAndConfirm, broadcastRecord } from "./tx/broadcast.js";
import type { SolanaRpc } from "./rpc.js";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

function fetchFailed(...chain: Error[]): TypeError {
  let cause: Error | undefined;
  for (const e of [...chain].reverse()) {
    if (cause !== undefined) (e as { cause?: unknown }).cause = cause;
    cause = e;
  }
  return new TypeError("fetch failed", cause === undefined ? undefined : { cause });
}

const REFUSED = fetchFailed(new Error("connect ECONNREFUSED 127.0.0.1:45999"));
const TUNNEL = fetchFailed(new Error("Request was cancelled."), new Error("Proxy response (500) !== 200 when HTTP Tunneling"));
const NONE = { begun: false, signature: undefined };

test("network failure: only a TypeError reading fetch failed is a transport failure", () => {
  assert.equal(readTransportFailure(new Error("fetch failed")), undefined);
  assert.equal(readTransportFailure(new TypeError("something else")), undefined);
  assert.equal(readTransportFailure("fetch failed"), undefined);
  assert.deepEqual(readTransportFailure(new TypeError("fetch failed")), { causeLine: "fetch failed", proxyAnswered: false });
});

test("network failure: the cause line is the deepest message and a tunnel refusal marks the proxy as having answered", () => {
  assert.deepEqual(readTransportFailure(REFUSED), { causeLine: "connect ECONNREFUSED 127.0.0.1:45999", proxyAnswered: false });
  assert.deepEqual(readTransportFailure(TUNNEL), { causeLine: "Proxy response (500) !== 200 when HTTP Tunneling", proxyAnswered: true });
});

test("network failure: before any send, with no proxy, the endpoint is named and nothing was sent", () => {
  const f = readTransportFailure(REFUSED);
  assert.ok(f !== undefined);
  assert.equal(
    formatNetworkFailure(f, undefined, NONE),
    [
      "NETWORK FAILURE -- the connection failed: connect ECONNREFUSED 127.0.0.1:45999",
      "The RPC endpoint could not be reached.",
      "Nothing was sent: this command had not broadcast a transaction when the connection failed.",
      "Check the endpoint address (--rpc-url, or rpc_url in the config file) and the network connection, then run the command again.",
    ].join("\n"),
  );
});

test("network failure: before any send, a connect-level failure under a proxy is the proxy's", () => {
  const f = readTransportFailure(REFUSED);
  assert.ok(f !== undefined);
  const text = formatNetworkFailure(f, "http://127.0.0.1:18118", NONE);
  assert.match(text, /^The proxy at http:\/\/127\.0\.0\.1:18118 could not be reached\. No request went direct\.$/m);
  assert.match(text, /^Start the proxy, or remove the proxy setting from the config file, then run the command again\.$/m);
  assert.match(text, /^Nothing was sent: /m);
});

test("network failure: before any send, a proxy that refuses the tunnel points at the endpoint", () => {
  const f = readTransportFailure(TUNNEL);
  assert.ok(f !== undefined);
  const text = formatNetworkFailure(f, "http://127.0.0.1:18118", NONE);
  assert.match(text, /^The proxy at http:\/\/127\.0\.0\.1:18118 answered but could not reach the RPC endpoint\.$/m);
  assert.match(text, /^Check the endpoint address /m);
});

test("network failure: after a send has begun the refusal NEVER says nothing was sent, with or without a signature", () => {
  const f = readTransportFailure(REFUSED);
  assert.ok(f !== undefined);
  const noSig = formatNetworkFailure(f, undefined, { begun: true, signature: undefined });
  const withSig = formatNetworkFailure(f, undefined, { begun: true, signature: "SIG111" });
  for (const text of [noSig, withSig]) {
    assert.equal(text.includes("Nothing was sent"), false);
    assert.match(text, /It may have landed\./);
    assert.match(text, /^Do NOT run the command again until you have checked: /m);
  }
  assert.match(withSig, /signature SIG111\. It may have landed\./);
  assert.match(noSig, /no signature came back/);
});

function fakeRpc(send: () => Promise<string>, status: () => Promise<unknown>): SolanaRpc {
  return {
    sendTransaction: () => ({ send }),
    getSignatureStatuses: () => ({ send: status }),
  } as unknown as SolanaRpc;
}

test("network failure: the broadcast record is begun and carries no signature when the send call itself fails", async () => {
  broadcastRecord.begun = false;
  broadcastRecord.signature = undefined;
  const rpc = fakeRpc(() => Promise.reject(REFUSED), () => Promise.reject(new Error("unreached")));
  await assert.rejects(broadcastAndConfirm(rpc, "AA==" as Base64EncodedWireTransaction, "confirmed", "TEST"), (e) => e === REFUSED);
  assert.deepEqual({ ...broadcastRecord }, { begun: true, signature: undefined });
  broadcastRecord.begun = false;
});

test("network failure: the broadcast record carries the signature when the confirmation poll fails", async () => {
  broadcastRecord.begun = false;
  broadcastRecord.signature = undefined;
  const rpc = fakeRpc(() => Promise.resolve("SIG222"), () => Promise.reject(REFUSED));
  await assert.rejects(broadcastAndConfirm(rpc, "AA==" as Base64EncodedWireTransaction, "confirmed", "TEST"), (e) => e === REFUSED);
  assert.deepEqual({ ...broadcastRecord }, { begun: true, signature: "SIG222" });
  broadcastRecord.begun = false;
  broadcastRecord.signature = undefined;
});

interface Run { status: number | null; stdout: string; stderr: string }

function run(nodeArgs: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
    const child = spawn(process.execPath, nodeArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end("");
    setTimeout(() => child.kill("SIGKILL"), 20000).unref();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function deadPort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function withConfig<T>(body: (write: (cfg: Record<string, string>) => string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-network-failure-test-"));
  try {
    return await body((cfg) => {
      const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(cfg));
      return path;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("network failure entry: state against a closed endpoint prints the sentence, no stack, exit 1", async () => {
  const port = await deadPort();
  await withConfig(async (write) => {
    const r = await run([ENTRY, "state", "--config", write({ rpc_url: `http://127.0.0.1:${port}` })]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, [
      `NETWORK FAILURE -- the connection failed: connect ECONNREFUSED 127.0.0.1:${port}`,
      "The RPC endpoint could not be reached.",
      "Nothing was sent: this command had not broadcast a transaction when the connection failed.",
      "Check the endpoint address (--rpc-url, or rpc_url in the config file) and the network connection, then run the command again.",
      "",
    ].join("\n"));
  });
});

test("network failure entry: state with the configured proxy down names the proxy, no stack, exit 1", async () => {
  const endpoint = await deadPort();
  const proxyPort = await deadPort();
  await withConfig(async (write) => {
    const proxy = `http://127.0.0.1:${proxyPort}`;
    const r = await run([ENTRY, "state", "--config", write({ rpc_url: `http://127.0.0.1:${endpoint}`, proxy })]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.includes("TypeError"), false);
    assert.match(r.stderr, new RegExp(`^NETWORK FAILURE -- the connection failed: connect ECONNREFUSED 127\\.0\\.0\\.1:${proxyPort}$`, "m"));
    assert.match(r.stderr, /No request went direct\./);
    assert.match(r.stderr, /^Start the proxy, /m);
  });
});

test("network failure entry: state through a proxy that refuses the tunnel points at the endpoint, exit 1", async () => {
  const endpoint = await deadPort();
  const refusing = createServer((_req, res) => { res.statusCode = 405; res.end(); });
  refusing.on("connect", (_req, client) => { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  const proxyPort = await listen(refusing);
  try {
    await withConfig(async (write) => {
      const proxy = `http://127.0.0.1:${proxyPort}`;
      const r = await run([ENTRY, "state", "--config", write({ rpc_url: `http://127.0.0.1:${endpoint}`, proxy })]);
      assert.equal(r.status, 1);
      assert.equal(r.stderr.includes("TypeError"), false);
      assert.match(r.stderr, /^NETWORK FAILURE -- the connection failed: Proxy response \(502\) !== 200 when HTTP Tunneling$/m);
      assert.match(r.stderr, /answered but could not reach the RPC endpoint\./);
    });
  } finally {
    refusing.closeAllConnections();
    refusing.close();
  }
});
