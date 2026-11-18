// 'ddc public-transfer <amount> <recipient>' -- send a stated amount from
// the wallet's PUBLIC balance to a recipient's PUBLIC balance. THE USER WORD
// IS 'public-transfer'; THE INSTRUCTION IS 'TransferCheckedWithFee', and the
// two never mix in user copy.
//
// THE AMOUNT IS WHAT THE RECIPIENT RECEIVES. The fee under the
// schedule in force is added on top and the sender's public balance is
// debited by gross = net + fee. The fee is computed through grossForNetPublic
// AND NOTHING ELSE: tx/public-transfer-tx.ts takes the fee as a
// parameter and cannot check it, so the figure announced and the figure sent
// are one value, taken from one result.
//
// NO PROOF, NO KEYS, NO FORMAT GATE. Nothing confidential is read or derived:
// the wallet signature that derives the confidential keys is never requested.
// The transaction is a version-0 message, so the version-1 format gate does
// not apply.
//
// THE RECIPIENT'S ACCOUNT IS CREATED WHEN ABSENT, the rent the sender's, in
// SOL, never netted from the amount. The rent figure is
// READ at announcement time at the length about to be created and never
// compiled in: rent per byte is a cluster property.
//
// ORDER: shape -> target block -> cluster guard -> identity -> self-transfer
// -> mint read (schedules) -> epoch -> courtesy headroom -> gross -> source
// read, sufficiency on the gross -> PDA-1 minimum fee -> destination read ->
// public-credits refusal -> rent read when the account is absent ->
// announcement -> CONFIRM -> re-read mint and epoch, load-bearing headroom,
// same parameters as quoted -> ONE send -> after-miss mapping -> read back.
//
// TWO HEADROOM CHECKS, as the confidential sibling carries them: a fee stated on the wire binds the transaction to a schedule exactly as
// a proof does, and the program returns FeeMismatch on any difference.
//
// THE ANNOUNCEMENT CLOSES ON THREE LINES when an account
// will be created -- the creation, the PUBLIC alert, the charge -- so that the
// charge is the line closest to the keystroke. When the account exists the
// alert alone closes it.
import { EXIT_NOT_DONE, type CommandOutcome } from "../exit-status.js";
import { parseArgs } from "node:util";
import { getTransactionEncoder, type Address, type Signature } from "@solana/kit";
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
import { DDC_DECIMALS, formatDdcAmount } from "../amount.js";
import { formatSolAmount } from "../sol-amount.js";
import {
  CONFIRM_ABORTED_BEFORE_SEND,
  promptTypedConfirm,
  TYPED_CONFIRM_QUESTION,
  type ConfirmPrompt,
} from "../confirm-prompt.js";
import { SCHEDULE_CHANGED_IN_FLIGHT, scheduleStillOnMint } from "../tx/schedule-headroom.js";
import type { TransferFeeSchedule } from "../tx/transfer-fee-split.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { preparePublicTransfer, readMintFeeSchedules, sendPublicTransfer } from "../holder/index.js";
import type { HolderRefusalReason } from "../holder/refusal.js";
import { withRefusalText } from "../holder-refusal-text.js";

const EM_DASH = String.fromCharCode(0x2014);

export const PUBLIC_TRANSFER_USAGE =
  "public-transfer: usage " + EM_DASH + " public-transfer <amount> <recipient-wallet> --keypair <path> --rpc-url <url>";
/** Named in the cluster refusal; names the OPERATION, never a flag this command does not have. */
export const PUBLIC_TRANSFER_OPERATION =
  "transferring from your public balance (one signed, fee-paying transaction)";

/**
 * The length of the token account THIS COMMAND'S CREATE PATH produces on this
 * mint: 165 base bytes, one account-type byte, one ImmutableOwner extension of
 * 4 + 0, which the associated token program adds to every Token-2022 account
 * it creates, and one TransferFeeAmount extension of 4 + 8. MEASURED at 182 on
 * an account this command created; a figure of 178 omits ImmutableOwner and
 * under-quotes the rent. The test beside
 * this file derives the figure from the installed package's own encoder. The
 * rent is READ at this length, never computed here.
 */
export { NEW_RECIPIENT_ACCOUNT_BYTES } from "../holder/public-transfer.js";

