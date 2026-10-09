// `ddc admin publish-reserve-statement <amount> <uri>` — I-7 publish_attestation:
// the Reserve writes a reserve statement to PDA-2. The
// on-chain names (`publish_attestation`, `AttestationRecord`) are unchanged;
// only the command is named for what the record is. A
// single-signer, ORDINARY-blockhash transaction (I-7 is Reserve-only
// 1-of-1; no durable nonce, no envelope). PDA-2 is a PUBLIC transparency
// record, NOT a mint gate — I-2 never reads it. INSPECT by default; only
// --broadcast sends, and only after an interactive typed CONFIRM
// (C-interactive). Mirrors commands/admin-pause.ts in shape.

import { EXIT_NOT_DONE, type CommandOutcome } from "../exit-status.js";
import { parseArgs } from "node:util";
import {
  appendTransactionMessageInstruction,
  assertIsFullySignedTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import {
  formatTargetBlock,
  requireSigningIdentity,
  requireStatedCluster,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { deriveMintStatePda, deriveAttestationPda } from "../pda.js";
import { decodeMintState } from "../mint-state.js";
import { loadSignerFromFile } from "../signer.js";
import { assertRoleAuthority } from "../role-guard.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import {
  buildPublishAttestationInstruction,
  MAX_ATTESTATION_URI_BYTES,
} from "../instructions/publish-attestation.js";
import { promptTypedConfirm, type ConfirmPrompt } from "../confirm-prompt.js";

export interface PublishReserveStatementInspection {
  mint: Address;
  mintStatePda: Address;
  attestationPda: Address;
  reserveAuthority: Address;
  amount: bigint;
  uri: string;
  uriByteLength: number;
}

/** Pure inspection block for operator review before any send. */
export function formatPublishReserveStatementInspection(
  input: PublishReserveStatementInspection,
): string {
  const lines: string[] = [];
  lines.push(`mint              : ${input.mint}`);
  lines.push(`PDA-2 (target)    : ${input.attestationPda}`);
  lines.push(`PDA-1             : ${input.mintStatePda}`);
  lines.push(
    `reserve/authority : ${input.reserveAuthority} (matched live PDA-1 — role-guard enforced)`,
  );
  lines.push(
    `reserve amount    : ${input.amount} base units (6 dp, the reserve's value in the currency's unit of account)`,
  );
  lines.push(
    `attestation_uri   : ${input.uri} (${input.uriByteLength} bytes)`,
  );
  lines.push(
    `WILL OVERWRITE the PDA-2 record (AttestationRecord) — the prior reserve statement is discarded from the account (its history remains in the on-chain tx log).`,
  );
  lines.push(
    `This is a PUBLIC transparency record external parties may read. It is NOT a mint gate — I-2 never reads PDA-2.`,
  );
  return lines.join("\n");
}

/**
 * Pure arg validation (extracted for unit testing, mirroring
 * admin-countersign's confirm helpers): amount is a non-negative integer in
 * base units; uri is validated on its UTF-8 BYTE length (<= 128), matching the
 * on-chain InvalidAttestationUri bound. The builder re-guards the byte length
 * and the program is the final backstop. u64 range is enforced by the builder's
 * encoder, not here (parity with burn).
 */
export function parsePublishReserveStatementArgs(
  amountRaw: string | undefined,
  uriRaw: string | undefined,
): { amount: bigint; uri: string; uriByteLength: number } {
  if (amountRaw === undefined || uriRaw === undefined) {
    throw new Error(
      "admin publish-reserve-statement: usage — admin publish-reserve-statement <amount-base-units> <uri> --keypair <path> --role reserve [--broadcast]",
    );
  }
  if (!/^[0-9]+$/.test(amountRaw)) {
    throw new Error(
      `admin publish-reserve-statement: <amount> must be a non-negative integer in base units (6 dp), got "${amountRaw}"`,
    );
  }
  const uriByteLength = new TextEncoder().encode(uriRaw).length;
  if (uriByteLength > MAX_ATTESTATION_URI_BYTES) {
    throw new Error(
      `admin publish-reserve-statement: <uri> is ${uriByteLength} bytes (UTF-8); maximum is ${MAX_ATTESTATION_URI_BYTES}`,
    );
  }
  return { amount: BigInt(amountRaw), uri: uriRaw, uriByteLength };
}

export async function runAdminPublishReserveStatement(
  argv: string[],
  deps: { promptConfirm?: ConfirmPrompt } = {},
): Promise<CommandOutcome> {
  const promptConfirm = deps.promptConfirm ?? promptTypedConfirm;

  const config = resolveConfig(argv);

  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      "rpc-url": { type: "string" },
      config: { type: "string" },
      mint: { type: "string" },
      program: { type: "string" },
      keypair: { type: "string" },
      role: { type: "string" },
      broadcast: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });
  const broadcast = values["broadcast"] === true;
  // positionals: ["admin", "publish-reserve-statement", <amount>, <uri>]
  const [, , amountRaw, uriRaw] = positionals;
  const { amount, uri, uriByteLength } = parsePublishReserveStatementArgs(
    amountRaw,
    uriRaw,
  );

  // SHAPE BEFORE IDENTITY: the positional parse and parsePublishReserveStatementArgs
  // above run FIRST so the usage message is reachable without --keypair/--role.
  // admin-submit.ts is the reference ordering. Do not move these checks back
  // above the argument parsing.
  const identity = requireSigningIdentity(config);
  // Reserve-only (1-of-1) — unlike pause (any-1-of-3). Mirrors admin
  // countersign's reserve-only guard.
  if (identity.role !== "reserve") {
    throw new Error(
      `admin publish-reserve-statement: --role must be "reserve" — I-7 is Reserve-only 1-of-1 (got "${identity.role}")`,
    );
  }

  const signer = await loadSignerFromFile(identity.keypairPath);

  const rpc = createRpc(config.rpcUrl);
  const [mintStatePda] = await deriveMintStatePda(config.programId, config.mint);
  const [attestationPda] = await deriveAttestationPda(
    config.programId,
    config.mint,
  );

  const { value: pdaAccount } = await rpc
    .getAccountInfo(mintStatePda, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!pdaAccount) {
    throw new Error(
      `PDA-1 MintState account ${mintStatePda} not found on cluster ${config.rpcUrl}`,
    );
  }
  const [pdaBase64] = pdaAccount.data;
  const mintState = decodeMintState(
    Uint8Array.from(Buffer.from(pdaBase64, "base64")),
  );

  // Retired/wrong-Reserve-key defense: refuse before building or signing unless
  // the loaded key is the CURRENT on-chain reserve_authority (fresh PDA-1 read).
  // This is the entire client-side I-7 authorization check; on-chain
  // enforcement is Unauthorized (6001).
  assertRoleAuthority("reserve", signer.address, mintState);

  // PDA-2 existence check: I-7 WRITES an existing account (created + zeroed at
  // I-1) — it does not allocate. Existence-only; the program
  // enforces owner + derivation on-chain.
  const { value: attestationAccount } = await rpc
    .getAccountInfo(attestationPda, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!attestationAccount) {
    throw new Error(
      `PDA-2 AttestationRecord account ${attestationPda} not found on cluster ${config.rpcUrl} — I-7 writes an existing account (created at I-1), it does not allocate`,
    );
  }

  // ORDINARY blockhash — I-7 is single-signer: no durable nonce.
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: config.commitment })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        buildPublishAttestationInstruction({
          mint: config.mint,
          attestation: attestationPda,
          mintState: mintStatePda,
          reserveAuthority: signer.address, // == matched authority (guard passed)
          amount,
          uri,
        }),
        m,
      ),
  );
  const signedTx = await partiallySignTransactionMessageWithSigners(message);
  assertIsFullySignedTransaction(signedTx); // single-signer ⇒ fully signed

  console.log(formatTargetBlock(config));
  console.log(
    formatPublishReserveStatementInspection({
      mint: config.mint,
      mintStatePda,
      attestationPda,
      reserveAuthority: signer.address,
      amount,
      uri,
      uriByteLength,
    }),
  );

  if (!broadcast) {
    console.log(
      "INSPECT ONLY — not broadcast. Re-run with --broadcast to publish this reserve statement.",
    );
    return;
  }

  // Cluster must be stated explicitly to send. Runs AFTER the inspection block
  // and AFTER the INSPECT-ONLY return, and BEFORE the typed-CONFIRM prompt:
  // asking the operator to type CONFIRM and then refusing is the wrong order.
  requireStatedCluster(config);

  // C-interactive typed-CONFIRM gate — broadcast path only, AFTER the inspect
  // block. Not a flag: the operator must type CONFIRM. Injected via
  // deps.promptConfirm (default promptTypedConfirm) so tests stub it.
  const confirmed = await promptConfirm(
    `Type CONFIRM to publish this reserve statement (overwrites PDA-2 ${attestationPda}): `,
  );
  if (!confirmed) {
    console.log(
      "ABORTED — typed confirmation not received; nothing was broadcast.",
    );
    return EXIT_NOT_DONE;
  }

  await broadcastAndConfirm(
    rpc,
    getBase64EncodedWireTransaction(signedTx),
    config.commitment,
    "PUBLISH-RESERVE-STATEMENT",
  );

  console.log(
    `publish-reserve-statement complete — decode PDA-2 ${attestationPda} to confirm the new record; re-ground before the next admin action`,
  );
}
