// `ddc apply-pending` — fold a token account's pending confidential credits
// into its confidential balance.
//
// ORDER: shape, target block,
// requireStatedCluster, identity, blockhash, account read, derive, decrypt,
// check the copy, warn, compute, re-read, announce, send, read back. The
// command derives even at a counter of zero: telling a balance copy that
// matches the encrypted balance from a short one takes the key, and a short
// copy is corrected by this command with nothing pending (D-208 item 1). An unactivated account still stops before it.
//
// NO y/n PROMPT: the announcement is a disclosure, not a
// question. A user command carries no --broadcast, and the
// explicitly stated cluster is the gate standing in its place.
//
// THE COUNTER SENT TO THE INSTRUCTION IS THE ACCOUNT'S LIVE
// `pendingBalanceCreditCounter`, NEVER the extension's own
// `expectedPendingBalanceCreditCounter`, which sits beside it on the same
// decode and is the field the wire parameter is named after. Choosing the wrong one compiles clean and fails ON-CHAIN
// after the fee is paid.
//
// THE COPY BELOW BELONGS TO THIS COMMAND. No other command
// prints these strings, so they live here rather than in
// confidential-refusals.ts, whose admission rule is copy shared VERBATIM by
// several commands. The key-mismatch, unreadable and post-apply-mismatch
// messages ARE shared and are imported from there, and the network-fee line
// is shared announcement copy imported from announcements.ts (it moved there
// when `shield` became its second consumer).
//
// NAMING RULES, fixed with the copy: the REQUEST is named
// "apply pending balance request" wherever the noun appears; the verb form
// stays ("Nothing to apply"); command names are literals. The currency is
// DDC and the command is ddc — the two never converge. The plural is rendered properly, never as "(s)".

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
import {
  classifyCounterFill,
  formatCounterFillingWarning,
  formatCounterFullWarning,
  formatPendingValueWarning,
  shouldWarnPendingValue,
} from "../confidential-warnings.js";
import { formatDdcAmount } from "../amount.js";
import { NETWORK_FEE_LINE } from "../announcements.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { prepareApplyPending, sendApplyPending } from "../holder/apply-pending.js";
import type { HolderRefusalReason } from "../holder/refusal.js";
import { withRefusalText } from "../holder-refusal-text.js";

const USAGE =
  "apply-pending: usage — apply-pending --keypair <path> --rpc-url <url>";

/**
 * The announcement header. Count rendered plainly. A send with nothing
 * pending is reached only when the balance copy is short, so zero credits
 * names the correction, never "folding 0" (D-212).
 */
export function formatApplyHeader(credits: bigint): string {
  if (credits === 0n) {
    return "APPLY PENDING BALANCE — nothing pending; this request writes the corrected balance copy only";
  }
  const noun = credits === 1n ? "pending credit" : "pending credits";
  return `APPLY PENDING BALANCE — folding ${credits} ${noun} into your confidential balance`;
}

/**
 * The zero-stop: no pending credit, and the balance copy matches the
 * encrypted balance. No figure appears. With a short copy the command does
 * not stop: it writes the corrected copy (D-208 item 1), so reaching this stop now takes the key derivation.
 */
export const APPLY_ZERO_STOP =
  "Nothing to apply — pending credit counter 0, and the balance copy matches the encrypted balance. No transaction was sent and no fee was paid.";

/**
 * The unactivated-account stop: this command's OWN sentence,
 * importing nothing from commands/balance.ts. ONE sentence covers both the
 * absent token account and the account that exists without the extension,
 * because the holder's action is identical in either case.
 */
export const APPLY_UNACTIVATED_STOP =
  "Nothing to apply — Confidential Balances is not activated on this account, so nothing can be pending. No transaction was sent and no fee was paid. Run ddc setup-privacy to activate (strongly recommended).";

/**
 * The dusting-containment refusal: the pending credit counter
 * moved between the read the figures were computed from and the send, so those
 * figures are stale and the copy they would write is short.
 *
 * The action line states the accepted trade in the holder's own
 * terms rather than hiding it: under a sustained stream this command refuses
 * indefinitely, and a refusal that costs nothing beats a wrong figure that
 * costs everything.
 */
export function formatCounterMovedRefusal(input: {
  atRead: bigint;
  atSend: bigint;
}): string {
  return (
    "REFUSED — a confidential credit arrived while this command was preparing, so the figures it read are already stale. " +
    `Cause: the pending credit counter moved from ${input.atRead} to ${input.atSend} between the balance read and the send. ` +
    "Risk: applying now would write a balance copy computed without that credit, understating your holding with nothing on-chain to signal it. Nothing was sent and no fee was paid. " +
    "Action: run ddc apply-pending again; under a continuous stream of credits it will keep refusing; these refusals are deliberate and incur no cost."
  );
}

export interface ApplyAnnouncement {
  credits: bigint;
  pendingBaseUnits: bigint;
  confidentialAfterBaseUnits: bigint;
  cluster: string;
  clusterSource: string;
}

/**
 * The announcement block. A DISCLOSURE, not a question: it is the last thing printed before
 * the send and no y/n follows it.
 *
 * The cluster line repeats the target block's cluster deliberately. The target
 * block is a separate disclosure printed before the identity check, and the
 * cluster belongs inside the announcement as well; the repetition is
 * deliberate, not an oversight to tidy away.
 */
export function formatApplyAnnouncement(input: ApplyAnnouncement): string {
  return [
    formatApplyHeader(input.credits),
    `◎ pending to fold : ${formatDdcAmount(input.pendingBaseUnits)} DDC`,
    `● confidential after : ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC`,
    NETWORK_FEE_LINE,
    `cluster : ${input.cluster} (${input.clusterSource})`,
  ].join("\n");
}

