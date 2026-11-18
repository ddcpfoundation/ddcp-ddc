// Reads and checks shared by the holder operations: the holder's token
// account, the key check that precedes every decryption, and the one check
// every sending operation makes immediately before it sends.

import { fetchEncodedAccount, getAddressDecoder, type Address, type Signature } from "@solana/kit";
import { decodeToken, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  readConfidentialTransferAccount,
  type ConfidentialTransferAccountExtension,
} from "../confidential-account.js";
import { checkBalanceCopy, decryptDecryptableBalance, type BalanceCopyCheck } from "../confidential-balance.js";
import { deriveConfidentialKeys, type DerivedConfidentialKeys } from "../confidential-keys.js";
import { TOKEN_2022_PROGRAM } from "../program-addresses.js";
import { classifyTransactionFormat, TRANSACTION_FORMAT_FEATURE } from "../transaction-format.js";
import type { HolderContext, HolderSigner } from "./context.js";
import { HolderRefusal } from "./refusal.js";

/** The associated token account of `owner` for the context's mint. */
export async function holderTokenAccount(ctx: HolderContext, owner: Address): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({ owner, tokenProgram: TOKEN_2022_PROGRAM, mint: ctx.mint });
  return tokenAccount;
}

/** One read of a token account, decoded; `exists` false when it is absent. */
export async function readTokenAccount(ctx: HolderContext, tokenAccount: Address) {
  return decodeToken(await fetchEncodedAccount(ctx.rpc, tokenAccount, { commitment: ctx.commitment }));
}

/** One read of a token account's confidential extension; undefined when absent or not configured. */
export async function readConfidentialExtension(
  ctx: HolderContext,
  tokenAccount: Address,
): Promise<ConfidentialTransferAccountExtension | undefined> {
  return readConfidentialTransferAccount(await readTokenAccount(ctx, tokenAccount));
}

/**
 * Derive the confidential-account keys from the signer (one signature over the
 * standard message) and refuse unless they match the key stored on the account.
 */
export async function deriveMatchingKeys(
  signer: HolderSigner,
  onChainKey: Address,
): Promise<DerivedConfidentialKeys> {
  const keys = await deriveConfidentialKeys({ signer });
  const derived = getAddressDecoder().decode(keys.elgamalPublicKey);
  if (derived !== onChainKey) {
    throw new HolderRefusal({ kind: "key-mismatch", onChainKey, derivedKey: derived });
  }
  return keys;
}

/** What a sending operation read, and the send-time check compares against. */
export interface AccountSnapshot {
  readonly tokenAccount: Address;
  /** The pending credit counter as read. */
  readonly pendingBalanceCreditCounter: bigint;
  /** The encrypted available balance as read, byte for byte. */
  readonly availableBalance: Uint8Array;
}

export function snapshotOf(tokenAccount: Address, extension: ConfidentialTransferAccountExtension): AccountSnapshot {
  return {
    tokenAccount,
    pendingBalanceCreditCounter: extension.pendingBalanceCreditCounter,
    availableBalance: new Uint8Array(extension.availableBalance),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (const [i, byte] of a.entries()) {
    if (byte !== b[i]) return false;
  }
  return true;
}

/**
 * THE SEND-TIME CHECK, one for every sending operation: a fresh read of the
 * account against what the operation read before it built its figures, made
 * immediately before the transaction is built and sent.
 *
 * `counter` is true for shield and apply-pending, which fold the pending
 * balance and write a balance copy computed from it: a moved counter makes
 * that copy short. unshield and confidential-transfer pass false: an incoming
 * credit lands in pending and changes nothing they rely on, and refusing on it
 * would let anyone block a holder's sends with a stream of small credits. Every
 * operation refuses when the encrypted available balance changed, since its
 * figures, its copy and its proofs were computed from it.
 */
export async function requireUnchangedBeforeSend(
  ctx: HolderContext,
  snapshot: AccountSnapshot,
  options: { readonly counter: boolean },
): Promise<void> {
  const fresh = await readConfidentialExtension(ctx, snapshot.tokenAccount);
  if (fresh === undefined) {
    throw new HolderRefusal(
      options.counter ? { kind: "extension-vanished", tokenAccount: snapshot.tokenAccount } : { kind: "available-moved" },
    );
  }
  if (options.counter && fresh.pendingBalanceCreditCounter !== snapshot.pendingBalanceCreditCounter) {
    throw new HolderRefusal({
      kind: "counter-moved",
      atRead: snapshot.pendingBalanceCreditCounter,
      atSend: fresh.pendingBalanceCreditCounter,
    });
  }
  if (!sameBytes(new Uint8Array(fresh.availableBalance), snapshot.availableBalance)) {
    throw new HolderRefusal({ kind: "available-moved" });
  }
}

/** The balance copy read back after a confirmed send. */
export type CopyReadBack =
  | { readonly kind: "consistent" }
  | {
      readonly kind: "mismatch";
      readonly expected: bigint;
      readonly actual: bigint;
      readonly check: Exclude<BalanceCopyCheck, { kind: "consistent" }>;
    };

/**
 * POST-SEND READ-BACK: the copy now on the account against the encrypted
 * balance, off one decode. The chain compares neither the counters nor the
 * copy; a credit that landed between the read and execution, or another
 * command run at the same time, leaves the copy short.
 */
export async function readBackCopy(
  ctx: HolderContext,
  input: { readonly tokenAccount: Address; readonly keys: DerivedConfidentialKeys; readonly signature: Signature },
): Promise<CopyReadBack> {
  const after = await readConfidentialExtension(ctx, input.tokenAccount);
  if (after === undefined) {
    throw new HolderRefusal({ kind: "extension-gone-after-send", signature: input.signature, tokenAccount: input.tokenAccount });
  }
  const copy = decryptDecryptableBalance(
    new Uint8Array(input.keys.aeKey),
    new Uint8Array(after.decryptableAvailableBalance),
  );
  const check: BalanceCopyCheck = copy.readable
    ? checkBalanceCopy(new Uint8Array(input.keys.elgamalSecretKey), new Uint8Array(after.availableBalance), copy.baseUnits)
    : { kind: "unreadable" };
  if (check.kind === "consistent") return { kind: "consistent" };
  return {
    kind: "mismatch",
    expected: after.expectedPendingBalanceCreditCounter,
    actual: after.actualPendingBalanceCreditCounter,
    check,
  };
}

/**
 * FORMAT GATE: unshield and confidential-transfer are version-1 transactions
 * and have no other shape; refuse unless the format is active on the cluster.
 */
export async function requireTransactionFormat(ctx: HolderContext): Promise<void> {
  const [account, slot] = await Promise.all([
    fetchEncodedAccount(ctx.rpc, TRANSACTION_FORMAT_FEATURE, { commitment: ctx.commitment }),
    ctx.rpc.getSlot({ commitment: ctx.commitment }).send(),
  ]);
  const state = classifyTransactionFormat(
    account.exists ? { exists: true, owner: account.programAddress, data: account.data, slot } : { exists: false, slot },
  );
  if (state.kind !== "active") {
    throw new HolderRefusal({ kind: "transaction-format-inactive", state });
  }
}
