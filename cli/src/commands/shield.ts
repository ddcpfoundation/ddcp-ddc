// `ddc shield <amount>` — move a stated amount from a token account's PUBLIC
// balance into its CONFIDENTIAL balance in one transaction, `Deposit` followed
// by `ApplyPendingBalance`.
//
// THE USER WORD IS `shield`. THE INSTRUCTION IS `Deposit`. They are never
// conflated: a holder shields; the wire carries Deposit then ApplyPendingBalance,
// and user copy never uses "deposit" as a verb.
//
// ORDER (as apply-pending implements it): shape, target block,
// requireStatedCluster, identity, blockhash, account read, unconfigured stop,
// at-cap refusal, pending refusal, sufficiency refusal, derive, decrypt,
// compute, re-read, announce, send, read back. The at-cap check runs BEFORE
// the sufficiency check: it needs no key, and its
// action — apply-pending — is owed whatever the amount.
//
// UNCONFIGURED ACCOUNT: this command REFUSES and points at setup-privacy.
// Activation is a standalone act: the consent-then-setup
// chain once owed as a shared mechanism is deleted.
//
// A SHIELD REFUSES WHEN ANYTHING IS PENDING. The
// ApplyPendingBalance in this transaction is not selective: the program folds
// EVERYTHING pending — credits already waiting AND the Deposit one instruction
// earlier — and zeroes the counter. A shield that silently
// folded waiting credits would either understate the copy it writes or fold
// an amount the holder did not state. So `shield` means public to confidential
// and nothing else: a non-zero pending credit counter is refused, pointing at
// apply-pending, before any key is derived — the counter is plaintext, and a
// counter of zero establishes that both pending limbs are zero.
// Consequence: the copy written is available + amount, the pending limbs are
// never decrypted here, and the threshold warnings that fire on pending cannot
// fire inside this command. The expected counter is computed inside the
// assembler as the counter AS READ, zero, plus one; a credit
// arriving between the read and the send is the counter-moved refusal.
//
// NO y/n PROMPT and no --broadcast: the
// announcement is a disclosure, and the explicitly stated cluster is the gate.
//
// THE COPY BELOW BELONGS TO THIS COMMAND. The key-mismatch,
// unreadable and post-apply-mismatch messages are shared and imported; the
// network-fee line is shared announcement copy and imported.