/**
 * The clean-branch confirmation. It shares the
 * APPLY-PENDING CONFIRMED headline with the post-apply mismatch message so the
 * two outcomes of one event open in the same register and diverge after it.
 */
export function formatApplySuccess(input: {
  signature: Signature;
  credits: bigint;
  confidentialAfterBaseUnits: bigint;
}): string {
  if (input.credits === 0n) {
    // Printed only after the read-back found the copy consistent (D-212).
    return (
      `APPLY-PENDING CONFIRMED — signature ${input.signature}; ` +
      `nothing pending was folded, and the balance copy now reads ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC, matching your encrypted balance.`
    );
  }
  const noun = input.credits === 1n ? "pending credit" : "pending credits";
  return (
    `APPLY-PENDING CONFIRMED — signature ${input.signature}; ` +
    `${input.credits} ${noun} folded into your confidential balance, which now reads ${formatDdcAmount(input.confidentialAfterBaseUnits)} DDC.`
  );
}

export async function runApplyPending(argv: string[]): Promise<void> {
  const config = resolveConfig(argv);

  // SHAPE BEFORE IDENTITY: this command accepts NO positional
  // argument at all. There is no third-party form, because applying needs the
  // holder's own key, so a positional is a usage error rather than an address
  // to validate.
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
  if (positionals.length > 1) {
    throw new Error(
      `${USAGE}\napply-pending takes no positional argument; got ${positionals.length - 1}. It applies to this wallet's own token account, which needs this wallet's key.`,
    );
  }

  console.log(formatTargetBlock(config));
  // Cluster must be stated to send. The wording names the OPERATION, not a flag
  // this command does not have.
  requireStatedCluster(
    config,
    "applying pending credits (a signed, fee-paying transaction)",
  );

  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const rpc = createRpc(config.rpcUrl);
  const ctx = { rpc, commitment: config.commitment, mint: config.mint };

  await withRefusalText(async () => {
    const plan = await prepareApplyPending(ctx, { signer });
    if (plan.kind === "not-activated") {
      console.log(APPLY_UNACTIVATED_STOP);
      return;
    }
    if (plan.kind === "nothing-to-apply") {
      console.log(APPLY_ZERO_STOP);
      return;
    }

    // THRESHOLD WARNINGS, printed before the announcement because they
    // describe the state being acted on. The counter trigger is computed
    // against the EXACT cap read from THIS account's extension.
    if (shouldWarnPendingValue(plan.pendingBaseUnits)) {
      console.log(formatPendingValueWarning(plan.pendingBaseUnits));
    }
    const fill = classifyCounterFill(plan.credits, plan.cap);
    if (fill === "filling") {
      console.log(formatCounterFillingWarning(plan.credits, plan.cap));
    } else if (fill === "full") {
      console.log(formatCounterFullWarning(plan.credits));
    }
    if (plan.correctionBaseUnits > 0n) {
      console.log(formatCopyCorrectionNotice(plan.correctionBaseUnits));
    }

    // THE SEND-TIME CHECK runs first inside sendApplyPending; the
    // announcement is printed only once it passes, as the last thing before
    // the send. A disclosure, not a question: no y/n follows it.
    const { signature, readBack } = await sendApplyPending(ctx, plan, {
      signer,
      afterCheck: () =>
        console.log(
          formatApplyAnnouncement({
            credits: plan.credits,
            pendingBaseUnits: plan.pendingBaseUnits,
            confidentialAfterBaseUnits: plan.confidentialAfterBaseUnits,
            cluster: config.rpcDisplay,
            clusterSource: config.source.rpcUrl,
          }),
        ),
      submit: (wire) => broadcastAndConfirm(rpc, wire, config.commitment, "APPLY-PENDING"),
    });
    if (readBack.kind === "mismatch") {
      console.log(
        formatPostApplyMismatch({
          expected: readBack.expected,
          actual: readBack.actual,
          check: readBack.check,
        }),
      );
      return;
    }
    console.log(
      formatApplySuccess({
        signature,
        credits: plan.credits,
        confidentialAfterBaseUnits: plan.confidentialAfterBaseUnits,
      }),
    );
  }, applyPendingRefusalText);
}

/**
 * The available-balance refusal: the encrypted balance changed between the
 * read the figures were computed from and the send, with the counter
 * unchanged, as when a shield or another apply-pending on this account landed
 * in that window.
 */
export function formatApplyBalanceMovedRefusal(): string {
  return (
    "REFUSED — your confidential account changed between this command's read and its send (available balance changed). " +
    "Cause: a confidential credit or another command on this account landed in that window. " +
    "Risk: the balance copy this request would write was computed before it, so sending now would understate your confidential balance. Nothing was sent and no fee was paid. " +
    "Action: run ddc apply-pending again."
  );
}

/** The sentences `apply-pending` words itself. */
function applyPendingRefusalText(reason: HolderRefusalReason): string | undefined {
  switch (reason.kind) {
    case "counter-moved":
      return formatCounterMovedRefusal({ atRead: reason.atRead, atSend: reason.atSend });
    case "available-moved":
      return formatApplyBalanceMovedRefusal();
    case "extension-gone-after-send":
      return `APPLY-PENDING: the network confirmed signature ${reason.signature}, but token account ${reason.tokenAccount} no longer reports a ConfidentialTransferAccount extension. Most likely a stale or lagging RPC read. Re-read from a second RPC endpoint before doing anything else, and do NOT repeat this command until you have.`;
    default:
      return undefined;
  }
}
