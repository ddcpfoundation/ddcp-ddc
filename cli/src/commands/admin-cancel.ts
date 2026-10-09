// `ddc admin cancel <issuer|operator>` — the security escape hatch, covering
// BOTH durable-nonce accounts.
// A single-signer, ORDINARY-blockhash transaction whose ONE instruction is
// System AdvanceNonceAccount over the SELECTED durable-nonce account —
// advancing the nonce invalidates ANY pending admin transaction pinned to
// its current value. The issuer nonce carries I-2/I-3/I-5; the Operator nonce
// carries I-6/I-8. This is NOT the two-party durable-nonce lifecycle: no
// envelope is read or written; unlike submit, cancel LOADS the selected
// role's key and signs. INSPECT by default — only --broadcast sends.
// FAIL-CLOSED: the selector/--role coupling assert, the role guard and the
// nonce-authority check all run before signing.

import { parseArgs } from "node:util";
import {
  AccountRole,
  appendTransactionMessageInstruction,
  assertIsFullySignedTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  formatTargetBlock,
  requireSigningIdentity,
  requireStatedCluster,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import { deriveMintStatePda } from "../pda.js";
import { decodeMintState } from "../mint-state.js";
import { loadSignerFromFile } from "../signer.js";
import { assertRoleAuthority, type Role } from "../role-guard.js";
import { nonceValueFromAccountData } from "./admin-countersign.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import {
  ISSUER_NONCE_ACCOUNT,
  OPERATOR_NONCE_ACCOUNT,
  SYSTEM_PROGRAM,
  SYSVAR_RECENT_BLOCKHASHES,
} from "../constants.js";

// Instruction with accounts and data always present (both are optional on
// the base kit type; this builder always sets them).
export interface AdvanceNonceInstruction extends Instruction {
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

/**
 * HAND-BUILT System AdvanceNonceAccount (no @solana-program/system dep):
 * data is u32 LE 4 (04000000 — the value verified on-chain as ix0 of the
 * live mint transaction); the three accounts mirror that verified ix0 —
 * nonce account (writable), recent-blockhashes sysvar (readonly), nonce
 * authority (readonly signer).
 */
export function buildAdvanceNonceInstruction(
  nonceAccount: Address,
  recentBlockhashesSysvar: Address,
  nonceAuthority: Address,
): AdvanceNonceInstruction {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: nonceAccount, role: AccountRole.WRITABLE },
      { address: recentBlockhashesSysvar, role: AccountRole.READONLY },
      { address: nonceAuthority, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([4, 0, 0, 0]),
  };
}

/**
 * Pure selector parse (extracted for unit testing, mirroring
 * admin-publish-reserve-statement's parsePublishReserveStatementArgs). The required
 * positional names WHICH durable-nonce account to advance: a CLOSED two-value
 * set, deliberately not a free-form nonce-account address — an address
 * argument would let an operator advance any nonce account they hold authority
 * over, including an unrelated or wrong-cluster one — and deliberately not
 * optional-with-a-default, since a silent default on a destructive command is
 * the defect class the stated-cluster guard closed. `reserve` is refused by name:
 * there is no Reserve nonce account, because only the initiating parties are nonce
 * authorities.
 */
export function parseCancelArgs(selectorRaw: string | undefined): {
  nonceRole: Role;
  nonceAccount: Address;
} {
  if (selectorRaw === undefined) {
    throw new Error(
      "admin cancel: usage — admin cancel <issuer|operator> --keypair <path> --role <issuer|operator> [--broadcast]",
    );
  }
  if (selectorRaw === "issuer") {
    return { nonceRole: "issuer", nonceAccount: ISSUER_NONCE_ACCOUNT };
  }
  if (selectorRaw === "operator") {
    return { nonceRole: "operator", nonceAccount: OPERATOR_NONCE_ACCOUNT };
  }
  throw new Error(
    `admin cancel: the nonce selector must be exactly one of "issuer", "operator" — got "${selectorRaw}". There is no reserve nonce account: only the initiating parties are nonce authorities.`,
  );
}

export interface CancelInspection {
  nonceLabel: string;
  nonceAccount: Address;
  currentNonceValue: string;
  nonceAuthority: Address;
  feePayer: Address;
}

/** Pure inspection block for operator review before any send. */
export function formatCancelInspection(input: CancelInspection): string {
  const lines: string[] = [];
  lines.push(`nonce account  : ${input.nonceAccount} (${input.nonceLabel})`);
  lines.push(`nonce value    : ${input.currentNonceValue} (current)`);
  lines.push(
    `nonce authority: ${input.nonceAuthority} (matched: the --keypair signer; live on-chain ${input.nonceLabel} — role-guard enforced)`,
  );
  lines.push(`fee payer      : ${input.feePayer} (${input.nonceLabel} signer)`);
  lines.push(
    `WILL ADVANCE the ${input.nonceLabel} nonce FROM ${input.currentNonceValue} — this invalidates any pending transaction pinned to it.`,
  );
  return lines.join("\n");
}

