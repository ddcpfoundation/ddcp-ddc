// `ddc balance [wallet-address]` — the read command for a DDC token
// account's three balance states.
//
// A READ STAYS A READ: this command NEVER sends — no apply,
// no activation, no fee, ever. Pending and unshielded-public conditions are
// ALERT-PLUS-OFFER pointers naming the command to run; the activation
// prompt lives in setup-privacy alone. No requireStatedCluster:
// like `state`, this works on the devnet default because nothing broadcasts.
//
// THE SIGNATURE IS REQUESTED LATE AND AT MOST ONCE: only on
// the configured-and-mine branch, where decryption needs it. Foreign
// accounts (a positional wallet-address that is not the signer) get public
// figures, activation status and, when configured, counters — no derivation
// and no mismatch check, because deriving with MY signature against another
// holder's account always differs and that copy would be wrong.
//
// DISPLAY:
// order public, pending, confidential; glyphs ○ (no fill), ◎ (U+25CE
// bullseye — arriving, not yet applied), ● (solid); fixed six decimal places;
// the heading says BALANCE so the labels do not repeat the word;
// "confidential", never "available". An unreadable figure prints UNREADABLE
// with cause/risk/action copy — never zero, never guessed.
//
// THRESHOLD WARNINGS: the value warning and the counter pair print on the
// holder's OWN configured account, after the stale warning and before the
// alert-plus-offer lines, in the same order apply-pending prints them. The
// counter trigger is computed against the EXACT cap read from this account's
// extension. The value warning needs the decrypted pending figure and is
// skipped when that figure is UNREADABLE; the counter pair needs only the
// extension's counters. The third-party branch prints the counters line and
// no warning: the copy is addressed to the holder ("YOUR ... COUNTER", "run
// ddc apply-pending"), which a third party cannot act on.

import { parseArgs } from "node:util";
import { address, type Address } from "@solana/kit";
import { formatTargetBlock, requireWalletIdentity, resolveConfig } from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { formatPreSendKeyMismatch } from "../confidential-refusals.js";
import { type BalanceCopyCheck, type DecryptResult } from "../confidential-balance.js";
import { formatDdcAmount } from "../amount.js";
import {
  classifyCounterFill,
  formatCounterFillingWarning,
  formatCounterFullWarning,
  formatPendingValueWarning,
  shouldWarnPendingValue,
} from "../confidential-warnings.js";
import { readHolderBalance } from "../holder/balance.js";

const USAGE =
  "balance: usage — balance [wallet-address] --keypair <path> [--rpc-url <url>]";

/** The three display lines; public is always shown, the other two only when opted in. */
export interface BalanceLines {
  confidential?: string;
  public: string;
  pending?: string;
}

/** The BALANCE block in the fixed order and glyphs, fixed labels, aligned colons. */
export function formatBalanceBlock(
  tokenAccount: Address,
  owner: Address,
  lines: BalanceLines,
): string {
  const row = (glyph: string, label: string, value: string): string =>
    `  ${glyph} ${label.padEnd(12)} : ${value}`;
  const out = [`BALANCE — token account ${tokenAccount} (owner ${owner})`];
  out.push(row("○", "public", lines.public));
  if (lines.pending !== undefined) out.push(row("◎", "pending", lines.pending));
  if (lines.confidential !== undefined) out.push(row("●", "confidential", lines.confidential));
  return out.join("\n");
}

/** A figure line: fixed six decimals plus the unit word, or UNREADABLE. */
export function formatFigure(result: DecryptResult): string {
  return result.readable
    ? `${formatDdcAmount(result.baseUnits)} DDC`
    : "UNREADABLE";
}

/** Activation status plus the offer, for the signer's own unactivated account. */
export function formatActivationOffer(kind: "absent" | "unconfigured"): string {
  const state =
    kind === "absent"
      ? "no DDC token account yet — it is created on first receipt, or by activation"
      : "token account exists, Confidential Balances not activated";
  return `Confidential Balances : ${state}. Run ddc setup-privacy to activate (strongly recommended).`;
}

/** The one-line scope statement for a third-party address; "and counters" appears only when counters exist. */
export function formatForeignNote(hasCounters: boolean): string {
  return `confidential amounts are readable only by the account holder; showing public state${hasCounters ? " and counters" : ""}`;
}

