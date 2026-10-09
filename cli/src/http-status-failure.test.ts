// The HTTP-error-status refusal: an endpoint that ANSWERS with an error
// status reaches the entry as a SolanaError, not a fetch failure. The pure
// reader and formatter, and the BUILT ENTRY spawned against a local endpoint
// that answers every request 403. The spawn is asynchronous because the
// endpoint lives in this process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { formatNetworkFailure, readTransportFailure } from "./network-failure.js";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

function httpError(statusCode: number, message: string): SolanaError {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message, statusCode });
}

test("http status failure: the kit's HTTP transport error is read with its status, and other SolanaErrors are not", () => {
  const f = readTransportFailure(httpError(429, "Too Many Requests"));
  assert.ok(f !== undefined);
  assert.equal(f.httpStatus, 429);
  assert.equal(f.proxyAnswered, false);
  assert.match(f.causeLine, /429/);
  assert.equal(readTransportFailure(new Error("HTTP error (429): Too Many Requests")), undefined);
});

test("http status failure: the refusal names the endpoint and the status, before and after a send, proxy or not", () => {
  const f = readTransportFailure(httpError(403, "Forbidden"));
  assert.ok(f !== undefined);
  for (const proxy of [undefined, "http://127.0.0.1:18118"]) {
    const before = formatNetworkFailure(f, proxy, { begun: false, signature: undefined });
    assert.match(before, /^NETWORK FAILURE -- the RPC endpoint answered with an error: /);
    assert.match(before, /^The RPC endpoint refused or failed the request with HTTP status 403\.$/m);
    assert.match(before, /^Nothing was sent: /m);
    assert.match(before, /requires an access key or limits the request rate/);
    assert.equal(before.includes("proxy at"), false);
    const after = formatNetworkFailure(f, proxy, { begun: true, signature: "SIG333" });
    assert.equal(after.includes("Nothing was sent"), false);
    assert.match(after, /signature SIG333\. It may have landed\./);
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

test("http status failure entry: state against an endpoint answering 403 prints the sentence, no stack, exit 1", async () => {
  const endpoint = createServer((_req, res) => { res.statusCode = 403; res.end("Forbidden"); });
  const port = await listen(endpoint);
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-http-status-test-"));
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
    assert.match(r.stderr, /^NETWORK FAILURE -- the RPC endpoint answered with an error: .*403/);
    assert.match(r.stderr, /^The RPC endpoint refused or failed the request with HTTP status 403\.$/m);
    assert.match(r.stderr, /^Nothing was sent: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    endpoint.closeAllConnections();
    endpoint.close();
  }
});
