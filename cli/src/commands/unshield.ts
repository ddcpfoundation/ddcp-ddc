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
import {
  assertIsFullySignedTransaction,
  fetchEncodedAccount,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Signature,
} from "@solana/kit";
import { decodeToken, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  formatTargetBlock,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
  type ConfigSource,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { deriveConfidentialKeys } from "../confidential-keys.js";
import {
  formatPreSendKeyMismatch,
  formatUnreadableRefusal,
} from "../confidential-refusals.js";
import {
  readActivationState,
  readConfidentialTransferAccount,
} from "../confidential-account.js";
import {
  decryptDecryptableBalance,
  encryptDecryptableBalance,
} from "../confidential-balance.js";
import { NETWORK_FEE_LINE } from "../announcements.js";
import { formatDdcAmount, parseDdcAmount } from "../amount.js";
import { TOKEN_2022_PROGRAM } from "../constants.js";
import {
  CONFIRM_ABORTED_BEFORE_SEND,
  promptTypedConfirm,
  TYPED_CONFIRM_QUESTION,
  type ConfirmPrompt,
} from "../confirm-prompt.js";
import { requireTransactionFormatActive } from "../transaction-format.js";
import { buildUnshieldProofs } from "../tx/unshield-proofs.js";
import { assembleUnshieldTransaction } from "../tx/unshield-tx.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";

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
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: signer.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: config.mint,
  });
  const rpc = createRpc(config.rpcUrl);
  // FORMAT GATE, the first live read: network state, refused by name.
  await requireTransactionFormatActive({
    rpc,
    commitment: config.commitment,
    cluster: config.rpcUrl,
    operation: UNSHIELD_OPERATION,
  });
  const readToken = async () =>
    decodeToken(
      await fetchEncodedAccount(rpc, tokenAccount, { commitment: config.commitment }),
    );
  const account = await readToken();
  const state = readActivationState(account);
  const extension = readConfidentialTransferAccount(account);
  if (state.kind !== "configured" || extension === undefined) {
    console.log(UNSHIELD_UNCONFIGURED_STOP);
    return EXIT_NOT_DONE;
  }
  if (!state.approved) {
    throw new Error(UNSHIELD_UNAPPROVED_STOP);
  }
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
  if (!confidential.readable) {
    throw new Error(formatUnreadableRefusal("confidential"));
  }
  if (amountBaseUnits > confidential.baseUnits) {
    throw new Error(
      formatInsufficientConfidentialRefusal({
        amountBaseUnits,
        confidentialBaseUnits: confidential.baseUnits,
      }),
    );
  }
  const availableBalanceCiphertext = new Uint8Array(extension.availableBalance);
  const proofs = buildUnshieldProofs({
    elgamalSecretKey: new Uint8Array(keys.elgamalSecretKey),
    availableBalanceCiphertext,
    availableBaseUnits: confidential.baseUnits,
    amountBaseUnits,
  });
  const newDecryptableAvailableBalance = encryptDecryptableBalance(
    new Uint8Array(keys.aeKey),
    proofs.remainingBaseUnits,
  );
  const publicBefore = account.exists ? account.data.amount : 0n;
  console.log(
    formatUnshieldAnnouncement({
      amountBaseUnits,
      confidentialAfterBaseUnits: proofs.remainingBaseUnits,
      publicAfterBaseUnits: publicBefore + amountBaseUnits,
      cluster: config.rpcUrl,
      clusterSource: config.source.rpcUrl,
    }),
  );
  // CONFIRM: read once, after the announcement, before the
  // send. Anything but the exact word aborts with nothing sent.
  if (!(await promptConfirm(TYPED_CONFIRM_QUESTION))) {
    console.log(CONFIRM_ABORTED_BEFORE_SEND);
    return EXIT_NOT_DONE;
  }
  // RE-READ before the send: byte equality against the ciphertext the proofs
  // were built over, or the command refuses with its own sentence.
  const beforeSend = readConfidentialTransferAccount(await readToken());
  if (
    beforeSend === undefined ||
    !sameBytes(new Uint8Array(beforeSend.availableBalance), availableBalanceCiphertext)
  ) {
    throw new Error(formatBalanceMovedRefusal());
  }
  const blockhash = (await rpc.getLatestBlockhash({ commitment: config.commitment }).send()).value;
  const { transaction } = await assembleUnshieldTransaction({
    signer,
    mint: config.mint,
    amountBaseUnits,
    newDecryptableAvailableBalance,
    equalityProof: proofs.equalityProof,
    rangeProof: proofs.rangeProof,
    blockhash,
  });
  assertIsFullySignedTransaction(transaction);
  console.log(`UNSHIELD wire size : ${getTransactionEncoder().encode(transaction).length} bytes`);
  let signature: Signature;
  try {
    signature = await broadcastAndConfirm(
      rpc,
      getBase64EncodedWireTransaction(transaction),
      config.commitment,
      "UNSHIELD",
    );
  } catch (err) {
    console.log((err as Error).message);
    console.log(UNSHIELD_AFTER_FAILED_SEND);
    throw err;
  }
  const after = await readToken();
  const afterExtension = readConfidentialTransferAccount(after);
  const afterConfidential =
    afterExtension === undefined
      ? { readable: false as const, reason: "the extension is gone" }
      : decryptDecryptableBalance(
          new Uint8Array(keys.aeKey),
          new Uint8Array(afterExtension.decryptableAvailableBalance),
        );
  console.log(
    formatUnshieldSuccess({
      signature,
      amountBaseUnits,
      confidentialAfterBaseUnits: afterConfidential.readable
        ? afterConfidential.baseUnits
        : proofs.remainingBaseUnits,
      publicAfterBaseUnits: after.exists ? after.data.amount : 0n,
    }),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (const [i, byte] of a.entries()) {
    if (byte !== b[i]) return false;
  }
  return true;
}
