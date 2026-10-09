// The `proxy` setting. HTTP-only and fail-closed.
//
// WHAT IT IS FOR. A proxy hides the holder's network address, and which
// accounts the holder queries, from the RPC provider. It changes nothing
// on-chain: sender, recipient and block time are public with or without it.
//
// WHY A RE-LAUNCH. At the pinned Node the only switch that routes `fetch`
// through a proxy is NODE_USE_ENV_PROXY, read once at process start; there is
// no runtime call, and the pinned transport's one hook needs a dependency
// this build does not take. So a configured proxy means the entry starts
// itself once more with the switch set and the four proxy variables pointing
// at the configured URL.
//
// WHY NO_PROXY IS REMOVED. With the switch set, a NO_PROXY naming the RPC host
// sends that request DIRECT and the proxy sees nothing. A stray variable in a
// shell would silently defeat the setting, so the child's environment carries
// neither spelling.
//
// WHY AMBIENT VARIABLES ARE REFUSED. The holder's proxy is the one configured
// in the config file, never one inherited from a shell. Without the switch
// Node ignores HTTP_PROXY and its kin, so they are harmless and are left
// alone; the switch itself, set with no proxy configured here, WOULD route
// traffic somewhere this client never disclosed, so that case refuses.
//
// FAIL-CLOSED is the runtime's behavior, not code here: with the switch set
// and the proxy unreachable the request fails and the target is never
// contacted. proxy-entry.test.ts pins it on the built entry.

import { spawn } from "node:child_process";
import { loadConfigFile, resolveConfigPath } from "./config.js";

export const PROXY_SWITCH = "NODE_USE_ENV_PROXY";
export const PROXY_URL_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
export const PROXY_BYPASS_VARIABLES = ["NO_PROXY", "no_proxy"] as const;
// Set by the parent on the child and nowhere else: it is how the child knows
// it IS the re-launch, so an inexact environment is a refusal, never a loop.
export const PROXY_CHILD_MARKER = "DDC_PROXY_CHILD";

export type ProxyEnv = Record<string, string | undefined>;

export type ProxyDecision =
  | { kind: "direct" }
  | { kind: "proceed"; proxy: string }
  | { kind: "relaunch"; proxy: string; env: ProxyEnv; disclosure: string }
  | { kind: "refuse"; message: string };

const BRIDGE_SENTENCE =
  "This client speaks to HTTP proxies only. To use Tor or another SOCKS proxy, run an HTTP-to-SOCKS bridge and set proxy to the bridge's http:// address.";

// Throws with the whole refusal sentence. The accepted value is returned
// exactly as URL serializes its origin, so the comparison the child makes is
// between two strings this function produced.
export function parseProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`the proxy setting "${value}" is not a URL. It must look like http://host:port.`);
  }
  if (url.protocol.startsWith("socks")) {
    throw new Error(`the proxy setting "${value}" is a SOCKS address. ${BRIDGE_SENTENCE}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`the proxy setting "${value}" must start with http:// or https://. ${BRIDGE_SENTENCE}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("the proxy setting carries a user name or password, which this build does not support: it would be printed on every run. Use a proxy that needs none.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`the proxy setting "${value}" must be a bare address, http://host:port, with no path, query or fragment.`);
  }
  return url.origin;
}

export function formatProxyDisclosure(proxy: string): string {
  return `PROXY          : ${proxy} (file) -- every network request of this command goes through it. If it cannot be reached the command fails; nothing is ever sent direct.`;
}

export function buildChildEnv(parent: ProxyEnv, proxy: string): ProxyEnv {
  const env: ProxyEnv = { ...parent };
  for (const name of PROXY_BYPASS_VARIABLES) delete env[name];
  for (const name of PROXY_URL_VARIABLES) env[name] = proxy;
  env[PROXY_SWITCH] = "1";
  env[PROXY_CHILD_MARKER] = proxy;
  return env;
}

function environmentIsExact(env: ProxyEnv, proxy: string): boolean {
  if (env[PROXY_SWITCH] !== "1") return false;
  if (env[PROXY_CHILD_MARKER] !== proxy) return false;
  for (const name of PROXY_URL_VARIABLES) if (env[name] !== proxy) return false;
  for (const name of PROXY_BYPASS_VARIABLES) if (env[name] !== undefined) return false;
  return true;
}

// PURE given the file the argument vector names: reads the config file and
// the environment it is handed, launches nothing.
export function decideProxy(argv: string[], env: ProxyEnv): ProxyDecision {
  let configured: string | undefined;
  try {
    configured = loadConfigFile(resolveConfigPath(argv)).proxy;
  } catch (err) {
    // Fail-closed: a config file that cannot be read may name a proxy.
    return {
      kind: "refuse",
      message: `REFUSED: the config file could not be read, so this command cannot tell whether a proxy is configured: ${(err as Error).message}. Nothing was sent.`,
    };
  }
  if (configured === undefined) {
    if (env[PROXY_SWITCH] !== undefined || env[PROXY_CHILD_MARKER] !== undefined) {
      return {
        kind: "refuse",
        message: `REFUSED: ${PROXY_SWITCH} or ${PROXY_CHILD_MARKER} is set in the environment but no proxy is configured in the config file. This client takes its proxy from its config file only, never from the shell. Unset the variable, or set proxy in the config file. Nothing was sent.`,
      };
    }
    return { kind: "direct" };
  }
  let proxy: string;
  try {
    proxy = parseProxyUrl(configured);
  } catch (err) {
    return { kind: "refuse", message: `REFUSED: ${(err as Error).message} Nothing was sent.` };
  }
  if (environmentIsExact(env, proxy)) return { kind: "proceed", proxy };
  if (env[PROXY_CHILD_MARKER] !== undefined) {
    return {
      kind: "refuse",
      message: "REFUSED: this process was started to run through the proxy, but its environment does not carry the proxy settings exactly. It will not run direct. Nothing was sent.",
    };
  }
  return {
    kind: "relaunch",
    proxy,
    env: buildChildEnv(env, proxy),
    disclosure: formatProxyDisclosure(proxy),
  };
}

// Starts Node once more with the given arguments and environment, the three
// standard streams INHERITED so a typed CONFIRM reaches the child, and
// resolves to the child's exit status. A child ended by a signal reads as 1.
export function relaunchThroughProxy(nodeArgs: string[], env: ProxyEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
