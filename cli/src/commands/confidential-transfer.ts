// 'ddc confidential-transfer <amount> <recipient>' -- send a stated amount from the
// wallet's CONFIDENTIAL balance to a recipient's confidential (pending)
// balance. THE USER WORD IS 'confidential-transfer'; THE
// INSTRUCTION IS 'TransferWithFee', ConfidentialTransferInstruction 13, and
// the two never mix in user copy.
//
// THE AMOUNT IS WHAT THE RECIPIENT RECEIVES. The fee under
// the schedule in force is added on top and the sender's confidential
// balance is debited by gross = net + fee; tx/transfer-fee-gross.ts finds
// the gross, tx/transfer-fee-split.ts states the fee, and the announcement
// shows all of it before CONFIRM.
//
// THE RECIPIENT IS A WALLET ADDRESS; its token account
// is derived. This command sends ONLY to a recipient whose account is
// activated and approved for confidential credits: every other recipient
// state refuses by name, and there is no public fallback (a public payment
// is another command's). This command NEVER
// applies pending credits: when the sender has any it says
// so and names ddc apply-pending.
//
// ORDER, on the unshield pattern with the transfer's own insertions:
// shape -> target block -> cluster guard -> identity -> self-transfer ->
// format gate -> source read -> activation stop -> approval stop -> derive
// -> key mismatch -> decrypt -> pending note -> mint read (schedules, two
// keys) -> epoch -> courtesy headroom -> gross -> sufficiency -> PDA-1
// minimum fee -> destination read -> proofs -> announcement -> CONFIRM ->
// re-read source -> re-read mint and epoch, load-bearing headroom -> ONE
// send -> after-miss mapping -> read back.
//
// TWO HEADROOM CHECKS: the courtesy one
// before proof generation, so a refusal already known costs no wait; the
// load-bearing one after CONFIRM and before the blockhash, so the 1,000-slot
// margin covers fetch-to-land however long the human sat at the prompt. The
// mint is fetched fresh both times and decoded twice on the same bytes;
// the second read must also show the SAME schedule
// parameters the proofs were built under, or the command refuses.
//
// THE AFTER-MISS MAPPING IS BY EVIDENCE, NOT BY CODE:
// broadcast.ts throws a plain Error on preflight or poll rejection with no
// stable typed code, so on any throw from the send the mint is re-read and
// SCHEDULE_CHANGED_IN_FLIGHT is printed only when its parameters differ
// from the schedule proven under.
import { EXIT_NOT_DONE, type CommandOutcome } from "../exit-status.js";
import { parseArgs } from "node:util";
import { getTransactionEncoder, type Address, type Signature } from "@solana/kit";
import { type Mint } from "@solana-program/token-2022";
import {
  formatTargetBlock,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
  type ConfigSource,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { formatFeeLine, NETWORK_FEE_LINE } from "../announcements.js";
import { parseTransferPositionals } from "../transfer-args.js";
import { formatDdcAmount } from "../amount.js";
import {
  CONFIRM_ABORTED_BEFORE_SEND,
  promptTypedConfirm,
  TYPED_CONFIRM_QUESTION,
  type ConfirmPrompt,
} from "../confirm-prompt.js";
import { formatTransactionFormatRefusal } from "../transaction-format.js";
import { SCHEDULE_CHANGED_IN_FLIGHT, scheduleStillOnMint } from "../tx/schedule-headroom.js";
import type { TransferFeeSchedule, TransferFeeSplit } from "../tx/transfer-fee-split.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import {
  prepareConfidentialTransfer,
  readMintTransferKeys,
  readTransferMint,
  sendConfidentialTransfer,
} from "../holder/confidential-transfer.js";
import { HolderRefusal, type HolderRefusalReason } from "../holder/refusal.js";
import { withRefusalText } from "../holder-refusal-text.js";

const EM_DASH = String.fromCharCode(0x2014);

export const CONFIDENTIAL_TRANSFER_USAGE =
  "confidential-transfer: usage " + EM_DASH + " confidential-transfer <amount> <recipient-wallet> --keypair <path> --rpc-url <url>";
/** Named in the cluster and format refusals; names the OPERATION, never a flag this command does not have. */
export const CONFIDENTIAL_TRANSFER_OPERATION =
  "transferring from your confidential balance (one signed, fee-paying transaction)";