import { EXIT_NOT_DONE, type CommandOutcome } from "../exit-status.js";
import { parseArgs } from "node:util";
import { type Signature } from "@solana/kit";
import {
  formatTargetBlock,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { formatCopyCorrectionNotice, formatPostApplyMismatch } from "../confidential-refusals.js";
import { NETWORK_FEE_LINE } from "../announcements.js";
import { DDC_DECIMALS, formatDdcAmount, parseDdcAmount } from "../amount.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { prepareShield, sendShield } from "../holder/shield.js";
import type { HolderRefusalReason } from "../holder/refusal.js";
import { withRefusalText } from "../holder-refusal-text.js";

export const SHIELD_USAGE =
  "shield: usage — shield <amount> --keypair <path> --rpc-url <url>";

/** The operation phrase requireStatedCluster names in its refusal. */
export const SHIELD_OPERATION =
  "shielding into your confidential balance (a signed, fee-paying transaction)";

/**
 * SHAPE: exactly one positional, parsed through
 * parseDdcAmount; a zero amount is a usage error naming the smallest amount,
 * decided here before identity. The assembler's own zero and cap refusals stay
 * behind this as module-level guards. Pure, so the test pins it.
 */
export function parseShieldAmount(positionals: readonly string[]): bigint {
  if (positionals.length !== 1) {
    throw new Error(
      `${SHIELD_USAGE}\nshield takes exactly one amount; got ${positionals.length} positional argument${positionals.length === 1 ? "" : "s"}`,
    );
  }
  const text = positionals[0];
  if (text === undefined) {
    throw new Error(`${SHIELD_USAGE}\nshield takes exactly one amount; got none`);
  }
  let amount: bigint;
  try {
    amount = parseDdcAmount(text);
  } catch (err) {
    throw new Error(`${SHIELD_USAGE}\n${err instanceof Error ? err.message : String(err)}`);
  }
  if (amount === 0n) {
    throw new Error(`${SHIELD_USAGE}\nthe amount must be at least 0.000001 DDC; got ${text}`);
  }
  return amount;
}

/**
 * The unconfigured-account refusal, on the APPLY_UNACTIVATED_STOP
 * pattern: one message for both the absent token account and the account that
 * exists without the extension. Sends nothing, pays nothing.
 */
export const SHIELD_UNCONFIGURED_STOP =
  "Nothing to shield — Confidential Balances is not activated on this account, so there is no confidential balance to shield into. No transaction was sent and no fee was paid. Run ddc setup-privacy to activate (strongly recommended).";

/**
 * The at-cap refusal, on the EXACT cap read from this
 * account's extension. At the cap the Deposit fails on-chain after the fee is
 * paid; refusing here costs nothing.
 */
export function formatAtCapRefusal(input: { count: bigint; cap: bigint }): string {
  return (
    `REFUSED — this account's pending credit counter is at its cap (${input.count} of ${input.cap}), so the network would reject a shield. ` +
    "Cause: unapplied pending credits have filled the counter. " +
    "Risk: a Deposit sent now fails on-chain after the fee is paid. Nothing was sent and no fee was paid. " +
    "Action: run ddc apply-pending to fold pending and reset the counter to zero, then shield."
  );
}

/**
 * The pending refusal: anything pending is applied
 * first, by the holder, through apply-pending. A proper singular and plural,
 * never "(s)".
 */
export function formatPendingPresentRefusal(credits: bigint): string {
  const noun = credits === 1n ? "pending credit" : "pending credits";
  const verb = credits === 1n ? "is" : "are";
  const object = credits === 1n ? "it" : "them";
  return (
    `REFUSED — ${credits} ${noun} ${verb} waiting on this account, and a shield would fold ${object} in together with the amount you stated. ` +
    "Nothing was sent and no fee was paid. " +
    "Action: run ddc apply-pending first, then shield."
  );
}

/** The sufficiency refusal: the on-chain failure is a misleading TokenError::Overflow. */
export function formatInsufficientPublicRefusal(input: {
  amountBaseUnits: bigint;
  publicBaseUnits: bigint;
}): string {
  return (
    `REFUSED — ${formatDdcAmount(input.amountBaseUnits)} DDC is more than the ${formatDdcAmount(input.publicBaseUnits)} DDC in your public balance. ` +
    "Nothing was sent and no fee was paid. Restate a smaller amount."
  );
}

/**
 * The counter-moved refusal, this command's own copy on the apply-pending
 * pattern: the counter moved between the read the figures were computed from
 * and the send, so the copy this shield would write is short.
 */
export function formatShieldCounterMovedRefusal(input: {
  atRead: bigint;
  atSend: bigint;
}): string {
  return (
    `REFUSED — the pending credit counter moved from ${input.atRead} to ${input.atSend} between this command's read and its send. ` +
    "Cause: a confidential credit arrived in that window. " +
    "Risk: the balance copy this shield would write was computed before it, so sending now would understate your confidential balance. Nothing was sent and no fee was paid. " +
    "Action: run ddc shield again; under a continuous stream of credits it will keep refusing; these refusals are deliberate and incur no cost."
  );
}

/** The announcement header. */
export function formatShieldHeader(amountBaseUnits: bigint): string {
  return `SHIELD — moving ${formatDdcAmount(amountBaseUnits)} DDC from your public balance into your confidential balance`;
}

export interface ShieldAnnouncement {
  amountBaseUnits: bigint;
  confidentialAfterBaseUnits: bigint;
  cluster: string;
  clusterSource: string;
}

/**
 * The announcement block: five lines on the apply-pending pattern. A DISCLOSURE, not a question.
 */
export function formatShieldAnnouncement(input: ShieldAnnouncement): string {
  return [
    formatShieldHeader(input.amountBaseUnits),
    `○ shielding : ${formatDdcAmount(input.amountBaseUnits)} DDC`,
    `● confidential after : ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC`,
    NETWORK_FEE_LINE,
    `cluster : ${input.cluster} (${input.clusterSource})`,
  ].join("\n");
}

/** The clean-branch confirmation. */
export function formatShieldSuccess(input: {
  signature: Signature;
  amountBaseUnits: bigint;
  confidentialAfterBaseUnits: bigint;
}): string {
  return (
    `SHIELD CONFIRMED — signature ${input.signature}; ` +
    `${formatDdcAmount(input.amountBaseUnits)} DDC shielded; your confidential balance now reads ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC.`
  );
}

export async function runShield(argv: string[]): Promise<CommandOutcome> {
  const config = resolveConfig(argv);

  // SHAPE BEFORE IDENTITY.
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
  const amountBaseUnits = parseShieldAmount(positionals.slice(1));

  console.log(formatTargetBlock(config));
  requireStatedCluster(config, SHIELD_OPERATION);

  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const rpc = createRpc(config.rpcUrl);
  const ctx = { rpc, commitment: config.commitment, mint: config.mint, decimals: DDC_DECIMALS };

  return withRefusalText(async () => {
    const plan = await prepareShield(ctx, { signer, amountBaseUnits });
    if (plan.kind === "not-activated") {
      console.log(SHIELD_UNCONFIGURED_STOP);
      return EXIT_NOT_DONE;
    }
    if (plan.correctionBaseUnits > 0n) {
      console.log(formatCopyCorrectionNotice(plan.correctionBaseUnits));
    }
    // THE SEND-TIME CHECK runs first inside sendShield; the announcement is
    // printed only once it passes, as the last thing before the send.
    const { signature, readBack } = await sendShield(ctx, plan, {
      signer,
      afterCheck: () =>
        console.log(
          formatShieldAnnouncement({
            amountBaseUnits,
            confidentialAfterBaseUnits: plan.confidentialAfterBaseUnits,
            cluster: config.rpcDisplay,
            clusterSource: config.source.rpcUrl,
          }),
        ),
      submit: (wire) => broadcastAndConfirm(rpc, wire, config.commitment, "SHIELD"),
    });
    if (readBack.kind === "mismatch") {
      console.log(
        formatPostApplyMismatch({
          expected: readBack.expected,
          actual: readBack.actual,
          check: readBack.check,
          command: "shield",
        }),
      );
      return;
    }
    console.log(
      formatShieldSuccess({
        signature,
        amountBaseUnits,
        confidentialAfterBaseUnits: plan.confidentialAfterBaseUnits,
      }),
    );
  }, shieldRefusalText);
}

/**
 * The available-balance refusal: the encrypted balance changed between the
 * read the figures were computed from and the send, with the counter
 * unchanged, as when another shield or apply-pending on this account landed
 * in that window.
 */
export function formatShieldBalanceMovedRefusal(): string {
  return (
    "REFUSED — your confidential account changed between this command's read and its send (available balance changed). " +
    "Cause: a confidential credit or another command on this account landed in that window. " +
    "Risk: the balance copy this request would write was computed before it, so sending now would understate your confidential balance. Nothing was sent and no fee was paid. " +
    "Action: run ddc shield again."
  );
}

/** The sentences `shield` words itself. */
function shieldRefusalText(reason: HolderRefusalReason): string | undefined {
  switch (reason.kind) {
    case "pending-at-cap":
      return formatAtCapRefusal({ count: reason.count, cap: reason.cap });
    case "pending-present":
      return formatPendingPresentRefusal(reason.credits);
    case "insufficient-public-for-shield":
      return formatInsufficientPublicRefusal({ amountBaseUnits: reason.amountBaseUnits, publicBaseUnits: reason.publicBaseUnits });
    case "counter-moved":
      return formatShieldCounterMovedRefusal({ atRead: reason.atRead, atSend: reason.atSend });
    case "available-moved":
      return formatShieldBalanceMovedRefusal();
    case "extension-gone-after-send":
      return `SHIELD: the network confirmed signature ${reason.signature}, but token account ${reason.tokenAccount} no longer reports a ConfidentialTransferAccount extension. Most likely a stale or lagging RPC read. Re-read from a second RPC endpoint before doing anything else, and do NOT repeat this command until you have.`;
    default:
      return undefined;
  }
}
