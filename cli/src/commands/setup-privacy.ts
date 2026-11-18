// `ddc setup-privacy` — activate confidential balance on the wallet's DDC
// token account. The FIRST user command: ONE secret (--keypair) and no
// --role; NO --broadcast — the consent prompt is the single
// gate and prints the inspection content BEFORE it asks; `--consent
// confidential-balance` answers it non-interactively; the prompt
// has no default. Order:
//   shape → keyboard pre-check → target block → requireStatedCluster →
//   identity → token account → live read → stop if configured → consent →
//   derive → blockhash → assemble → wire size → send → read back.
//
// THE CONSENT COPY IS EXACT ON ONE POINT: key loss is NOT a ground.
// Both secrets derive from the wallet key on every invocation, so activation
// creates no backup obligation, and the copy must not say otherwise. The two
// real grounds are that ConfigureAccount is near-irreversible per account and
// that the derivation signature is a permanent, unrecorded viewing capability.
//
// WHY THE KEY IS DERIVED ON THE ALREADY-CONFIGURED PATH: the
// account already carries a key, so the viewing capability already exists for
// whoever configured it; deriving creates nothing new, and a mismatch is
// exactly the finding a holder needs to see.

import { EXIT_NOT_DONE, type CommandOutcome } from "../exit-status.js";
import { parseArgs } from "node:util";
import { stdin } from "node:process";
import { type Address } from "@solana/kit";
import {
  formatTargetBlock,
  requireStatedCluster,
  requireWalletIdentity,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { loadSignerFromFile } from "../signer.js";
import { formatReadBackFailed, formatReadBackMismatch } from "../confidential-refusals.js";
import { type ActivationState } from "../confidential-account.js";
import {
  MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
  PROOF_INSTRUCTION_OFFSET,
  REALLOCATE_EXTENSION_TYPES,
} from "../tx/confidential-setup-tx.js";
import { activateConfidentialBalances, checkActivation } from "../holder/setup-privacy.js";
import { HolderRefusal, type HolderRefusalReason } from "../holder/refusal.js";
import { withRefusalText } from "../holder-refusal-text.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { promptYesNo, type YesNoPrompt } from "../confirm-prompt.js";

/** The one value --consent accepts: it names what is consented to. */
export const CONSENT_VALUE = "confidential-balance";
/** The flag as a user types it; every refusal that names it uses this string. */
export const CONSENT_FLAG = `--consent ${CONSENT_VALUE}`;
/** The consent question, verbatim except for the no-default answer form. */
export const CONSENT_QUESTION =
  "Activate Confidential Balances? (strongly recommended) [y/n] ";

const USAGE =
  "setup-privacy: usage — setup-privacy --keypair <path> [--consent confidential-balance] [--rpc-url <url>]";

/**
 * Pure: the consent flag's three states. Absent → not consented. The exact
 * value → consented. Anything else — including a bare `--consent`, which
 * Node's parseArgs delivers as boolean true under strict:false — is the usage
 * error, naming the one value accepted.
 */
export function parseConsentFlag(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === CONSENT_VALUE) return true;
  const shown = value === true ? "no value" : JSON.stringify(value);
  throw new Error(
    `${USAGE}\n--consent takes exactly the value "${CONSENT_VALUE}" — it names what is consented to; got ${shown}`,
  );
}

export interface ConsentInput {
  cluster: string;
  wallet: Address;
  tokenAccount: Address;
  state: ActivationState;
}

/** Pure: the consent explanation and the inspection block, printed BEFORE the question. */
export function formatConsentBlock(input: ConsentInput): string {
  const accountNote =
    input.state.kind === "absent"
      ? "does not exist yet — instruction 1 creates it"
      : "exists, Confidential Balances not yet activated — instruction 1 is a no-op";
  return [
    "CONFIDENTIAL BALANCES — what activation does, and what it does not",
    "  Confidential Balances is opt-in, and strongly recommended.",
    "  One wallet signature derives your privacy keys. They need NO separate backup:",
    "  they are re-derived from the wallet every time they are used, and cannot be",
    "  lost on their own; only losing the wallet key itself loses them.",
    "  The same signature derives the same keys for every token that uses the Solana",
    "  standard, not only this one. A signature shown to anyone else exposes the",
    "  confidential balances of this wallet on all such tokens.",
    "  Activation writes the PUBLIC half of the key into your DDC token account.",
    "  That is not casually reversible: changing the key later means emptying the",
    "  confidential balance and reconfiguring the account.",
    "  That signature is a permanent viewing capability: anyone who obtains it can",
    "  read this wallet's confidential amounts, now and in the future, and the only",
    "  remedy is moving to a new wallet. This tool derives the keys from it in",
    "  memory, on each use, and writes it nowhere. Sign this message only in",
    "  software you would trust with your balances.",
    "WILL SEND, self-pay, one transaction",
    `  cluster        : ${input.cluster}`,
    `  wallet (owner) : ${input.wallet}`,
    `  token account  : ${input.tokenAccount} (${accountNote})`,
    "  1. CreateAssociatedTokenIdempotent",
    `  2. Reallocate for extension types ${REALLOCATE_EXTENSION_TYPES.join(" and ")}`,
    `  3. ConfigureAccount (pending-credit cap ${MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER}, proof at +${PROOF_INSTRUCTION_OFFSET})`,
    "  4. VerifyPubkeyValidity (ZK ElGamal Proof program)",
    `  fee payer      : ${input.wallet} (rent for the account, plus the fee)`,
  ].join("\n");
}