export const CONFIDENTIAL_TRANSFER_UNCONFIGURED_STOP =
  "Nothing to transfer " + EM_DASH + " Confidential Balances is not activated on this account, so there is no confidential balance to transfer from. No transaction was sent and no fee was paid. Run ddc setup-privacy to activate (strongly recommended).";
export const CONFIDENTIAL_TRANSFER_UNAPPROVED_STOP =
  "REFUSED " + EM_DASH + " this account is not approved for confidential transfers, and the network refuses a transfer from an unapproved account. Nothing was sent and no fee was paid.";
/** After a send that threw and the mint's schedule reads unchanged: atomic, nothing moved. */
export const CONFIDENTIAL_TRANSFER_AFTER_FAILED_SEND =
  "The transaction is atomic: if the network reported an error, nothing moved and the recipient received nothing. If no confirmation arrived, run ddc balance before retrying.";
/** Auditor line of record, one form per mint state; neither prints a key. */
export const AUDITOR_LINE_NONE =
  "auditor : The transaction amount is encrypted, only you and the recipient can read it.";
export const AUDITOR_LINE_PRESENT =
  "auditor : The transaction amount is encrypted, only the secured auditor key manager, you and the recipient can read it.";
/** The sender has pending credits: stated, never applied here. */
export function formatPendingCreditsNote(pendingBaseUnits: bigint): string {
  return (
    "note : " + formatDdcAmount(pendingBaseUnits) + " DDC of pending credits is not included in your confidential balance. " +
    "This command never applies pending credits; run ddc apply-pending to fold them in."
  );
}

/**
 * Shape: exactly two positionals, a decimal amount then a wallet address;
 * refused by name before --keypair is read. The parsing is the shared
 * parser's (transfer-args.ts), which also carries the off-curve refusal;
 * this wrapper supplies the command's usage line and
 * word, so every message this command printed before is byte-identical.
 */
export function parseTransferArgs(positionals: readonly string[]): { netBaseUnits: bigint; recipient: Address } {
  return parseTransferPositionals(positionals, { usage: CONFIDENTIAL_TRANSFER_USAGE, command: "confidential-transfer" });
}

/** The recipient's account is absent or has no Confidential Balances. */
export function formatRecipientNotActivatedRefusal(recipient: Address): string {
  return (
    "REFUSED " + EM_DASH + " " + recipient + " has no Confidential Balances activated, so a confidential transfer to it cannot be built. " +
    "Nothing was sent and no fee was paid. The recipient can activate with ddc setup-privacy."
  );
}
/** The recipient's account is activated but cannot take a confidential credit today. */
export function formatRecipientCannotReceiveRefusal(recipient: Address, why: "unapproved" | "credits-disabled" | "pending-full"): string {
  const cause =
    why === "unapproved"
      ? "its account is not yet approved for confidential transfers"
      : why === "credits-disabled"
        ? "its account has confidential credits disabled"
        : "its pending balance has no room for another credit until the recipient runs ddc apply-pending";
  return "REFUSED " + EM_DASH + " " + recipient + " cannot receive a confidential transfer right now: " + cause + ". Nothing was sent and no fee was paid.";
}
/** Sufficiency is judged on the GROSS: the recipient's amount plus the fee. */
export function formatInsufficientConfidentialRefusal(input: { netBaseUnits: bigint; grossBaseUnits: bigint; confidentialBaseUnits: bigint }): string {
  return (
    "REFUSED " + EM_DASH + " sending " + formatDdcAmount(input.netBaseUnits) + " DDC costs " + formatDdcAmount(input.grossBaseUnits) +
    " DDC with the fee, which is more than the " + formatDdcAmount(input.confidentialBaseUnits) + " DDC your confidential balance reads. " +
    "Nothing was sent and no fee was paid. Restate a smaller amount."
  );
}
/** Pre-send: the account's available-balance ciphertext is not the one the proofs were built over. */
export function formatBalanceMovedRefusal(): string {
  return (
    "REFUSED " + EM_DASH + " your confidential balance changed while this command was running, so the proofs it built no longer describe this account. " +
    "Cause: a confidential credit was applied, or another client moved funds, between this command's read and its send. " +
    "Nothing was sent and no fee was paid. Run ddc confidential-transfer again."
  );
}
/** Pre-send: the mint's fee schedule parameters are not the ones the proofs were built under. */
export function formatScheduleMovedRefusal(): string {
  return (
    "REFUSED " + EM_DASH + " the fee schedule on the mint changed while this command was running, so the proofs it built no longer match it. " +
    "Nothing was sent and no fee was paid. Run ddc confidential-transfer again."
  );
}

