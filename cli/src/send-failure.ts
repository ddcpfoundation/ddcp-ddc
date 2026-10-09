// Send failures at the entry (cause, risk and action, the standard for every
// refusal). Three shapes printed a raw stack before:
// an RPC endpoint refusing the transaction at its preflight simulation, a
// transaction that executed and failed on-chain, and a confirmation poll that
// ran out. The last two are thrown by tx/broadcast.ts as a BroadcastFailure
// carrying its facts as data; the first is the kit's own SolanaError. The
// entry tries the transport reader of network-failure.ts first, then this one,
// and rethrows anything neither recognizes. The two readers are disjoint.
//
// What each shape means for the holder. A preflight refusal means the
// endpoint simulated the transaction and did not forward it, so this attempt
// moved nothing and cost no fee; the one exception worth naming is a
// transaction the network reports as already processed, which means an
// earlier send of these exact bytes landed. An on-chain failure is atomic: it
// moved nothing, and the network fee was charged. An exhausted poll proves
// nothing either way, so the refusal says the transaction may still land.

import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  isSolanaError,
} from "@solana/kit";
import { BroadcastFailure, type BroadcastFailureDetail } from "./tx/broadcast.js";

export type SendFailure =
  | { readonly kind: "preflight"; readonly causeLine: string; readonly alreadyProcessed: boolean }
  | BroadcastFailureDetail;

const MAX_CAUSE_DEPTH = 8;

/** Pure: the send failure an error carries, or undefined for any other error. */
export function readSendFailure(err: unknown): SendFailure | undefined {
  if (err instanceof BroadcastFailure) return err.detail;
  if (!isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return undefined;
  let causeLine = err.message.split("\n")[0] ?? err.message;
  let alreadyProcessed = false;
  let current: unknown = err.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (isSolanaError(current, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) alreadyProcessed = true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) causeLine = message.split("\n")[0] ?? message;
    current = (current as { cause?: unknown }).cause;
  }
  return { kind: "preflight", causeLine, alreadyProcessed };
}

/** Pure: the refusal printed for a send failure. */
export function formatSendFailure(failure: SendFailure): string {
  const lines: string[] = [];
  switch (failure.kind) {
    case "preflight":
      lines.push(`TRANSACTION REFUSED -- the RPC endpoint simulated the transaction before sending it, and the simulation failed: ${failure.causeLine}`);
      lines.push("This attempt was not forwarded to the network: it moved nothing and no fee was charged.");
      if (failure.alreadyProcessed) {
        lines.push("The network reports these exact transaction bytes as already processed: an earlier send of this transaction landed. Do NOT send it again; read the account with ddc balance or ddc state.");
      } else {
        lines.push("Read the account with ddc balance or ddc state, and resolve the cause above, before running the command again.");
      }
      break;
    case "on-chain":
      lines.push(`TRANSACTION FAILED -- the transaction reached the network and failed there: ${failure.errJson}`);
      lines.push(`Signature ${failure.signature}. A failed transaction is atomic: it moved nothing, but the network fee was charged.`);
      lines.push("Read the account with ddc balance or ddc state, and resolve the cause above, before running the command again.");
      break;
    case "unconfirmed":
      lines.push(`TRANSACTION NOT CONFIRMED -- no confirmation after ${failure.attempts} status checks, ${failure.intervalMs / 1000} seconds apart.`);
      lines.push(`Signature ${failure.signature}. It was sent, and it may still land.`);
      lines.push("Do NOT run the command again until you have checked: look the signature up in a block explorer, or read the account with ddc balance or ddc state after a minute or two. Running it again blindly can move funds, or pay fees, twice.");
      break;
  }
  return lines.join("\n");
}