/** Shape: the shared parser under this command's usage line and word. */
export function parsePublicTransferArgs(positionals: readonly string[]): { netBaseUnits: bigint; recipient: Address } {
  return parseTransferPositionals(positionals, { usage: PUBLIC_TRANSFER_USAGE, command: "public-transfer" });
}

/** The three closing lines, in their fixed order. */
export const CREATE_FACT_LINE = "This recipient has no DDC account. One will be created.";
export const PUBLIC_ALERT_LINE =
  "THIS TRANSFER IS PUBLIC. The amount, your address and the recipient's address will be visible to anyone, permanently.";
export function formatRentChargeLine(rentLamports: bigint): string {
  return (
    "You will pay the account's one-time rent, " + formatSolAmount(rentLamports) +
    " SOL, on top of the network fee. The recipient receives the full amount."
  );
}

/** Sufficiency is judged on the GROSS. Deliberately names no unshield. */
export function formatInsufficientPublicRefusal(input: { netBaseUnits: bigint; grossBaseUnits: bigint; publicBaseUnits: bigint }): string {
  return (
    "REFUSED " + EM_DASH + " sending " + formatDdcAmount(input.netBaseUnits) + " DDC costs " + formatDdcAmount(input.grossBaseUnits) +
    " DDC with the fee, which is more than the " + formatDdcAmount(input.publicBaseUnits) + " DDC your public balance reads. " +
    "Nothing was sent and no fee was paid. Restate a smaller amount."
  );
}
/** The recipient's account has public credits turned off. */
export function formatRecipientRefusesPublicRefusal(recipient: Address): string {
  return (
    "REFUSED " + EM_DASH + " " + recipient + " does not accept public transfers on its DDC account. " +
    "Nothing was sent and no fee was paid. If the recipient has Confidential Balances activated, use ddc confidential-transfer."
  );
}
/**
 * FeeScheduleMovedDuringSend: the pre-send refusal for the
 * condition the pinned package generates no error name for. A name this build
 * owns; the after-send form of the same race is SCHEDULE_CHANGED_IN_FLIGHT.
 */
export function formatFeeScheduleMovedDuringSend(): string {
  return (
    "REFUSED " + EM_DASH + " the fee schedule on the mint moved between the fee quoted above and the send, so the quoted fee is no longer the one the network would charge. " +
    "Nothing was sent and no fee was paid. Run ddc public-transfer again to quote the fee now in force."
  );
}
/** After a send that threw and the schedule reads unchanged. */
export const PUBLIC_TRANSFER_AFTER_FAILED_SEND =
  "The transaction is atomic: if the network reported an error, nothing moved, no account was created and no rent was paid. If no confirmation arrived, run ddc balance before retrying.";

export function formatPublicTransferHeader(input: { netBaseUnits: bigint; recipient: Address }): string {
  return "PUBLIC TRANSFER " + EM_DASH + " sending " + formatDdcAmount(input.netBaseUnits) + " DDC from your public balance to " + input.recipient;
}
/**
 * The pre-send announcement: eight figure lines, then the three-line close. 'rentLamports' undefined means the recipient's account exists and
 * the alert alone closes; defined means the three lines close, in order.
 */
export function formatPublicTransferAnnouncement(input: {
  netBaseUnits: bigint;
  recipient: Address;
  publicBeforeBaseUnits: bigint;
  feeBaseUnits: bigint;
  schedule: TransferFeeSchedule;
  grossBaseUnits: bigint;
  rentLamports: bigint | undefined;
  cluster: string;
  clusterSource: ConfigSource;
}): string {
  const lines = [
    formatPublicTransferHeader({ netBaseUnits: input.netBaseUnits, recipient: input.recipient }),
    "public before : " + formatDdcAmount(input.publicBeforeBaseUnits) + " DDC",
    "recipient receives : " + formatDdcAmount(input.netBaseUnits) + " DDC",
    formatFeeLine({ feeBaseUnits: input.feeBaseUnits, schedule: input.schedule }),
    "total debited : " + formatDdcAmount(input.grossBaseUnits) + " DDC (recipient receives + fee)",
    "public after : " + formatDdcAmount(input.publicBeforeBaseUnits - input.grossBaseUnits) + " DDC",
    NETWORK_FEE_LINE,
    "cluster : " + input.cluster + " (" + input.clusterSource + ")",
  ];
  if (input.rentLamports === undefined) {
    lines.push(PUBLIC_ALERT_LINE);
  } else {
    lines.push(CREATE_FACT_LINE, PUBLIC_ALERT_LINE, formatRentChargeLine(input.rentLamports));
  }
  return lines.join("\n");
}
export function formatPublicTransferSuccess(input: { signature: Signature; netBaseUnits: bigint; recipient: Address; publicAfterBaseUnits: bigint }): string {
  return (
    "PUBLIC TRANSFER CONFIRMED " + EM_DASH + " signature " + input.signature + "; " + formatDdcAmount(input.netBaseUnits) + " DDC sent to " + input.recipient +
    "; your public balance now reads " + formatDdcAmount(input.publicAfterBaseUnits) + " DDC."
  );
}