export function formatConfidentialTransferHeader(input: { netBaseUnits: bigint; recipient: Address }): string {
  return "TRANSFER " + EM_DASH + " sending " + formatDdcAmount(input.netBaseUnits) + " DDC from your confidential balance to " + input.recipient;
}
/** The pre-send announcement: eight lines in this order, plus the pending note when it applies. */
export function formatConfidentialTransferAnnouncement(input: {
  netBaseUnits: bigint;
  recipient: Address;
  confidentialBeforeBaseUnits: bigint;
  split: TransferFeeSplit;
  schedule: TransferFeeSchedule;
  grossBaseUnits: bigint;
  zeroAuditorKey: boolean;
  pendingBaseUnits: bigint | undefined;
  cluster: string;
  clusterSource: ConfigSource;
}): string {
  const lines = [
    formatConfidentialTransferHeader({ netBaseUnits: input.netBaseUnits, recipient: input.recipient }),
    "confidential before : " + formatDdcAmount(input.confidentialBeforeBaseUnits) + " DDC",
    "recipient receives : " + formatDdcAmount(input.netBaseUnits) + " DDC",
    formatFeeLine({ feeBaseUnits: input.split.feeAmount, schedule: input.schedule }),
    "total debited : " + formatDdcAmount(input.grossBaseUnits) + " DDC (recipient receives + fee)",
    "confidential after : " + formatDdcAmount(input.confidentialBeforeBaseUnits - input.grossBaseUnits) + " DDC",
    input.zeroAuditorKey ? AUDITOR_LINE_NONE : AUDITOR_LINE_PRESENT,
    NETWORK_FEE_LINE,
    "cluster : " + input.cluster + " (" + input.clusterSource + ")",
  ];
  if (input.pendingBaseUnits !== undefined && input.pendingBaseUnits > 0n) {
    lines.push(formatPendingCreditsNote(input.pendingBaseUnits));
  }
  return lines.join("\n");
}
export function formatConfidentialTransferSuccess(input: { signature: Signature; netBaseUnits: bigint; recipient: Address; confidentialAfterBaseUnits: bigint }): string {
  return (
    "TRANSFER CONFIRMED " + EM_DASH + " signature " + input.signature + "; " + formatDdcAmount(input.netBaseUnits) + " DDC sent to " + input.recipient +
    " (it arrives in their pending balance); your confidential balance now reads " + formatDdcAmount(input.confidentialAfterBaseUnits) + " DDC."
  );
}

/** The two keys a transfer binds off a decoded mint: auditor (undefined when None) and withheld-fee. */
export function readMintConfidentialTransferKeys(mint: Mint): { auditorElgamalPubkey: Uint8Array | undefined; withdrawWithheldAuthorityElgamalPubkey: Uint8Array } {
  try {
    return readMintTransferKeys(mint);
  } catch (err) {
    if (err instanceof HolderRefusal && err.reason.kind === "mint-extension-missing") {
      throw new Error(mintExtensionMissingText(err.reason.extension));
    }
    throw err;
  }
}

/** The sentence for a mint without an extension every mint of the reference carries. */
function mintExtensionMissingText(extension: "any" | "ConfidentialTransferMint" | "ConfidentialTransferFeeConfig"): string {
  return extension === "any"
    ? "the mint carries no extensions; not a DDC mint"
    : "the mint carries no " + extension + " extension; not a DDC mint";
}

export interface ConfidentialTransferDeps {
  /** The typed-CONFIRM gate; tests inject a stub. */
  promptConfirm?: ConfirmPrompt;
}

