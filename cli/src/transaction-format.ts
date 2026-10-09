// The version-1 transaction format is a NETWORK feature, not a property of
// this build. A command whose transaction has no legacy shape — `unshield`,
// whose three instructions encode 386 bytes past the legacy limit — cannot
// run on a cluster that has not activated it, and the failure would otherwise
// arrive from the RPC after the holder typed CONFIRM. So the gate is read
// on-chain, on the stated cluster, before the first live read of the holder's
// account, and the refusal names the cluster.
//
// THE FOUR SHAPES OF A FEATURE ACCOUNT: ABSENT (no account); FUNDED
// (System-owned, zero bytes — lamports parked, never allocated, and a feature
// cannot activate from it); STAGED (Feature-owned, nine bytes, tag byte zero —
// allocated, activation not yet written); ACTIVE (tag byte one, activation slot
// at or below the slot read). A tag of one with an activation slot ABOVE the
// slot read is SCHEDULED: the runtime has written the slot but not reached it.
// Only ACTIVE passes.
//
// CLASSIFICATION IS PURE and takes the bytes and the slot as read, so the
// sibling test exercises every shape offline; the RPC read is the thin
// function beneath it.

import { address, fetchEncodedAccount, type Address, type Commitment } from "@solana/kit";
import { SYSTEM_PROGRAM } from "./constants.js";
import type { SolanaRpc } from "./rpc.js";

/** Feature gate `txv1aq4pp…` (SIMD-0385, the version-1 transaction format). */
export const TRANSACTION_FORMAT_FEATURE: Address = address(
  "txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL",
);

/** Owner of an allocated feature account. */
export const FEATURE_PROGRAM: Address = address(
  "Feature111111111111111111111111111111111111",
);

/** An allocated feature account: one tag byte, then a u64 activation slot. */
export const FEATURE_ACCOUNT_BYTES = 9;

export type TransactionFormatState =
  | { kind: "absent" }
  | { kind: "funded" }
  | { kind: "staged" }
  | { kind: "scheduled"; activationSlot: bigint }
  | { kind: "active"; activationSlot: bigint }
  | { kind: "malformed"; reason: string };

/** Pure: sort a feature account read into the shapes above, against the slot read beside it. */
export function classifyTransactionFormat(input: {
  exists: boolean;
  owner?: Address;
  data?: Uint8Array;
  slot: bigint;
}): TransactionFormatState {
  if (!input.exists) return { kind: "absent" };
  const data = input.data ?? new Uint8Array(0);
  if (input.owner === SYSTEM_PROGRAM && data.length === 0) return { kind: "funded" };
  if (input.owner !== FEATURE_PROGRAM) {
    return { kind: "malformed", reason: `owner ${input.owner} is not the Feature program` };
  }
  if (data.length !== FEATURE_ACCOUNT_BYTES) {
    return { kind: "malformed", reason: `${data.length} data bytes, not ${FEATURE_ACCOUNT_BYTES}` };
  }
  const tag = data[0];
  if (tag === 0) return { kind: "staged" };
  if (tag !== 1) return { kind: "malformed", reason: `tag byte ${tag}` };
  const activationSlot = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
  return activationSlot <= input.slot
    ? { kind: "active", activationSlot }
    : { kind: "scheduled", activationSlot };
}

/** The refusal, one sentence per shape, naming the cluster and the operation and claiming nothing was sent. */
export function formatTransactionFormatRefusal(input: {
  state: Exclude<TransactionFormatState, { kind: "active" }>;
  cluster: string;
  operation: string;
}): string {
  const why = (() => {
    switch (input.state.kind) {
      case "absent":
        return "the feature account does not exist on this cluster";
      case "funded":
        return "the feature account is funded but has never been allocated, so no activation is scheduled";
      case "staged":
        return "the feature account is allocated but no activation slot has been written";
      case "scheduled":
        return `activation is scheduled for slot ${input.state.activationSlot}, which this cluster has not reached`;
      case "malformed":
        return `the feature account is not in a known shape (${input.state.reason})`;
    }
  })();
  return (
    `REFUSED — ${input.cluster} does not yet run the transaction format that ${input.operation} needs: ${why}. ` +
    "Nothing was sent and no fee was paid. Try again once the format is active on this cluster."
  );
}

/**
 * Read the feature account and the current slot on the stated cluster and
 * refuse unless the format is ACTIVE. Returns the activation slot on success.
 */
export async function requireTransactionFormatActive(input: {
  rpc: SolanaRpc;
  commitment: Commitment;
  cluster: string;
  operation: string;
}): Promise<bigint> {
  const [account, slot] = await Promise.all([
    fetchEncodedAccount(input.rpc, TRANSACTION_FORMAT_FEATURE, { commitment: input.commitment }),
    input.rpc.getSlot({ commitment: input.commitment }).send(),
  ]);
  const state = classifyTransactionFormat(
    account.exists
      ? { exists: true, owner: account.programAddress, data: account.data, slot }
      : { exists: false, slot },
  );
  if (state.kind === "active") return state.activationSlot;
  throw new Error(formatTransactionFormatRefusal({ state, cluster: input.cluster, operation: input.operation }));
}