/** The counters line for a configured account, shown on the foreign branch. */
export function formatCountersLine(extension: {
  pendingBalanceCreditCounter: bigint;
  maximumPendingBalanceCreditCounter: bigint;
  expectedPendingBalanceCreditCounter: bigint;
  actualPendingBalanceCreditCounter: bigint;
}): string {
  return (
    `counters : pending credits ${extension.pendingBalanceCreditCounter} of ${extension.maximumPendingBalanceCreditCounter} · ` +
    `expected ${extension.expectedPendingBalanceCreditCounter} / actual ${extension.actualPendingBalanceCreditCounter}`
  );
}

/** Alert-plus-offer: pending credits exist; the user runs the fold, never the CLI. */
export function formatPendingAlert(credits: bigint): string {
  const one = credits === 1n;
  const noun = one ? "pending credit" : "pending credits";
  const verb = one ? "is" : "are";
  const object = one ? "it" : "them";
  return `◎ ${credits} ${noun} ${verb} not yet spendable. Run ddc apply-pending to fold ${object} into your confidential balance.`;
}

/** Alert-plus-offer: public funds sit in an opted-in account; shielding is offered, never automatic. */
export function formatShieldAlert(publicBaseUnits: bigint): string {
  return (
    `○ ${formatDdcAmount(publicBaseUnits)} DDC sits in your PUBLIC balance while this account has Confidential Balances active. ` +
    "To shield it, run ddc shield with the amount you choose — this CLI never shields automatically."
  );
}

/**
 * WARNING: the balance copy does not match the encrypted balance it copies.
 * A short copy is corrected by ddc apply-pending (D-208 item 1); a difference past what this tool reads is not.
 */
export function formatStaleWarning(
  check: Exclude<BalanceCopyCheck, { kind: "consistent" }>,
  expected: bigint,
  actual: bigint,
): string {
  const counters = `(stored expected counter ${expected}, actual ${actual})`;
  if (check.kind === "short") {
    return (
      `WARNING — the confidential figure UNDERSTATES the true balance by ${formatDdcAmount(check.missingBaseUnits)} DDC ${counters}. ` +
      "Cause: an apply or shield was raced by a credit, or two ran at the same time, so the fast-read copy was written without it. " +
      "Risk: confidential sends from this account are refused until the copy is corrected. " +
      "Action: run ddc apply-pending. It corrects the copy, even with nothing pending."
    );
  }
  return (
    `WARNING — the confidential figure does not match the encrypted balance, by more than this tool can read ${counters}. ` +
    "Risk: the true figure is not shown, and confidential sends from this account are refused. " +
    "Action: a correction needs the account's transaction history, which this tool does not read."
  );
}

/** WARNING: a ciphertext did not decrypt with this wallet's derived key. */
export function formatUnreadableWarning(
  which: "confidential" | "pending",
  reason: string,
): string {
  return (
    `WARNING — the ${which} figure is UNREADABLE with the key this wallet derives (${reason}). ` +
    "The true figure is unknown; it is NOT zero. " +
    "Action: re-read from a second RPC endpoint; if this persists the cause is one of a wrong key, a copy " +
    "written by another client, or a figure past the limit this CLI can read — " +
    "do not transact confidentially from this account until it is resolved."
  );
}

/**
 * The threshold warnings for the holder's own account, in
 * apply-pending's order: value first, then the counter pair. Pure, so the
 * branch logic is pinned in balance.test.ts without a network read.
 */
export function formatThresholdWarnings(input: {
  pending: DecryptResult;
  pendingBalanceCreditCounter: bigint;
  maximumPendingBalanceCreditCounter: bigint;
}): string[] {
  const out: string[] = [];
  if (input.pending.readable && shouldWarnPendingValue(input.pending.baseUnits)) {
    out.push(formatPendingValueWarning(input.pending.baseUnits));
  }
  const fill = classifyCounterFill(
    input.pendingBalanceCreditCounter,
    input.maximumPendingBalanceCreditCounter,
  );
  if (fill === "filling") {
    out.push(
      formatCounterFillingWarning(
        input.pendingBalanceCreditCounter,
        input.maximumPendingBalanceCreditCounter,
      ),
    );
  } else if (fill === "full") {
    out.push(formatCounterFullWarning(input.pendingBalanceCreditCounter));
  }
  return out;
}