export async function runConfidentialTransfer(argv: string[], deps: ConfidentialTransferDeps = {}): Promise<CommandOutcome> {
  const promptConfirm = deps.promptConfirm ?? promptTypedConfirm;
  const config = resolveConfig(argv);
  // SHAPE BEFORE IDENTITY: amount and recipient are validated before --keypair is read.
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
  const { netBaseUnits, recipient } = parseTransferArgs(positionals.slice(1));
  console.log(formatTargetBlock(config));
  requireStatedCluster(config, CONFIDENTIAL_TRANSFER_OPERATION);
  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const rpc = createRpc(config.rpcUrl);
  const ctx = { rpc, commitment: config.commitment, mint: config.mint, programId: config.programId };
  return withRefusalText(async () => {
    const plan = await prepareConfidentialTransfer(ctx, { signer, recipient, netBaseUnits });
    if (plan.kind === "not-activated") {
      console.log(CONFIDENTIAL_TRANSFER_UNCONFIGURED_STOP);
      return EXIT_NOT_DONE;
    }
    console.log(
      formatConfidentialTransferAnnouncement({
        netBaseUnits,
        recipient,
        confidentialBeforeBaseUnits: plan.confidentialBeforeBaseUnits,
        split: plan.split,
        schedule: plan.schedule,
        grossBaseUnits: plan.grossBaseUnits,
        zeroAuditorKey: plan.zeroAuditorKey,
        pendingBaseUnits: plan.pendingBaseUnits,
        cluster: config.rpcDisplay,
        clusterSource: config.source.rpcUrl,
      }),
    );
    if (!(await promptConfirm(TYPED_CONFIRM_QUESTION))) {
      console.log(CONFIRM_ABORTED_BEFORE_SEND);
      return EXIT_NOT_DONE;
    }
    // THE SEND-TIME CHECK runs first inside sendConfidentialTransfer (byte
    // equality against the ciphertext the proofs were built over), then the
    // load-bearing headroom check on a fresh mint and epoch read.
    const result = await sendConfidentialTransfer(ctx, plan, {
      signer,
      beforeSubmit: (transaction) =>
        console.log("TRANSFER wire size : " + getTransactionEncoder().encode(transaction).length + " bytes"),
      submit: async (wire) => {
        try {
          return await broadcastAndConfirm(rpc, wire, config.commitment, "TRANSFER");
        } catch (err) {
          console.log((err as Error).message);
          // AFTER-MISS MAPPING BY EVIDENCE.
          let changed = false;
          try {
            changed = !scheduleStillOnMint(plan.schedule, (await readTransferMint(ctx)).schedules);
          } catch {
            changed = false;
          }
          console.log(changed ? SCHEDULE_CHANGED_IN_FLIGHT : CONFIDENTIAL_TRANSFER_AFTER_FAILED_SEND);
          throw err;
        }
      },
    });
    console.log(
      formatConfidentialTransferSuccess({
        signature: result.signature,
        netBaseUnits,
        recipient,
        confidentialAfterBaseUnits: result.confidentialAfterBaseUnits,
      }),
    );
  }, confidentialTransferRefusalText(config.rpcDisplay), rpc);
}

/** The sentences `confidential-transfer` words itself. */
function confidentialTransferRefusalText(cluster: string): (reason: HolderRefusalReason) => string | undefined {
  return (reason) => {
    switch (reason.kind) {
      case "transaction-format-inactive":
        return formatTransactionFormatRefusal({ state: reason.state, cluster, operation: CONFIDENTIAL_TRANSFER_OPERATION });
      case "account-unapproved":
        return CONFIDENTIAL_TRANSFER_UNAPPROVED_STOP;
      case "account-not-found":
        return reason.account === "mint"
          ? "mint " + reason.address + " not found on cluster " + cluster
          : "PDA-1 MintState account " + reason.address + " not found on cluster " + cluster;
      case "mint-extension-missing":
        return mintExtensionMissingText(reason.extension);
      case "insufficient-confidential-for-transfer":
        return formatInsufficientConfidentialRefusal({
          netBaseUnits: reason.netBaseUnits,
          grossBaseUnits: reason.grossBaseUnits,
          confidentialBaseUnits: reason.confidentialBaseUnits,
        });
      case "recipient-not-activated":
        return formatRecipientNotActivatedRefusal(reason.recipient);
      case "recipient-cannot-receive":
        return formatRecipientCannotReceiveRefusal(reason.recipient, reason.why);
      case "available-moved":
        return formatBalanceMovedRefusal();
      case "schedule-moved":
        return formatScheduleMovedRefusal();
      default:
        return undefined;
    }
  };
}