export interface PublicTransferDeps {
  /** The typed-CONFIRM gate; tests inject a stub. */
  promptConfirm?: ConfirmPrompt;
}

export async function runPublicTransfer(argv: string[], deps: PublicTransferDeps = {}): Promise<CommandOutcome> {
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
  const { netBaseUnits, recipient } = parsePublicTransferArgs(positionals.slice(1));
  console.log(formatTargetBlock(config));
  requireStatedCluster(config, PUBLIC_TRANSFER_OPERATION);
  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const rpc = createRpc(config.rpcUrl);
  const ctx = { rpc, commitment: config.commitment, mint: config.mint, programId: config.programId, decimals: DDC_DECIMALS };
  return withRefusalText(async () => {
    const plan = await preparePublicTransfer(ctx, { signer, recipient, netBaseUnits });
    console.log(
      formatPublicTransferAnnouncement({
        netBaseUnits,
        recipient,
        publicBeforeBaseUnits: plan.publicBeforeBaseUnits,
        feeBaseUnits: plan.feeBaseUnits,
        schedule: plan.schedule,
        grossBaseUnits: plan.grossBaseUnits,
        rentLamports: plan.rentLamports,
        cluster: config.rpcDisplay,
        clusterSource: config.source.rpcUrl,
      }),
    );
    if (!(await promptConfirm(TYPED_CONFIRM_QUESTION))) {
      console.log(CONFIRM_ABORTED_BEFORE_SEND);
      return EXIT_NOT_DONE;
    }
    // LOAD-BEARING headroom check on a fresh mint and epoch read, and the same
    // parameters as quoted, runs first inside sendPublicTransfer.
    const result = await sendPublicTransfer(ctx, plan, {
      signer,
      beforeSubmit: (transaction) =>
        console.log("PUBLIC TRANSFER wire size : " + getTransactionEncoder().encode(transaction).length + " bytes"),
      submit: async (wire) => {
        try {
          return await broadcastAndConfirm(rpc, wire, config.commitment, "PUBLIC TRANSFER");
        } catch (err) {
          console.log((err as Error).message);
          // AFTER-MISS MAPPING BY EVIDENCE, as the confidential sibling maps it.
          let changed = false;
          try {
            changed = !scheduleStillOnMint(plan.schedule, await readMintFeeSchedules(ctx));
          } catch {
            changed = false;
          }
          console.log(changed ? SCHEDULE_CHANGED_IN_FLIGHT : PUBLIC_TRANSFER_AFTER_FAILED_SEND);
          throw err;
        }
      },
    });
    console.log(
      formatPublicTransferSuccess({
        signature: result.signature,
        netBaseUnits,
        recipient,
        publicAfterBaseUnits: result.publicAfterBaseUnits,
      }),
    );
  }, publicTransferRefusalText(config.rpcDisplay), rpc);
}

/** The sentences `public-transfer` words itself. */
function publicTransferRefusalText(cluster: string): (reason: HolderRefusalReason) => string | undefined {
  return (reason) => {
    switch (reason.kind) {
      case "account-not-found":
        return reason.account === "mint"
          ? "mint " + reason.address + " not found on cluster " + cluster
          : "PDA-1 MintState account " + reason.address + " not found on cluster " + cluster;
      case "insufficient-public-for-transfer":
        return formatInsufficientPublicRefusal({
          netBaseUnits: reason.netBaseUnits,
          grossBaseUnits: reason.grossBaseUnits,
          publicBaseUnits: reason.publicBaseUnits,
        });
      case "recipient-refuses-public":
        return formatRecipientRefusesPublicRefusal(reason.recipient);
      case "schedule-moved":
        return formatFeeScheduleMovedDuringSend();
      default:
        return undefined;
    }
  };
}
