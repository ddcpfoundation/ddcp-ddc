// Network-failure refusals at the entry (cause, risk and action, the
// standard for every refusal). The runtime reports every transport failure as a
// TypeError "fetch failed" whose cause chain names what failed; without this
// module that surfaced as a raw stack trace. One catch at the entry covers
// every command, and it reads the broadcast record of tx/broadcast.ts so a
// failure AFTER a send has begun is never reported as "nothing was sent".
//
// Which party failed. With a proxy in force this client only ever opens a
// connection to the proxy, so a connect-level cause (refused, host not found)
// is the proxy's; a proxy that answers but will not tunnel is the RPC
// endpoint's. With no proxy, every failure is the endpoint's.
//
// An endpoint that ANSWERS with an HTTP error status is not a fetch failure:
// the kit throws a SolanaError carrying the status. A proxy's own refusal
// surfaces as a tunnel refusal above, so an HTTP status is always the
// endpoint's answer, proxy or not.

import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, isSolanaError } from "@solana/kit";

export interface TransportFailure {
  /** The deepest message in the cause chain, one line. */
  readonly causeLine: string;
  /** True when a proxy answered but refused to open the tunnel. */
  readonly proxyAnswered: boolean;
  /** Set only when the endpoint answered with an HTTP error status. */
  readonly httpStatus?: number;
}

export interface BroadcastState {
  readonly begun: boolean;
  readonly signature: string | undefined;
}

const PROXY_TUNNEL_REFUSAL = /^Proxy response \(\d+\) !== 200 when HTTP Tunneling$/;
const MAX_CAUSE_DEPTH = 8;

/** Pure: the transport failure an error carries, or undefined for any other error. */
export function readTransportFailure(err: unknown): TransportFailure | undefined {
  if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const line = err.message.split("\n")[0] ?? err.message;
    return { causeLine: line, proxyAnswered: false, httpStatus: err.context.statusCode };
  }
  if (!(err instanceof TypeError) || err.message !== "fetch failed") return undefined;
  let deepest = "fetch failed";
  let proxyAnswered = false;
  let current: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      deepest = message.split("\n")[0] ?? message;
      if (PROXY_TUNNEL_REFUSAL.test(deepest)) proxyAnswered = true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return { causeLine: deepest, proxyAnswered };
}

/** Pure: the refusal printed for a transport failure. `proxy` is the address in force, if any. */
export function formatNetworkFailure(
  failure: TransportFailure,
  proxy: string | undefined,
  broadcast: BroadcastState,
): string {
  const lines: string[] = [];
  if (failure.httpStatus !== undefined) {
    lines.push(`NETWORK FAILURE -- the RPC endpoint answered with an error: ${failure.causeLine}`);
    lines.push(`The RPC endpoint refused or failed the request with HTTP status ${failure.httpStatus}.`);
  } else if (proxy === undefined) {
    lines.push(`NETWORK FAILURE -- the connection failed: ${failure.causeLine}`);
    lines.push("The RPC endpoint could not be reached.");
  } else if (failure.proxyAnswered) {
    lines.push(`NETWORK FAILURE -- the connection failed: ${failure.causeLine}`);
    lines.push(`The proxy at ${proxy} answered but could not reach the RPC endpoint.`);
  } else {
    lines.push(`NETWORK FAILURE -- the connection failed: ${failure.causeLine}`);
    lines.push(`The proxy at ${proxy} could not be reached. No request went direct.`);
  }
  if (!broadcast.begun) {
    lines.push("Nothing was sent: this command had not broadcast a transaction when the connection failed.");
    if (failure.httpStatus !== undefined) {
      lines.push("Check the endpoint address (--rpc-url, or rpc_url in the config file) and whether the endpoint requires an access key or limits the request rate, then run the command again.");
    } else if (proxy !== undefined && !failure.proxyAnswered) {
      lines.push("Start the proxy, or remove the proxy setting from the config file, then run the command again.");
    } else {
      lines.push("Check the endpoint address (--rpc-url, or rpc_url in the config file) and the network connection, then run the command again.");
    }
    return lines.join("\n");
  }
  if (broadcast.signature === undefined) {
    lines.push("A transaction was being handed to the network when the connection failed, and no signature came back, so this client cannot tell whether it arrived. It may have landed.");
  } else {
    lines.push(`A transaction was sent before the connection failed, signature ${broadcast.signature}. It may have landed.`);
  }
  lines.push("Do NOT run the command again until you have checked: read the account with ddc balance or ddc state once the connection is back, or look the signature up in a block explorer. Running it again blindly can move funds, or pay fees, twice.");
  return lines.join("\n");
}
