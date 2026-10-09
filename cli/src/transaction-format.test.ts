// Tests for the transaction-format gate: the pure classifier over every shape
// a feature account can take, the refusal copy per shape, and the reader
// against a stub RPC returning each shape in turn. The bytes for the ACTIVE
// shape are the literal of record for devnet (base64
// AQCmWh0AAAAA: tag 1, activation slot 492,480,000), so the decode is pinned
// against something observed on-chain, not something this test invented.
//
// EVERY TEST NAME IS PREFIXED `transaction-format:` so it cannot collide with
// any other file's names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { address, type Address, type fetchEncodedAccount } from "@solana/kit";
import {
  classifyTransactionFormat,
  FEATURE_ACCOUNT_BYTES,
  FEATURE_PROGRAM,
  formatTransactionFormatRefusal,
  requireTransactionFormatActive,
  TRANSACTION_FORMAT_FEATURE,
} from "./transaction-format.js";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const DEVNET_ACTIVE_BASE64 = "AQCmWh0AAAAA";
const DEVNET_ACTIVATION_SLOT = 492_480_000n;

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

test("transaction-format: the feature address and the account size are the ones of record", () => {
  assert.equal(TRANSACTION_FORMAT_FEATURE, "txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL");
  assert.equal(FEATURE_PROGRAM, "Feature111111111111111111111111111111111111");
  assert.equal(FEATURE_ACCOUNT_BYTES, 9);
  assert.equal(bytes(DEVNET_ACTIVE_BASE64).length, FEATURE_ACCOUNT_BYTES);
});

test("transaction-format: the devnet literal of record decodes to tag 1 and activation slot 492,480,000, ACTIVE at or after that slot", () => {
  const data = bytes(DEVNET_ACTIVE_BASE64);
  assert.equal(data[0], 1);
  const at = classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data, slot: DEVNET_ACTIVATION_SLOT });
  assert.deepEqual(at, { kind: "active", activationSlot: DEVNET_ACTIVATION_SLOT });
  const after = classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data, slot: DEVNET_ACTIVATION_SLOT + 1n });
  assert.equal(after.kind, "active");
});

test("transaction-format: the same bytes one slot EARLY are SCHEDULED, not active", () => {
  const data = bytes(DEVNET_ACTIVE_BASE64);
  const early = classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data, slot: DEVNET_ACTIVATION_SLOT - 1n });
  assert.deepEqual(early, { kind: "scheduled", activationSlot: DEVNET_ACTIVATION_SLOT });
});

test("transaction-format: absent, funded (System-owned, zero bytes) and staged (tag 0) are each their own shape", () => {
  assert.deepEqual(classifyTransactionFormat({ exists: false, slot: 1n }), { kind: "absent" });
  assert.deepEqual(
    classifyTransactionFormat({ exists: true, owner: SYSTEM_PROGRAM, data: new Uint8Array(0), slot: 1n }),
    { kind: "funded" },
  );
  assert.deepEqual(
    classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data: new Uint8Array(9), slot: 1n }),
    { kind: "staged" },
  );
});

test("transaction-format: a wrong owner, a wrong length and a wrong tag are MALFORMED, never active", () => {
  const data = bytes(DEVNET_ACTIVE_BASE64);
  const wrongOwner = classifyTransactionFormat({ exists: true, owner: SYSTEM_PROGRAM, data, slot: DEVNET_ACTIVATION_SLOT });
  assert.equal(wrongOwner.kind, "malformed");
  const wrongLength = classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data: data.slice(0, 8), slot: DEVNET_ACTIVATION_SLOT });
  assert.equal(wrongLength.kind, "malformed");
  const wrongTag = new Uint8Array(data);
  wrongTag[0] = 2;
  const badTag = classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data: wrongTag, slot: DEVNET_ACTIVATION_SLOT });
  assert.equal(badTag.kind, "malformed");
  // Zero bytes under the FEATURE owner is not FUNDED: FUNDED is the System-owned shape.
  const emptyFeature = classifyTransactionFormat({ exists: true, owner: FEATURE_PROGRAM, data: new Uint8Array(0), slot: 1n });
  assert.equal(emptyFeature.kind, "malformed");
});

test("transaction-format: every refusal opens with REFUSED, names the cluster and the operation, and says nothing was sent", () => {
  const states = [
    { kind: "absent" } as const,
    { kind: "funded" } as const,
    { kind: "staged" } as const,
    { kind: "scheduled", activationSlot: 5n } as const,
    { kind: "malformed", reason: "tag byte 2" } as const,
  ];
  for (const state of states) {
    const msg = formatTransactionFormatRefusal({ state, cluster: "https://api.mainnet-beta.solana.com", operation: "unshielding" });
    assert.match(msg, /^REFUSED — https:\/\/api\.mainnet-beta\.solana\.com does not yet run the transaction format that unshielding needs: /);
    assert.match(msg, /Nothing was sent and no fee was paid\./);
    assert.doesNotMatch(msg, /--/);
  }
  assert.match(formatTransactionFormatRefusal({ state: { kind: "scheduled", activationSlot: 5n }, cluster: "c", operation: "o" }), /scheduled for slot 5, which this cluster has not reached/);
  assert.match(formatTransactionFormatRefusal({ state: { kind: "funded" }, cluster: "c", operation: "o" }), /never been allocated/);
});

// A stub RPC on the commands/unshield.test.ts precedent: getAccountInfo and
// getSlot each return a send() thunk.
function rpcFor(value: unknown, slot: bigint) {
  return {
    getAccountInfo: () => ({ send: async () => ({ value }) }),
    getSlot: () => ({ send: async () => slot }),
  } as unknown as Parameters<typeof fetchEncodedAccount>[0];
}
function accountInfo(owner: Address, b64: string) {
  return {
    data: [b64, "base64"],
    executable: false,
    lamports: 867_621n,
    owner,
    rentEpoch: 0n,
    space: BigInt(Buffer.from(b64, "base64").length),
  };
}

test("transaction-format: the reader returns the activation slot when ACTIVE and throws the refusal for every other shape", async () => {
  const common = { cluster: "https://api.devnet.solana.com", operation: "unshielding", commitment: "confirmed" as const };
  const active = await requireTransactionFormatActive({ ...common, rpc: rpcFor(accountInfo(FEATURE_PROGRAM, DEVNET_ACTIVE_BASE64), DEVNET_ACTIVATION_SLOT) as never });
  assert.equal(active, DEVNET_ACTIVATION_SLOT);
  await assert.rejects(
    requireTransactionFormatActive({ ...common, rpc: rpcFor(accountInfo(FEATURE_PROGRAM, DEVNET_ACTIVE_BASE64), DEVNET_ACTIVATION_SLOT - 1n) as never }),
    /has not reached/,
  );
  await assert.rejects(
    requireTransactionFormatActive({ ...common, rpc: rpcFor(null, DEVNET_ACTIVATION_SLOT) as never }),
    /does not exist on this cluster/,
  );
  await assert.rejects(
    requireTransactionFormatActive({ ...common, rpc: rpcFor(accountInfo(SYSTEM_PROGRAM, ""), DEVNET_ACTIVATION_SLOT) as never }),
    /never been allocated/,
  );
});
