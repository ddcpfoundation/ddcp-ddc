// The proxy setting on the BUILT ENTRY, spawned as a process. A local stub
// stands in for the RPC node and a local logging proxy that speaks CONNECT
// stands in for the holder's proxy; both directions are asserted: the proxy
// saw the request, and with the proxy down the stub saw nothing. The spawn
// is ASYNCHRONOUS on purpose: both servers live in this process, and a
// synchronous spawn would block them and hang the child.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROXY_SWITCH, formatProxyDisclosure } from "./proxy.js";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
const PROXY_MODULE = new URL("./proxy.js", import.meta.url).href;

interface Run { status: number | null; stdout: string; stderr: string }

function run(nodeArgs: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? "");
    setTimeout(() => child.kill("SIGKILL"), 20000).unref();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

// A stub RPC node: counts requests and answers every one "account not found".
function stubRpc(): { server: Server; hits: () => number } {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      let id: unknown = 1;
      try { id = (JSON.parse(body) as { id?: unknown }).id ?? 1; } catch { /* keep 1 */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: null } }));
    });
  });
  return { server, hits: () => hits };
}

// A logging proxy: counts CONNECT requests, names their targets, tunnels them.
function loggingProxy(): { server: Server; targets: () => string[] } {
  const targets: string[] = [];
  const server = createServer((_req, res) => { res.statusCode = 405; res.end(); });
  server.on("connect", (req, client, head) => {
    targets.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host ?? "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return { server, targets: () => targets };
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...extra };
}

async function withFixture<T>(
  body: (f: { rpcPort: number; proxyPort: number; rpcHits: () => number; proxyTargets: () => string[]; configWith: (proxy: string | undefined) => string }) => Promise<T>,
): Promise<T> {
  const rpc = stubRpc();
  const proxy = loggingProxy();
  const rpcPort = await listen(rpc.server);
  const proxyPort = await listen(proxy.server);
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-proxy-entry-test-"));
  try {
    return await body({
      rpcPort,
      proxyPort,
      rpcHits: rpc.hits,
      proxyTargets: proxy.targets,
      configWith: (p) => {
        const path = join(dir, `config-${p === undefined ? "none" : "p"}-${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(path, JSON.stringify({ rpc_url: `http://127.0.0.1:${rpcPort}`, ...(p === undefined ? {} : { proxy: p }) }));
        return path;
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rpc.server.closeAllConnections();
    proxy.server.closeAllConnections();
    rpc.server.close();
    proxy.server.close();
  }
}

test("proxy entry: with no proxy configured the request goes DIRECT and no disclosure line is printed", async () => {
  await withFixture(async (f) => {
    const r = await run([ENTRY, "state", "--config", f.configWith(undefined)], cleanEnv());
    assert.equal(f.proxyTargets().length, 0);
    assert.equal(f.rpcHits(), 1);
    assert.equal(r.stdout.includes("PROXY"), false);
  });
});

test("proxy entry: with a proxy configured the disclosure line leads, the request reaches the stub THROUGH the proxy, and the exit status is the child's", async () => {
  await withFixture(async (f) => {
    const direct = await run([ENTRY, "state", "--config", f.configWith(undefined)], cleanEnv());
    const proxyUrl = `http://127.0.0.1:${f.proxyPort}`;
    const r = await run([ENTRY, "state", "--config", f.configWith(proxyUrl)], cleanEnv());
    assert.deepEqual(f.proxyTargets(), [`127.0.0.1:${f.rpcPort}`]);
    assert.equal(f.rpcHits(), 2);
    assert.equal(r.stdout.split("\n")[0], formatProxyDisclosure(proxyUrl));
    assert.equal(r.status, direct.status);
  });
});

test("proxy entry: a NO_PROXY in the shell naming the RPC host does NOT send the request direct", async () => {
  await withFixture(async (f) => {
    const proxyUrl = `http://127.0.0.1:${f.proxyPort}`;
    await run([ENTRY, "state", "--config", f.configWith(proxyUrl)], cleanEnv({ NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" }));
    assert.deepEqual(f.proxyTargets(), [`127.0.0.1:${f.rpcPort}`]);
    assert.equal(f.rpcHits(), 1);
  });
});

test("proxy entry: FAIL-CLOSED -- with the configured proxy down the stub sees NOTHING and the command fails", async () => {
  await withFixture(async (f) => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise((resolve) => dead.close(resolve));
    const r = await run([ENTRY, "state", "--config", f.configWith(`http://127.0.0.1:${deadPort}`)], cleanEnv());
    assert.equal(f.rpcHits(), 0);
    assert.equal(f.proxyTargets().length, 0);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.split("\n")[0], formatProxyDisclosure(`http://127.0.0.1:${deadPort}`));
  });
});

test("proxy entry: the switch set in the shell with no proxy configured is refused, exit 2, and the stub sees nothing", async () => {
  await withFixture(async (f) => {
    const r = await run(
      [ENTRY, "state", "--config", f.configWith(undefined)],
      cleanEnv({ [PROXY_SWITCH]: "1", HTTP_PROXY: `http://127.0.0.1:${f.proxyPort}` }),
    );
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^REFUSED: NODE_USE_ENV_PROXY or DDC_PROXY_CHILD is set in the environment but no proxy is configured/);
    assert.equal(f.rpcHits(), 0);
    assert.equal(f.proxyTargets().length, 0);
  });
});

test("proxy entry: help never passes the gate -- a SOCKS proxy in the default config file does not stop the banner, and the same file REFUSES a command", async () => {
  const home = mkdtempSync(join(tmpdir(), "ddc-cli-proxy-home-test-"));
  try {
    mkdirSync(join(home, ".ddc"));
    writeFileSync(join(home, ".ddc", "config.json"), JSON.stringify({ proxy: "socks5://127.0.0.1:9050" }));
    const env = { PATH: process.env["PATH"] ?? "", HOME: home, USERPROFILE: home };
    const help = await run([ENTRY], env);
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");
    const state = await run([ENTRY, "state"], env);
    assert.equal(state.status, 2);
    assert.equal(state.stdout, "");
    assert.match(state.stderr, /^REFUSED: the proxy setting "socks5:\/\/127\.0\.0\.1:9050" is a SOCKS address\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("proxy entry: a typed CONFIRM reaches the re-launched child through the inherited stream, and the child's exit status comes back", async () => {
  const script = `import { relaunchThroughProxy } from ${JSON.stringify(PROXY_MODULE)}; process.exitCode = await relaunchThroughProxy(["-e", "process.stdin.on('data', (d) => { process.stdout.write('child read: ' + d); process.exitCode = 7; });"], process.env);`;
  const r = await run(["--input-type=module", "-e", script], cleanEnv(), "CONFIRM\n");
  assert.equal(r.stdout, "child read: CONFIRM\n");
  assert.equal(r.stderr, "");
  assert.equal(r.status, 7);
});