export interface SetupPrivacyDeps {
  /** The consent prompt; tests inject a stub. */
  promptYesNo?: YesNoPrompt;
  /** Whether stdin is a keyboard; tests inject a constant. */
  isKeyboard?: () => boolean;
}

export async function runSetupPrivacy(
  argv: string[],
  deps: SetupPrivacyDeps = {},
): Promise<CommandOutcome> {
  const prompt = deps.promptYesNo ?? promptYesNo;
  const isKeyboard = deps.isKeyboard ?? (() => stdin.isTTY === true);

  const config = resolveConfig(argv);

  // SHAPE BEFORE IDENTITY: the flag parse and the consent-value check run first
  // so the usage message is reachable without --keypair.
  const { values } = parseArgs({
    args: argv,
    options: {
      "rpc-url": { type: "string" },
      config: { type: "string" },
      mint: { type: "string" },
      program: { type: "string" },
      keypair: { type: "string" },
      role: { type: "string" },
      consent: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  const consented = parseConsentFlag(values["consent"]);

  // KEYBOARD PRE-CHECK: with no keyboard and no consent flag
  // the question could never be asked, so refuse here, before anything else.
  if (!consented && !isKeyboard()) {
    throw new Error(
      `setup-privacy: no keyboard on stdin, so the consent question cannot be asked. To run without one, state consent on the command line: ${CONSENT_FLAG}`,
    );
  }

  console.log(formatTargetBlock(config));
  // Cluster must be stated to send; runs BEFORE the prompt and
  // names this command, not --broadcast.
  requireStatedCluster(config, "setup-privacy");

  const identity = requireWalletIdentity(config);
  const signer = await loadSignerFromFile(identity.keypairPath);
  const rpc = createRpc(config.rpcUrl);
  const ctx = { rpc, commitment: config.commitment, mint: config.mint };
  return withRefusalText(async () => {
    // ACTIVATION PRE-CHECK: a configured account is never re-sent —
    // ConfigureAccount would fail on-chain after the fee was paid.
    const check = await checkActivation(ctx, signer);
    if (check.kind === "already-activated") {
      console.log(
        `ALREADY ACTIVATED — token account ${check.tokenAccount} carries ElGamal public key ${check.onChainKey} (approved: ${check.approved})`,
      );
      if (check.matches) {
        console.log(
          "the on-chain key MATCHES the key this wallet derives; nothing to do, nothing sent",
        );
        return;
      }
      throw new HolderRefusal({ kind: "key-mismatch", onChainKey: check.onChainKey, derivedKey: check.derivedKey });
    }

    // CONSENT: the inspection content prints first; the flag answers the
    // question, otherwise the y/n prompt with no default asks it.
    console.log(
      formatConsentBlock({
        cluster: config.rpcDisplay,
        wallet: signer.address,
        tokenAccount: check.tokenAccount,
        state: check.state,
      }),
    );
    if (consented) {
      console.log(
        `consent stated on the command line (${CONSENT_FLAG}); the question is not asked`,
      );
    } else if (!(await prompt(CONSENT_QUESTION))) {
      console.log(
        "DECLINED — Confidential Balances not activated; nothing was sent, and your balance stays public. Run this command again when ready.",
      );
      return EXIT_NOT_DONE;
    }

    // DERIVE — only after consent: ONE wallet signature.
    const result = await activateConfidentialBalances(ctx, {
      signer,
      tokenAccount: check.tokenAccount,
      beforeSubmit: ({ derivedKey, wireBytes }) => {
        console.log(`ElGamal public key : ${derivedKey}`);
        console.log(`wire size          : ${wireBytes} bytes`);
      },
      submit: (wire) => broadcastAndConfirm(rpc, wire, config.commitment, "SETUP-PRIVACY"),
      onReadBack: (readBack) => {
        console.log(
          `READ BACK ${readBack.tokenAccount}: ConfidentialTransferAccount present, elgamalPubkey ${readBack.elgamalPubkey}, approved ${readBack.approved}`,
        );
      },
    });
    console.log(
      `setup-privacy complete — signature ${result.signature}; Confidential Balances is now active on ${result.tokenAccount}`,
    );
  }, setupPrivacyRefusalText);
}

/** The read-back sentences `setup-privacy` has always printed. */
function setupPrivacyRefusalText(reason: HolderRefusalReason): string | undefined {
  switch (reason.kind) {
    case "activation-read-back-failed":
      return formatReadBackFailed({ signature: reason.signature, tokenAccount: reason.tokenAccount, stateKind: reason.stateKind });
    case "activation-read-back-mismatch":
      return formatReadBackMismatch({ onChainKey: reason.onChainKey, derivedKey: reason.derivedKey, signature: reason.signature });
    default:
      return undefined;
  }
}
