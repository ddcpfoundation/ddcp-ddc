// The proxy decision, pure. Nothing here launches a process or opens a
// socket; proxy-entry.test.ts runs the built entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROXY_CHILD_MARKER,
  PROXY_SWITCH,
  buildChildEnv,
  decideProxy,
  formatProxyDisclosure,
  parseProxyUrl,
} from "./proxy.js";

function withConfig<T>(content: string, run: (argv: string[]) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ddc-cli-proxy-test-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, content);
    return run(["state", "--config", path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("proxy: an http or https address is accepted and returned as its origin", () => {
  assert.equal(parseProxyUrl("http://127.0.0.1:8118"), "http://127.0.0.1:8118");
  assert.equal(parseProxyUrl("http://127.0.0.1:8118/"), "http://127.0.0.1:8118");
  assert.equal(parseProxyUrl("https://proxy.example:3128"), "https://proxy.example:3128");
});

test("proxy: a SOCKS address is refused with the sentence that names the bridge", () => {
  assert.throws(
    () => parseProxyUrl("socks5://127.0.0.1:9050"),
    {
      message:
        'the proxy setting "socks5://127.0.0.1:9050" is a SOCKS address. This client speaks to HTTP proxies only. To use Tor or another SOCKS proxy, run an HTTP-to-SOCKS bridge and set proxy to the bridge\'s http:// address.',
    },
  );
  assert.throws(() => parseProxyUrl("socks5h://127.0.0.1:9050"), /is a SOCKS address/);
});

test("proxy: any other scheme, a non-URL, credentials, and a path are each refused", () => {
  assert.throws(() => parseProxyUrl("ftp://127.0.0.1:21"), /must start with http:\/\/ or https:\/\//);
  assert.throws(() => parseProxyUrl("127.0.0.1:8118"), /is not a URL\. It must look like http:\/\/host:port\./);
  assert.throws(() => parseProxyUrl("not a url"), /is not a URL/);
  assert.throws(() => parseProxyUrl("http://user:secret@127.0.0.1:8118"), /user name or password/);
  assert.throws(() => parseProxyUrl("http://127.0.0.1:8118/path"), /bare address/);
});

test("proxy: the child environment sets the switch, the marker and all four variables, and REMOVES both spellings of NO_PROXY", () => {
  const env = buildChildEnv(
    { PATH: "/bin", NO_PROXY: "127.0.0.1", no_proxy: "localhost", HTTP_PROXY: "http://stale:1" },
    "http://127.0.0.1:8118",
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    HTTP_PROXY: "http://127.0.0.1:8118",
    HTTPS_PROXY: "http://127.0.0.1:8118",
    http_proxy: "http://127.0.0.1:8118",
    https_proxy: "http://127.0.0.1:8118",
    [PROXY_SWITCH]: "1",
    [PROXY_CHILD_MARKER]: "http://127.0.0.1:8118",
  });
});

test("proxy: with no proxy configured the decision is direct, and ambient HTTP_PROXY is left alone", () => {
  withConfig("{}", (argv) => {
    assert.deepEqual(decideProxy(argv, { HTTP_PROXY: "http://ambient:1", NO_PROXY: "x" }), { kind: "direct" });
  });
});

test("proxy: with no proxy configured, the switch set in the shell is REFUSED rather than honored", () => {
  withConfig("{}", (argv) => {
    const d = decideProxy(argv, { [PROXY_SWITCH]: "1", HTTP_PROXY: "http://ambient:1" });
    assert.equal(d.kind, "refuse");
    assert.match((d as { message: string }).message, /takes its proxy from its config file only, never from the shell/);
  });
});

test("proxy: a configured proxy in a fresh environment decides a re-launch, with the disclosure line and the exact child environment", () => {
  withConfig('{"proxy":"http://127.0.0.1:8118"}', (argv) => {
    const d = decideProxy(argv, { PATH: "/bin", NO_PROXY: "127.0.0.1" });
    assert.deepEqual(d, {
      kind: "relaunch",
      proxy: "http://127.0.0.1:8118",
      env: buildChildEnv({ PATH: "/bin" }, "http://127.0.0.1:8118"),
      disclosure: formatProxyDisclosure("http://127.0.0.1:8118"),
    });
  });
});

test("proxy: the child, finding its environment exact, proceeds; the same environment with NO_PROXY added back is refused, never run direct", () => {
  withConfig('{"proxy":"http://127.0.0.1:8118"}', (argv) => {
    const exact = buildChildEnv({ PATH: "/bin" }, "http://127.0.0.1:8118");
    assert.deepEqual(decideProxy(argv, exact), { kind: "proceed", proxy: "http://127.0.0.1:8118" });
    const d = decideProxy(argv, { ...exact, NO_PROXY: "127.0.0.1" });
    assert.equal(d.kind, "refuse");
    assert.match((d as { message: string }).message, /It will not run direct/);
  });
});

test("proxy: a SOCKS proxy in the config file, and a config file that is not JSON, are both refusals at the gate", () => {
  withConfig('{"proxy":"socks5://127.0.0.1:9050"}', (argv) => {
    const d = decideProxy(argv, {});
    assert.equal(d.kind, "refuse");
    assert.match((d as { message: string }).message, /^REFUSED: the proxy setting "socks5:\/\/127\.0\.0\.1:9050" is a SOCKS address\..* Nothing was sent\.$/);
  });
  withConfig("{not json", (argv) => {
    const d = decideProxy(argv, {});
    assert.equal(d.kind, "refuse");
    assert.match((d as { message: string }).message, /cannot tell whether a proxy is configured/);
  });
});

test("proxy: the disclosure line, whole", () => {
  assert.equal(
    formatProxyDisclosure("http://127.0.0.1:8118"),
    "PROXY          : http://127.0.0.1:8118 (file) -- every network request of this command goes through it. If it cannot be reached the command fails; nothing is ever sent direct.",
  );
});