/**
 * The configured-and-mine KEY MISMATCH: the refusal message names the public
 * balance as unaffected, so the BALANCE block with the public line only
 * (as the unconfigured branch prints it) is printed first and the unchanged
 * refusal follows. Pure, so the composition is pinned in balance.test.ts
 * without a network read.
 */
export function formatKeyMismatchOutput(input: {
  tokenAccount: Address;
  owner: Address;
  publicBaseUnits: bigint;
  onChainKey: Address;
  derivedKey: Address;
}): { block: string; refusal: string } {
  return {
    block: formatBalanceBlock(input.tokenAccount, input.owner, {
      public: `${formatDdcAmount(input.publicBaseUnits)} DDC`,
    }),
    refusal: formatPreSendKeyMismatch({
      onChainKey: input.onChainKey,
      derivedKey: input.derivedKey,
    }),
  };
}

export async function runBalance(argv: string[]): Promise<void> {
  const config = resolveConfig(argv);

  // SHAPE BEFORE IDENTITY: the positional is validated before --keypair is read.
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
  if (positionals.length > 2) {
    throw new Error(
      `${USAGE}\nexpected at most one wallet-address positional, got ${positionals.length - 1}`,
    );
  }
  let requestedOwner: Address | undefined;
  const positional = positionals[1];
  if (positional !== undefined) {
    try {
      requestedOwner = address(positional);
    } catch {
      throw new Error(
        `${USAGE}\nthe wallet-address positional "${positional}" is not a valid address`,
      );
    }
  }

  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const owner = requestedOwner ?? signer.address;

  console.log(formatTargetBlock(config));

  const rpc = createRpc(config.rpcUrl);
  const b = await readHolderBalance({ rpc, commitment: config.commitment, mint: config.mint }, { owner, signer });
  const publicLine = `${formatDdcAmount(b.publicBaseUnits)} DDC`;

  if (b.kind === "foreign") {
    console.log(formatBalanceBlock(b.tokenAccount, owner, { public: publicLine }));
    console.log(
      `Confidential Balances : ${b.activation.kind === "configured" ? `activated (approved ${b.activation.approved})` : b.activation.kind}`,
    );
    if (b.extension !== undefined) console.log(formatCountersLine(b.extension));
    console.log(formatForeignNote(b.extension !== undefined));
    return;
  }

  if (b.kind === "not-activated") {
    console.log(formatBalanceBlock(b.tokenAccount, owner, { public: publicLine }));
    console.log(formatActivationOffer(b.activation.kind === "absent" ? "absent" : "unconfigured"));
    return;
  }

  if (b.kind === "key-mismatch") {
    const mismatch = formatKeyMismatchOutput({
      tokenAccount: b.tokenAccount,
      owner,
      publicBaseUnits: b.publicBaseUnits,
      onChainKey: b.onChainKey,
      derivedKey: b.derivedKey,
    });
    console.log(mismatch.block);
    throw new Error(mismatch.refusal);
  }

  const { extension, confidential, pending } = b;
  console.log(
    formatBalanceBlock(b.tokenAccount, owner, {
      confidential: formatFigure(confidential),
      public: publicLine,
      pending: formatFigure(pending),
    }),
  );
  console.log(formatCountersLine(extension));
  if (!confidential.readable) {
    console.log(formatUnreadableWarning("confidential", confidential.reason));
  }
  if (!pending.readable) {
    console.log(formatUnreadableWarning("pending", pending.reason));
  }
  // THE COPY AGAINST THE BALANCE IT COPIES, not the counters: two shields
  // run at the same time leave the counters equal and the copy short.
  if (b.copyCheck !== undefined && b.copyCheck.kind !== "consistent") {
    console.log(
      formatStaleWarning(
        b.copyCheck,
        extension.expectedPendingBalanceCreditCounter,
        extension.actualPendingBalanceCreditCounter,
      ),
    );
  }
  for (const warning of formatThresholdWarnings({
    pending,
    pendingBalanceCreditCounter: extension.pendingBalanceCreditCounter,
    maximumPendingBalanceCreditCounter: extension.maximumPendingBalanceCreditCounter,
  })) {
    console.log(warning);
  }
  if (pending.readable && pending.baseUnits > 0n) {
    console.log(formatPendingAlert(extension.pendingBalanceCreditCounter));
  }
  if (b.publicBaseUnits > 0n) {
    console.log(formatShieldAlert(b.publicBaseUnits));
  }
}
