// `ddc unshield <amount>` — move a stated amount from the wallet's
// CONFIDENTIAL balance to its PUBLIC balance. THE USER WORD IS
// `unshield`; THE INSTRUCTION IS `Withdraw`, ConfidentialTransferInstruction
// 6, and the two never mix in user copy.
//
// ORDER, on the shield pattern: shape → target block →
// cluster guard → identity → format gate → token account → live read →
// activation stop → approval stop → derive → key mismatch → decrypt →
// sufficiency → proofs → announcement → CONFIRM → re-read → ONE send → read
// back.
//
// ONE TRANSACTION, NOT FIVE. Both proofs are verified inline in
// the same version-1 transaction as the withdraw (tx/unshield-tx.ts). Three
// consequences the copy carries: one signature, so the shared NETWORK_FEE_LINE
// is true here and this command states no bound of its own; no stored-result
// account, so no rent is locked and nothing can be orphaned; and no
// half-success, so there is no recovery path and no post-failure outcome to
// read — `broadcastAndConfirm` throws on a preflight refusal or an on-chain
// error, and either means nothing moved; it also throws when its confirmation
// poll runs out, and then the transaction may still land.
//
// THE FORMAT GATE IS NETWORK STATE. The transaction has no legacy shape, so
// on a cluster that has not activated the version-1 format the send cannot
// succeed. The gate is read on-chain, on the stated cluster, as the first live
// read, and refuses by name (transaction-format.ts). It is not a calendar.
//
// THE RE-READ BEFORE THE SEND. The processor subtracts amount·G from the
// account's own available-balance ciphertext and requires BYTE equality with
// the ciphertext the equality proof was built over. The holder can sit at the
// CONFIRM prompt for as long as they like, and a credit applied meanwhile makes
// the proofs stale. Preflight would refuse such a transaction with no fee
// paid; the re-read turns that refusal into this command's own sentence and
// costs one account read.
import { EXIT_NOT_DONE, type CommandOutcome } from "../exit-status.js";
import { parseArgs } from "node:util";
import { getTransactionEncoder, type Signature } from "@solana/kit";
import {
  formatTargetBlock,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
  type ConfigSource,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { NETWORK_FEE_LINE } from "../announcements.js";
import { DDC_DECIMALS, formatDdcAmount, parseDdcAmount } from "../amount.js";
import {
  CONFIRM_ABORTED_BEFORE_SEND,
  promptTypedConfirm,
  TYPED_CONFIRM_QUESTION,
  type ConfirmPrompt,
} from "../confirm-prompt.js";
import { formatTransactionFormatRefusal } from "../transaction-format.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { prepareUnshield, sendUnshield } from "../holder/unshield.js";
import type { HolderRefusalReason } from "../holder/refusal.js";
import { withRefusalText } from "../holder-refusal-text.js";

export const UNSHIELD_USAGE =
  "unshield: usage — unshield <amount> --keypair <path> --rpc-url <url>";

/** Named in the cluster and format refusals; names the OPERATION, never a flag this command does not have. */
export const UNSHIELD_OPERATION =
  "unshielding from your confidential balance (one signed, fee-paying transaction)";

export const UNSHIELD_UNCONFIGURED_STOP =
  "Nothing to unshield — Confidential Balances is not activated on this account, so there is no confidential balance to unshield from. No transaction was sent and no fee was paid. Run ddc setup-privacy to activate (strongly recommended).";

/** process_withdraw requires valid_as_source(), which is approved(). */
export const UNSHIELD_UNAPPROVED_STOP =
  "REFUSED — this account is not approved for confidential transfers, and the network refuses a withdraw from an unapproved account. Nothing was sent and no fee was paid.";

/** Exactly one decimal positional; a zero amount is a usage error naming the smallest amount. */
export function parseUnshieldAmount(positionals: readonly string[]): bigint {
  if (positionals.length !== 1) {
    throw new Error(
      `${UNSHIELD_USAGE}\nunshield takes exactly one amount; got ${positionals.length} positional arguments`,
    );
  }
  const text = positionals[0] as string;
  let baseUnits: bigint;
  try {
    baseUnits = parseDdcAmount(text);
  } catch (err) {
    throw new Error(`${UNSHIELD_USAGE}\n${(err as Error).message}`);
  }
  if (baseUnits === 0n) {
    throw new Error(
      `${UNSHIELD_USAGE}\nthe amount must be at least 0.000001 DDC; got ${text}`,
    );
  }
  return baseUnits;
}

export function formatUnshieldHeader(amountBaseUnits: bigint): string {
  return `UNSHIELD — moving ${formatDdcAmount(amountBaseUnits)} DDC from your confidential balance into your public balance`;
}

export function formatInsufficientConfidentialRefusal(input: {
  amountBaseUnits: bigint;
  confidentialBaseUnits: bigint;
}): string {
  return (
    `REFUSED — ${formatDdcAmount(input.amountBaseUnits)} DDC is more than the ${formatDdcAmount(input.confidentialBaseUnits)} DDC your confidential balance reads. ` +
    "Nothing was sent and no fee was paid. Restate a smaller amount."
  );
}

/** Pre-send: the account's available-balance ciphertext is not the one the proofs were built over. */
export function formatBalanceMovedRefusal(): string {
  return (
    "REFUSED — your confidential balance changed while this command was running, so the proofs it built no longer describe this account. " +
    "Cause: a confidential credit was applied, or another client moved funds, between this command's read and its send. " +
    "Nothing was sent and no fee was paid. Run ddc unshield again."
  );
}

export function formatUnshieldAnnouncement(input: {
  amountBaseUnits: bigint;
  confidentialAfterBaseUnits: bigint;
  publicAfterBaseUnits: bigint;
  cluster: string;
  clusterSource: ConfigSource;
}): string {
  return [
    formatUnshieldHeader(input.amountBaseUnits),
    `● confidential after : ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC`,
    `○ public after : ${formatDdcAmount(input.publicAfterBaseUnits)} DDC`,
    NETWORK_FEE_LINE,
    `cluster : ${input.cluster} (${input.clusterSource})`,
  ].join("\n");
}

export function formatUnshieldSuccess(input: {
  signature: Signature;
  amountBaseUnits: bigint;
  confidentialAfterBaseUnits: bigint;
  publicAfterBaseUnits: bigint;
}): string {
  return (
    `UNSHIELD CONFIRMED — signature ${input.signature}; ${formatDdcAmount(input.amountBaseUnits)} DDC unshielded; ` +
    `your confidential balance now reads ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC and your public balance ${formatDdcAmount(input.publicAfterBaseUnits)} DDC.`
  );
}

/**
 * After a send that threw. The transaction is atomic: an on-chain error means
 * nothing moved; a confirmation that never arrived means the chain must be
 * read before anything is retried. One line, claiming only that.
 */
export const UNSHIELD_AFTER_FAILED_SEND =
  "The transaction is atomic: if the network reported an error, nothing moved between your balances. If no confirmation arrived, run ddc balance before retrying.";

export interface UnshieldDeps {
  /** The typed-CONFIRM gate; tests inject a stub. */
  promptConfirm?: ConfirmPrompt;
}

export async function runUnshield(
  argv: string[],
  deps: UnshieldDeps = {},
): Promise<CommandOutcome> {
  const promptConfirm = deps.promptConfirm ?? promptTypedConfirm;
  const config = resolveConfig(argv);
  // SHAPE BEFORE IDENTITY: the amount is validated before --keypair is read.
  const { positionals } = parseArgs({
    args: argv,
    options: {
      "rpc-url": { type: "string" },
      config: { type: "string" },
      mint: { type: "string" },
      program: { type: "string" },
      keypair: { type: "string" },
      role: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  const amountBaseUnits = parseUnshieldAmount(positionals.slice(1));
  console.log(formatTargetBlock(config));
  requireStatedCluster(config, UNSHIELD_OPERATION);
  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const rpc = createRpc(config.rpcUrl);
  const ctx = { rpc, commitment: config.commitment, mint: config.mint, decimals: DDC_DECIMALS };
  return withRefusalText(async () => {
    const plan = await prepareUnshield(ctx, { signer, amountBaseUnits });
    if (plan.kind === "not-activated") {
      console.log(UNSHIELD_UNCONFIGURED_STOP);
      return EXIT_NOT_DONE;
    }
    console.log(
      formatUnshieldAnnouncement({
        amountBaseUnits,
        confidentialAfterBaseUnits: plan.confidentialAfterBaseUnits,
        publicAfterBaseUnits: plan.publicAfterBaseUnits,
        cluster: config.rpcDisplay,
        clusterSource: config.source.rpcUrl,
      }),
    );
    // CONFIRM: read once, after the announcement, before the send. Anything
    // but the exact word aborts with nothing sent.
    if (!(await promptConfirm(TYPED_CONFIRM_QUESTION))) {
      console.log(CONFIRM_ABORTED_BEFORE_SEND);
      return EXIT_NOT_DONE;
    }
    // THE SEND-TIME CHECK runs first inside sendUnshield: byte equality
    // against the ciphertext the proofs were built over.
    const result = await sendUnshield(ctx, plan, {
      signer,
      beforeSubmit: (transaction) =>
        console.log(`UNSHIELD wire size : ${getTransactionEncoder().encode(transaction).length} bytes`),
      submit: async (wire) => {
        try {
          return await broadcastAndConfirm(rpc, wire, config.commitment, "UNSHIELD");
        } catch (err) {
          console.log((err as Error).message);
          console.log(UNSHIELD_AFTER_FAILED_SEND);
          throw err;
        }
      },
    });
    console.log(
      formatUnshieldSuccess({
        signature: result.signature,
        amountBaseUnits,
        confidentialAfterBaseUnits: result.confidentialAfterBaseUnits,
        publicAfterBaseUnits: result.publicAfterBaseUnits,
      }),
    );
  }, unshieldRefusalText(config.rpcDisplay));
}

/** The sentences `unshield` words itself. */
function unshieldRefusalText(cluster: string): (reason: HolderRefusalReason) => string | undefined {
  return (reason) => {
    switch (reason.kind) {
      case "transaction-format-inactive":
        return formatTransactionFormatRefusal({ state: reason.state, cluster, operation: UNSHIELD_OPERATION });
      case "account-unapproved":
        return UNSHIELD_UNAPPROVED_STOP;
      case "insufficient-confidential-for-unshield":
        return formatInsufficientConfidentialRefusal({
          amountBaseUnits: reason.amountBaseUnits,
          confidentialBaseUnits: reason.confidentialBaseUnits,
        });
      case "available-moved":
        return formatBalanceMovedRefusal();
      default:
        return undefined;
    }
  };
}
