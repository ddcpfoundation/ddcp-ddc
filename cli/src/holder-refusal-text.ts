// The command-line tool's words for the holder library's refusal reasons.
// The library returns a reason as data; each holder command turns it into the
// sentence it has always printed. Reasons whose sentence depends on the
// command are mapped by the command itself; the rest are mapped here, the
// same for every command.

import { HolderRefusal, type HolderRefusalReason } from "./holder/refusal.js";
import {
  formatCopyShortRefusal,
  formatCopyUnreadableRefusal,
  formatPreSendKeyMismatch,
  formatUnreadableRefusal,
} from "./confidential-refusals.js";
import { formatBelowMinimumFeeRefusal, formatNotAWalletRefusal, formatSelfTransferRefusal } from "./transfer-refusals.js";
import { formatScheduleHeadroomRefusal, NOMINAL_SLOT_MILLIS } from "./tx/schedule-headroom.js";
import type { SolanaRpc } from "./rpc.js";

/** A command's own sentences for the reasons it words itself; undefined defers to the shared ones. */
export type CommandRefusalText = (reason: HolderRefusalReason) => string | undefined;

/** Measured slot time from recent samples, read only when a refusal is formatted; the nominal figure on any failure. */
export async function measureSlotMillis(rpc: SolanaRpc): Promise<number> {
  try {
    const samples = await rpc.getRecentPerformanceSamples(5).send();
    let slots = 0n;
    let seconds = 0;
    for (const s of samples) {
      slots += BigInt(s.numSlots);
      seconds += Number(s.samplePeriodSecs);
    }
    if (slots <= 0n || seconds <= 0) return NOMINAL_SLOT_MILLIS;
    return (seconds * 1000) / Number(slots);
  } catch {
    return NOMINAL_SLOT_MILLIS;
  }
}

/** The sentence every command prints for a reason it does not word itself. */
async function sharedText(reason: HolderRefusalReason, rpc: SolanaRpc | undefined): Promise<string | undefined> {
  switch (reason.kind) {
    case "key-mismatch":
      return formatPreSendKeyMismatch({ onChainKey: reason.onChainKey, derivedKey: reason.derivedKey });
    case "figure-unreadable":
      return formatUnreadableRefusal(reason.figure);
    case "copy-unreadable":
      return formatCopyUnreadableRefusal();
    case "copy-short":
      return formatCopyShortRefusal(reason.missingBaseUnits);
    case "extension-vanished":
      return `token account ${reason.tokenAccount} stopped reporting a ConfidentialTransferAccount extension between this command's two reads. Nothing was sent and no fee was paid.`;
    case "token-account-differs":
      return `token account derived twice and differs: ${reason.read} here, ${reason.assembled} in the assembly — nothing was sent`;
    case "below-minimum-fee":
      return formatBelowMinimumFeeRefusal({ feeBaseUnits: reason.feeBaseUnits, minimumFeeBaseUnits: reason.minimumFeeBaseUnits });
    case "self-transfer":
      return formatSelfTransferRefusal(reason.recipient);
    case "recipient-not-a-wallet":
      return formatNotAWalletRefusal(reason.recipient);
    case "schedule-headroom":
      return formatScheduleHeadroomRefusal({
        slotsRemaining: reason.slotsRemaining,
        slotMillis: rpc === undefined ? NOMINAL_SLOT_MILLIS : await measureSlotMillis(rpc),
      });
    default:
      return undefined;
  }
}

/**
 * Run a command body that calls the holder library; a refusal leaves it as an
 * Error carrying the command's sentence, and any other error unchanged.
 */
export async function withRefusalText<T>(
  body: () => Promise<T>,
  text: CommandRefusalText,
  rpc?: SolanaRpc,
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (!(err instanceof HolderRefusal)) throw err;
    const sentence = text(err.reason) ?? (await sharedText(err.reason, rpc));
    if (sentence === undefined) {
      throw new Error(`internal error: no sentence for the refusal "${err.reason.kind}"; nothing was sent unless a confirmation was printed above`);
    }
    throw new Error(sentence);
  }
}
