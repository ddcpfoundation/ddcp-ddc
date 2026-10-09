// `ddc admin issuance-pause` — I-4 pause_issuance: the issuance pause. A
// single-signer, ORDINARY-blockhash transaction (I-4 is any-1-of-3; no
// durable nonce, no envelope) whose ONE program
// instruction is pause_issuance. Sets pause_active: true, blocking I-2 mint
// only — burns (I-3), user transfers, and resume (I-5) are unaffected.
// Idempotent on-chain. Unlike cancel there is NO role hardcode: all three
// roles are valid; the fail-closed check is the role-guard of the STATED
// role against a fresh PDA-1 read, before signing. INSPECT by default —
// only --broadcast sends. Mirrors commands/admin-cancel.ts in shape.

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
import { deriveMintStatePda } from "../pda.js";
import { decodeMintState } from "../mint-state.js";
import { loadSignerFromFile } from "../signer.js";
import { assertRoleAuthority, type Role } from "../role-guard.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { buildPauseIssuanceInstruction } from "../instructions/pause-issuance.js";

export interface PauseInspection {
  mint: Address;
  mintStatePda: Address;
  currentPauseActive: boolean;
  role: Role;
  authority: Address;
}

/** Pure inspection block for operator review before any send. */
export function formatPauseInspection(input: PauseInspection): string {
  const lines: string[] = [];
  lines.push(`mint           : ${input.mint}`);
  lines.push(`PDA-1          : ${input.mintStatePda}`);
  lines.push(`issuance paused (current): ${input.currentPauseActive} (PDA-1 pause_active)`);
  lines.push(
    `role/authority : ${input.role} / ${input.authority} (matched live PDA-1 — role-guard enforced)`,
  );
  lines.push(
    `WILL SET pause_active = true — blocks I-2 mint only; burns (I-3), user transfers, and resume (I-5) are UNAFFECTED.`,
  );
  if (input.currentPauseActive) {
    lines.push(`note: issuance is already paused — this send is an idempotent no-op.`);
  }
  return lines.join("\n");
}

export async function runAdminPause(argv: string[]): Promise<void> {
  const config = resolveConfig(argv);
  // NO role hardcode (unlike cancel): I-4 is any-1-of-3 — issuer,
  // operator, and reserve are ALL valid; requireSigningIdentity already guarantees
  // identity.role is one of the three. The authorization check is the
  // role-guard below, against the live PDA-1.
  const identity = requireSigningIdentity(config);

  const { values } = parseArgs({
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
  // unless the loaded key is the CURRENT on-chain authority for the STATED
  // role (fresh PDA-1 read). This is the entire client-side I-4
  // authorization check; on-chain enforcement is Unauthorized (6001).
  assertRoleAuthority(identity.role, signer.address, mintState);

  // ORDINARY blockhash lifetime — I-4 is single-signer: no durable
  // nonce, no AdvanceNonceAccount.
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: config.commitment })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        buildPauseIssuanceInstruction({
          mint: config.mint,
          mintState: mintStatePda,
          authority: signer.address, // == matched authority (guard passed)
        }),
        m,
      ),
  );
  const signedTx = await partiallySignTransactionMessageWithSigners(message);
  assertIsFullySignedTransaction(signedTx); // single-signer ⇒ fully signed

  console.log(formatTargetBlock(config));
  console.log(
    formatPauseInspection({
      mint: config.mint,
      mintStatePda,
      currentPauseActive: mintState.pauseActive,
      role: identity.role,
      authority: signer.address,
    }),
  );

  if (!broadcast) {
    console.log(
      "INSPECT ONLY — not broadcast. Re-run with --broadcast to pause issuance.",
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
    "ISSUANCE-PAUSE",
  );

  const { value: pdaAfterAccount } = await rpc
    .getAccountInfo(mintStatePda, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!pdaAfterAccount) {
    throw new Error(
      `PDA-1 MintState account ${mintStatePda} not found on re-read after issuance-pause`,
    );
  }
  const [pdaAfterBase64] = pdaAfterAccount.data;
  const mintStateAfter = decodeMintState(
    Uint8Array.from(Buffer.from(pdaAfterBase64, "base64")),
  );
  console.log(`issuance paused (post): ${mintStateAfter.pauseActive} (PDA-1 pause_active)`);
  console.log(
    `issuance-pause complete — pause_active now ${mintStateAfter.pauseActive}; re-ground before the next admin action`,
  );
}
