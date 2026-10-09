// `ddc apply-pending` — fold a token account's pending confidential credits
// into its confidential balance.
//
// ORDER: shape, target block,
// requireStatedCluster, identity, blockhash, account read, derive, decrypt,
// warn, compute, re-read, announce, send, read back. The command READS BEFORE
// IT DERIVES: a counter of zero establishes that nothing is pending with no key
// at all, so the wallet is never asked for the derivation signature on an
// account that has nothing to apply.
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
import {
  assertIsFullySignedTransaction,
  fetchEncodedAccount,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  type Signature,
} from "@solana/kit";
import { decodeToken, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  formatTargetBlock,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { deriveConfidentialKeys } from "../confidential-keys.js";
import {
  formatPostApplyMismatch,
  formatPreSendKeyMismatch,
  formatUnreadableRefusal,
} from "../confidential-refusals.js";
import {
  classifyCounterFill,
  formatCounterFillingWarning,
  formatCounterFullWarning,
  formatPendingValueWarning,
  shouldWarnPendingValue,
} from "../confidential-warnings.js";
import {
  readConfidentialTransferAccount,
  type ConfidentialTransferAccountExtension,
} from "../confidential-account.js";
import {
  decryptDecryptableBalance,
  decryptPendingBalance,
  encryptDecryptableBalance,
} from "../confidential-balance.js";
import { formatDdcAmount } from "../amount.js";
import { NETWORK_FEE_LINE } from "../announcements.js";
import { assembleApplyPendingTransaction } from "../tx/apply-pending-tx.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { TOKEN_2022_PROGRAM } from "../constants.js";

const USAGE =
  "apply-pending: usage — apply-pending --keypair <path> --rpc-url <url>";

/** Named so the reader's return type stays on one line. */
type ExtensionOrAbsent = ConfidentialTransferAccountExtension | undefined;

/** The announcement header. Count rendered plainly. */
export function formatApplyHeader(credits: bigint): string {
  const noun = credits === 1n ? "pending credit" : "pending credits";
  return `APPLY PENDING BALANCE — folding ${credits} ${noun} into your confidential balance`;
}

/**
 * The zero-stop. No figure appears: this branch performs no
 * derivation, and a figure printed without decrypting would
 * be stated rather than computed. The command prints this and stops.
 */
export const APPLY_ZERO_STOP =
  "Nothing to apply — pending credit counter 0. No transaction was sent and no fee was paid.";

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

  const [tokenAccount] = await findAssociatedTokenPda({
    owner: signer.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: config.mint,
  });

  const rpc = createRpc(config.rpcUrl);
  const readExtension = async (): Promise<ExtensionOrAbsent> =>
    readConfidentialTransferAccount(
      decodeToken(
        await fetchEncodedAccount(rpc, tokenAccount, {
          commitment: config.commitment,
        }),
      ),
    );

  // BLOCKHASH BEFORE THE ACCOUNT READ: one fewer round trip
  // between the counter this command reads and the counter the network sees.
  // It is fetched even on the two stop paths below, which cost nothing but a
  // read; the ordering is what shortens the send window.
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: config.commitment })
    .send();

  const extension = await readExtension();
  if (extension === undefined) {
    console.log(APPLY_UNACTIVATED_STOP);
    return;
  }
  const creditsAtRead = extension.pendingBalanceCreditCounter;
  if (creditsAtRead === 0n) {
    console.log(APPLY_ZERO_STOP);
    return;
  }

  // READ BEFORE DERIVE is discharged by the two stops above: neither costs the
  // holder a signature. Only here is the wallet asked, once.
  const keys = await deriveConfidentialKeys({
    signer,
    owner: signer.address,
    mint: config.mint,
  });
  const derived = getAddressDecoder().decode(keys.elgamalPublicKey);
  if (derived !== extension.elgamalPubkey) {
    throw new Error(
      formatPreSendKeyMismatch({
        onChainKey: extension.elgamalPubkey,
        derivedKey: derived,
      }),
    );
  }

  const confidential = decryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    new Uint8Array(extension.decryptableAvailableBalance),
  );
  const pending = decryptPendingBalance(
    new Uint8Array(keys.elgamalSecretKey),
    new Uint8Array(extension.pendingBalanceLow),
    new Uint8Array(extension.pendingBalanceHigh),
  );
  // THE SIXTH REFUSAL. The confidential figure
  // is tested FIRST so that, when both are unreadable, the message names the
  // figure the display order names first.
  if (!confidential.readable) {
    throw new Error(formatUnreadableRefusal("confidential"));
  }
  if (!pending.readable) {
    throw new Error(formatUnreadableRefusal("pending"));
  }

  // THRESHOLD WARNINGS, printed before
  // the announcement because they describe the state being acted on. The
  // counter trigger is computed against the EXACT cap read from THIS account's
  // extension, never a rounded or shared figure.
  if (shouldWarnPendingValue(pending.baseUnits)) {
    console.log(formatPendingValueWarning(pending.baseUnits));
  }
  const cap = extension.maximumPendingBalanceCreditCounter;
  const fill = classifyCounterFill(creditsAtRead, cap);
  if (fill === "filling") {
    console.log(formatCounterFillingWarning(creditsAtRead, cap));
  } else if (fill === "full") {
    console.log(formatCounterFullWarning(creditsAtRead));
  }

  // THE ARITHMETIC: available plus pending. The guarded
  // wrapper throws rather than letting the encoder wrap silently at 2^64.
  const confidentialAfter = confidential.baseUnits + pending.baseUnits;
  const newDecryptableAvailableBalance = encryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    confidentialAfter,
  );

  // THE SECOND COUNTER READ, placed immediately before the
  // announcement so the announcement is the last thing between the holder and
  // the send. A moved counter means every figure above is stale.
  const atSend = await readExtension();
  if (atSend === undefined) {
    throw new Error(
      `token account ${tokenAccount} stopped reporting a ConfidentialTransferAccount extension between this command's two reads. Nothing was sent and no fee was paid.`,
    );
  }
  if (atSend.pendingBalanceCreditCounter !== creditsAtRead) {
    throw new Error(
      formatCounterMovedRefusal({
        atRead: creditsAtRead,
        atSend: atSend.pendingBalanceCreditCounter,
      }),
    );
  }

  console.log(
    formatApplyAnnouncement({
      credits: creditsAtRead,
      pendingBaseUnits: pending.baseUnits,
      confidentialAfterBaseUnits: confidentialAfter,
      cluster: config.rpcUrl,
      clusterSource: config.source.rpcUrl,
    }),
  );

  // ONE SIGNER, knowingly temporary. A relay fee payer would add
  // a second signature slot, and the single-signer assertion in
  // tx/apply-pending-tx.test.ts is what forces the fee copy to be re-read on
  // the day it does. THE COUNTER PASSED HERE IS creditsAtRead — see the header.
  const { transaction, tokenAccount: assembledFor } =
    await assembleApplyPendingTransaction({
      signer,
      mint: config.mint,
      newDecryptableAvailableBalance,
      expectedPendingBalanceCreditCounter: creditsAtRead,
      blockhash,
    });
  if (assembledFor !== tokenAccount) {
    throw new Error(
      `token account derived twice and differs: ${tokenAccount} here, ${assembledFor} in the assembly — nothing was sent`,
    );
  }
  assertIsFullySignedTransaction(transaction); // single signer ⇒ fully signed

  const signature = await broadcastAndConfirm(
    rpc,
    getBase64EncodedWireTransaction(transaction),
    config.commitment,
    "APPLY-PENDING",
  );

  // POST-SEND READ-BACK: EXPECTED against ACTUAL, both fields
  // off ONE decode. A difference means a credit landed
  // between this command's read and the network's execution, so the balance
  // copy just written is short.
  const after = await readExtension();
  if (after === undefined) {
    throw new Error(
      `APPLY-PENDING: the network confirmed signature ${signature}, but token account ${tokenAccount} no longer reports a ConfidentialTransferAccount extension. Most likely a stale or lagging RPC read. Re-read from a second RPC endpoint before doing anything else, and do NOT repeat this command until you have.`,
    );
  }
  if (
    after.expectedPendingBalanceCreditCounter !==
    after.actualPendingBalanceCreditCounter
  ) {
    console.log(
      formatPostApplyMismatch({
        expected: after.expectedPendingBalanceCreditCounter,
        actual: after.actualPendingBalanceCreditCounter,
      }),
    );
    return;
  }
  console.log(
    formatApplySuccess({
      signature,
      credits: creditsAtRead,
      confidentialAfterBaseUnits: confidentialAfter,
    }),
  );
}