export async function runAdminCancel(argv: string[]): Promise<void> {
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
  // positionals: ["admin", "cancel", <issuer|operator>]
  const [, , selectorRaw] = positionals;
  const { nonceRole, nonceAccount } = parseCancelArgs(selectorRaw);

  // SHAPE BEFORE IDENTITY: the positional parse and parseCancelArgs above run
  // FIRST so the usage message is reachable without --keypair/--role.
  // admin-submit.ts is the reference ordering; admin-publish-reserve-statement.ts is
  // the closest analogue. Do not move these checks back above the parse.
  const identity = requireSigningIdentity(config);
  // COUPLING ASSERT: the stated signing role must be the selected nonce's own
  // role, refused locally before any network read. Defence in depth — the
  // nonce-authority byte check below would also catch it, but only after a key
  // load and two RPC reads. The I-6 and I-8 signer frames carry the same kind
  // of assert, since a mismatched frame would fail only at the signature slot.
  if (identity.role !== nonceRole) {
    throw new Error(
      `admin cancel: --role "${identity.role}" does not match the selected "${nonceRole}" nonce — cancel is signed by the nonce authority, so the two must name the same role`,
    );
  }

  const signer = await loadSignerFromFile(identity.keypairPath);

  const rpc = createRpc(config.rpcUrl);
  const [mintStatePda] = await deriveMintStatePda(config.programId, config.mint);
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

  // Retired-key defense: refuse — before building or signing anything —
  // unless the loaded key is the CURRENT on-chain authority for the SELECTED
  // role (fresh PDA-1 read).
  assertRoleAuthority(nonceRole, signer.address, mintState);

  const { value: nonceInfo } = await rpc
    .getAccountInfo(nonceAccount, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!nonceInfo) {
    throw new Error(
      `${nonceRole} nonce account ${nonceAccount} not found on cluster ${config.rpcUrl}`,
    );
  }
  const [nonceBase64] = nonceInfo.data;
  const nonceBytes = Uint8Array.from(Buffer.from(nonceBase64, "base64"));
  const currentNonceValue = nonceValueFromAccountData(
    nonceBytes,
    nonceAccount,
  );
  // Independent authority confirmation from the account's own bytes [8:40]
  // (mirrors admin-serialize.ts).
  const nonceAuthority = getAddressDecoder().decode(nonceBytes.subarray(8, 40));
  if (nonceAuthority !== signer.address) {
    throw new Error(
      `${nonceRole} nonce account ${nonceAccount} authority is ${nonceAuthority}, not the signer ${signer.address} — cancel must be signed by the nonce authority`,
    );
  }

  // ORDINARY blockhash lifetime — deliberately NOT durable-nonce: the whole
  // point is to advance the nonce, not to consume it as a lifetime.
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: config.commitment })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        buildAdvanceNonceInstruction(
          nonceAccount,
          SYSVAR_RECENT_BLOCKHASHES,
          signer.address,
        ),
        m,
      ),
  );
  const signedTx = await partiallySignTransactionMessageWithSigners(message);
  assertIsFullySignedTransaction(signedTx);

  console.log(formatTargetBlock(config));
  console.log(
    formatCancelInspection({
      nonceLabel: nonceRole,
      nonceAccount,
      currentNonceValue,
      nonceAuthority,
      feePayer: signer.address,
    }),
  );

  if (!broadcast) {
    console.log(
      "INSPECT ONLY — not broadcast. Re-run with --broadcast to advance the nonce.",
    );
    return;
  }

  // Cluster must be stated explicitly to send. Runs AFTER the inspection block
  // and AFTER the INSPECT-ONLY return: inspect-mode invocations keep working on
  // the devnet default; only a real send is gated.
  requireStatedCluster(config);

  await broadcastAndConfirm(
    rpc,
    getBase64EncodedWireTransaction(signedTx),
    config.commitment,
    "CANCEL",
  );

  const { value: nonceAfterInfo } = await rpc
    .getAccountInfo(nonceAccount, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!nonceAfterInfo) {
    throw new Error(
      `${nonceRole} nonce account ${nonceAccount} not found on re-read after cancel`,
    );
  }
  const [nonceAfterBase64] = nonceAfterInfo.data;
  const newNonceValue = nonceValueFromAccountData(
    Uint8Array.from(Buffer.from(nonceAfterBase64, "base64")),
    nonceAccount,
  );
  console.log(`nonce (post)   : ${newNonceValue}`);
  console.log(
    `cancel complete — ${nonceRole} nonce advanced FROM ${currentNonceValue} TO ${newNonceValue}; re-ground before the next admin action`,
  );
}
