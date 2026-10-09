// Shared single-shot broadcast + bounded confirmation poll: the CLI's only
// call to sendTransaction, used by every command that sends.
// Behavior: preflight ON, maxRetries 0n, single shot (the SEND is never
// retried), 30 x 2s status polls each printed verbatim. Post-confirm reads
// (supply/ATA for submit, nonce for cancel) stay with the callers.

import { setTimeout as sleep } from "node:timers/promises";
import type {
  Base64EncodedWireTransaction,
  Commitment,
  Signature,
} from "@solana/kit";
import type { SolanaRpc } from "../rpc.js";

const DEFAULT_STATUS_POLL_ATTEMPTS = 30;

/**
 * Process-wide record of the one send a command makes, read by the entry's
 * network-failure refusal (network-failure.ts): once `begun` is set, a later
 * transport failure is never reported as "nothing was sent". Set BEFORE the
 * send call, since a connection lost during the call leaves delivery unknown.
 */
export const broadcastRecord: { begun: boolean; signature: string | undefined } = {
  begun: false,
  signature: undefined,
};
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;

/** The two ways a send that was accepted can fail, carried for the entry's refusal (send-failure.ts). */
export type BroadcastFailureDetail =
  | { readonly kind: "on-chain"; readonly signature: string; readonly errJson: string }
  | { readonly kind: "unconfirmed"; readonly signature: string; readonly attempts: number; readonly intervalMs: number };

/**
 * Thrown by broadcastAndConfirm on an on-chain err and on poll exhaustion.
 * The message is the one callers have always printed; `detail` carries the
 * same facts as data so the entry never parses the message.
 */
export class BroadcastFailure extends Error {
  constructor(message: string, readonly detail: BroadcastFailureDetail) {
    super(message);
    this.name = "BroadcastFailure";
  }
}

/** JSON.stringify that survives the bigints in kit RPC responses. */
export function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/**
 * Single-shot send of an already-signed wire transaction, then a bounded
 * confirmation poll. `label` preserves the calling command's wording
 * ("SUBMIT"/"CANCEL") in the on-chain-failure error. Throws a
 * BroadcastFailure on an on-chain err and on poll exhaustion (naming the
 * signature); returns the confirmed signature. `poll` defaults to 30 x 2s
 * and is overridden only by tests.
 */
export async function broadcastAndConfirm(
  rpc: SolanaRpc,
  base64Wire: Base64EncodedWireTransaction,
  commitment: Commitment,
  label: string,
  poll: { readonly attempts: number; readonly intervalMs: number } = {
    attempts: DEFAULT_STATUS_POLL_ATTEMPTS,
    intervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
  },
): Promise<Signature> {
  const STATUS_POLL_ATTEMPTS = poll.attempts;
  const STATUS_POLL_INTERVAL_MS = poll.intervalMs;
  console.log("BROADCASTING   : single-shot send, preflight ON, no auto-retry");
  broadcastRecord.begun = true;
  const signature = await rpc
    .sendTransaction(base64Wire, {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: commitment,
      maxRetries: 0n,
    })
    .send();
  broadcastRecord.signature = signature;
  console.log(`signature      : ${signature}`);

  for (let i = 1; i <= STATUS_POLL_ATTEMPTS; i += 1) {
    await sleep(STATUS_POLL_INTERVAL_MS);
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0] ?? null;
    console.log(
      `status poll ${i}/${STATUS_POLL_ATTEMPTS}: ${jsonWithBigints(status)}`,
    );
    if (status?.err != null) {
      const errJson = jsonWithBigints(status.err);
      throw new BroadcastFailure(
        `${label} FAILED on-chain: ${errJson} (signature ${signature})`,
        { kind: "on-chain", signature, errJson },
      );
    }
    const confirmationStatus = status?.confirmationStatus;
    if (
      confirmationStatus === "confirmed" ||
      confirmationStatus === "finalized"
    ) {
      return signature;
    }
  }
  throw new BroadcastFailure(
    `broadcast not confirmed after ${STATUS_POLL_ATTEMPTS} polls — signature ${signature}; re-ground before ANY retry`,
    { kind: "unconfirmed", signature, attempts: STATUS_POLL_ATTEMPTS, intervalMs: STATUS_POLL_INTERVAL_MS },
  );
}
