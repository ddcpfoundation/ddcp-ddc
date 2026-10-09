// `ddc admin submit` — broadcast of a fully countersigned admin
// transaction: any of the five two-signature instructions (I-2 mint, I-3
// burn, I-5 resume, I-6 fee update, I-8 key rotation). INSPECT by default:
// without --broadcast the command re-verifies and reports but sends NOTHING.
// Order is load-bearing: parse envelope; fresh live reads (PDA-1 + nonce);
// full structural re-verify at the "submit" stage (the countersigner's slot
// must be SIGNED); fully-signed gate; sha256 byte-integrity print; inspection block; and only
// then — only under --broadcast — a single-shot send of the EXACT hashed
// wire bytes with normal preflight and no auto-retry. FAIL-CLOSED.
// Submit holds NO key: the transaction is already fully signed, so no
// signing identity is required and no keypair is ever loaded.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  assertIsFullySignedTransaction,
  getBase64Decoder,
  getTransactionDecoder,
  type Address,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import {
  formatTargetBlock,
  requireStatedCluster,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import {
  deriveFeeAuthorityPda,
  deriveMintStatePda,
  deriveRedemptionAuthorityPda,
} from "../pda.js";
import { decodeMintState } from "../mint-state.js";
import { decodeMintTransferFee } from "../mint-transfer-fee.js";
import { baseUnitsToDdc } from "./admin-serialize.js";
import { nonceValueFromAccountData } from "./admin-countersign.js";
import { parseAdminTxEnvelope } from "../tx/envelope.js";
import { decodeAdminTxWire } from "../tx/countersign-verify.js";
import { dispatchAdminVerify } from "../tx/admin-verify-dispatch.js";
import { broadcastAndConfirm } from "../tx/broadcast.js";
import { UPDATE_TRANSFER_FEE_DISCRIMINATOR } from "../instructions/update-transfer-fee.js";
import { ROTATE_SIGNER_DISCRIMINATOR } from "../instructions/rotate-signer.js";
import type { SignerFrame } from "../tx/admin-verify-core.js";
import {
  ISSUER_NONCE_ACCOUNT,
  OPERATOR_NONCE_ACCOUNT,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "../constants.js";

/** sha256 of the exact wire bytes, hex — computed, never hardcoded. */
export function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Fully-signed gate, wire-bytes edition. The explicit slot check runs FIRST
 * because a wire-decoded transaction represents an empty slot as 64 zero
 * bytes, which a naive non-null check would miscount as signed; kit's
 * assertIsFullySignedTransaction then stands as the final hard gate (the
 * same assertion countersign writes behind).
 */
export function assertEnvelopeFullySigned(transactionBytes: Uint8Array): void {
  const decoded = decodeAdminTxWire(transactionBytes);
  const unsigned = decoded.signatures.filter((s) => !s.signed);
  if (unsigned.length > 0) {
    throw new Error(
      `SUBMIT REFUSED (not fully signed): unsigned slot(s): ${unsigned
        .map((s) => s.address)
        .join(", ")}`,
    );
  }
  assertIsFullySignedTransaction(
    getTransactionDecoder().decode(transactionBytes),
  );
}

export interface SubmitInspection {
  amount: bigint;
  destination: Address;
  feePayer: Address;
  nonceValue: string;
  /** Current on-chain supply in base units (decimal string, live-read). */
  supplyBaseUnits: string;
  sha256Hex: string;
}

/**
 * Pure inspection block: everything shown is re-derived from the wire or
 * live-read — nothing comes from the envelope claim. The sha256 line lets
 * the operator match the file against the independently verified bytes.
 */
export function formatSubmitInspection(input: SubmitInspection): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state (submit stage: Reserve slot signed)",
  );
  lines.push("FULLY SIGNED   : every signature slot is signed");
  lines.push(
    `amount         : ${input.amount} base units = ${baseUnitsToDdc(input.amount)} DDC`,
  );
  lines.push(`destination    : ${input.destination}`);
  lines.push(`fee payer      : ${input.feePayer} (live issuer)`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `supply (pre)   : ${input.supplyBaseUnits} base units = ${baseUnitsToDdc(BigInt(input.supplyBaseUnits))} DDC`,
  );
  lines.push(`wire sha256    : ${input.sha256Hex}`);
  return lines.join("\n");
}

export interface BurnSubmitInspection {
  amount: bigint;
  source: Address;
  feePayer: Address;
  nonceValue: string;
  /** Current on-chain supply in base units (decimal string, live-read). */
  supplyBaseUnits: string;
  sha256Hex: string;
}

/** Burn flavor of the inspection block — supply DECREASES on confirm. */
export function formatBurnSubmitInspection(
  input: BurnSubmitInspection,
): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state (submit stage: Reserve slot signed)",
  );
  lines.push("FULLY SIGNED   : every signature slot is signed");
  lines.push(
    "instruction    : burn_tokens (redeems — supply and source balance DECREASE)",
  );
  lines.push(
    `amount         : ${input.amount} base units = ${baseUnitsToDdc(input.amount)} DDC`,
  );
  lines.push(`source         : ${input.source}`);
  lines.push(`fee payer      : ${input.feePayer} (live issuer)`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `supply (pre)   : ${input.supplyBaseUnits} base units = ${baseUnitsToDdc(BigInt(input.supplyBaseUnits))} DDC`,
  );
  lines.push(`wire sha256    : ${input.sha256Hex}`);
  return lines.join("\n");
}

export interface UpdateFeeSubmitInspection {
  newFeeBasisPoints: number;
  newMaximumFee: bigint;
  newMinimumFee: bigint;
  /** Current on-chain newer_transfer_fee bps (pre-send, live-read). */
  currentBasisPoints: number;
  /** Current on-chain newer_transfer_fee maximum (pre-send, live-read). */
  currentMaximumFee: bigint;
  /** Current PDA-1 minimum_fee (pre-send, live-read). */
  currentMinimumFee: bigint;
  feePayer: Address;
  nonceValue: string;
  sha256Hex: string;
}

/**
 * Update-fee flavor of the inspection block — shows the triple the tx WILL
 * set against the current on-chain newer_transfer_fee + PDA-1 minimum_fee.
 * I-6 is Operator-initiated, so the fee payer is the live operator.
 */
export function formatUpdateFeeSubmitInspection(
  input: UpdateFeeSubmitInspection,
): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state (submit stage: issuer countersigner slot signed)",
  );
  lines.push("FULLY SIGNED   : every signature slot is signed");
  lines.push(
    "instruction    : update_transfer_fee (sets bps/max via Token-2022 CPI, minimum_fee on PDA-1)",
  );
  lines.push(
    `will set       : fee ${input.newFeeBasisPoints} bps, maximum ${input.newMaximumFee} base units = ${baseUnitsToDdc(input.newMaximumFee)} DDC, minimum ${input.newMinimumFee} base units = ${baseUnitsToDdc(input.newMinimumFee)} DDC`,
  );
  lines.push(
    `current (pre)  : fee ${input.currentBasisPoints} bps, maximum ${input.currentMaximumFee} base units (newer_transfer_fee), minimum ${input.currentMinimumFee} base units (PDA-1) — the new rate takes effect two epochs after the epoch this lands in (Token-2022 schedules newer_transfer_fee at the current epoch + 2)`,
  );
  lines.push(`fee payer      : ${input.feePayer} (live operator)`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`wire sha256    : ${input.sha256Hex}`);
  return lines.join("\n");
}

export interface RotateSignerSubmitInspection {
  role: number;
  newPubkey: Address;
  /** Live PDA-1 authorities — the formatter maps target-role -> current holder. */
  liveIssuer: Address;
  liveOperator: Address;
  liveReserve: Address;
  feePayer: Address;
  nonceValue: string;
  sha256Hex: string;
}

/**
 * Rotate-signer flavor of the inspection block. Submit has NO confirm gate —
 * this print is the LAST human checkpoint before an irreversible rotation,
 * so the before/after line (current holder -> new signer) is derived from
 * the live PDA-1 read, never echoed from the wire or the envelope claim.
 * I-8 is Operator-initiated (fee payer = live operator) and Reserve-countersigned. A
 * target-role > 2 renders as unknown/rejected — the bound is judged on-chain
 * (InvalidRole), not here.
 */
export function formatRotateSignerSubmitInspection(
  input: RotateSignerSubmitInspection,
): string {
  const roleName =
    input.role === 0
      ? "Issuer"
      : input.role === 1
        ? "Operator"
        : input.role === 2
          ? "Reserve"
          : "unknown (rejected on-chain)";
  const currentHolder =
    input.role === 0
      ? input.liveIssuer
      : input.role === 1
        ? input.liveOperator
        : input.role === 2
          ? input.liveReserve
          : undefined;
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state (submit stage: Reserve countersigner slot signed)",
  );
  lines.push("FULLY SIGNED   : every signature slot is signed");
  lines.push(
    "instruction    : rotate_signer (overwrites the target role's authority pubkey in PDA-1 — no CPI)",
  );
  lines.push(
    `will rotate    : target-role ${input.role} (${roleName}) -> new signer ${input.newPubkey}`,
  );
  lines.push(
    currentHolder !== undefined
      ? `current (pre)  : role ${input.role} (${roleName}) authority is ${currentHolder} (live PDA-1) — after confirm it will be ${input.newPubkey}`
      : `current (pre)  : role ${input.role} does not exist on PDA-1 (roles are 0..2) — the transaction will be REJECTED on-chain (InvalidRole)`,
  );
  lines.push(
    "IRREVERSIBLE   : once confirmed, the rotated-out key cannot undo this — recovery requires another Operator+Reserve rotate_signer",
  );
  lines.push(`fee payer      : ${input.feePayer} (live operator)`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`wire sha256    : ${input.sha256Hex}`);
  return lines.join("\n");
}

export interface ResumeSubmitInspection {
  feePayer: Address;
  nonceValue: string;
  /** CURRENT PDA-1 pause_active (live-read) — expected true before resume. */
  pauseActive: boolean;
  sha256Hex: string;
}

/** Resume flavor of the inspection block — no amount/destination/supply. */
export function formatResumeSubmitInspection(
  input: ResumeSubmitInspection,
): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state (submit stage: Reserve slot signed)",
  );
  lines.push("FULLY SIGNED   : every signature slot is signed");
  lines.push(
    "instruction    : resume_issuance (no params — clears pause_active)",
  );
  lines.push(`fee payer      : ${input.feePayer} (live issuer)`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`pause_active   : ${input.pauseActive} (current PDA-1)`);
  lines.push(`wire sha256    : ${input.sha256Hex}`);
  return lines.join("\n");
}

export async function runAdminSubmit(argv: string[]): Promise<void> {
  // Deliberately NO requireSigningIdentity and NO keypair load (see header).
  const config = resolveConfig(argv);

  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      "rpc-url": { type: "string" },
      config: { type: "string" },
      mint: { type: "string" },
      program: { type: "string" },
      broadcast: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });
  // positionals: ["admin", "submit", <countersigned-envelope-path>]
  const [, , envelopePath] = positionals;
  if (envelopePath === undefined) {
    throw new Error(
      "admin submit: usage — admin submit <countersigned-envelope-path> [--broadcast]",
    );
  }
  const broadcast = values["broadcast"] === true;

  let envelopeJson: string;
  try {
    envelopeJson = readFileSync(envelopePath, "utf8");
  } catch {
    throw new Error(
      `admin submit: envelope file missing or not readable: ${envelopePath}`,
    );
  }
  // The claim block is untrusted convenience data — deliberately ignored;
  // everything below is re-derived from the wire bytes or live-read.
  const { transactionBytes } = parseAdminTxEnvelope(envelopeJson);
  const decoded = decodeAdminTxWire(transactionBytes);

  const rpc = createRpc(config.rpcUrl);
  const [mintStatePda] = await deriveMintStatePda(config.programId, config.mint);
  // PDA-5 (burn's redemption collection authority) — live-derived here in
  // the command layer, passed to dispatch; never wire-fed.
  const [redemptionAuthorityPda] = await deriveRedemptionAuthorityPda(
    config.programId,
    config.mint,
  );
  // PDA-3 (update-fee's fee authority) — live-derived here, dispatch uses it
  // only for update-fee wires.
  const [feeAuthorityPda] = await deriveFeeAuthorityPda(
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

  // Operator signer frame for update-fee wires: I-6 is Operator-initiated over the
  // Operator nonce and ISSUER-countersigned. Built unconditionally from the
  // fresh PDA-1 read; dispatch uses it only for update-fee wires.
  const operatorFrame: SignerFrame = {
    initiator: mintState.operator,
    initiatorLabel: "Operator",
    countersigner: mintState.issuer,
    countersignerLabel: "issuer",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
  };
  // Coupling assert (condition 2): the frame is built from PDA-1 and
  // re-checked against PDA-1 — tautological here, load-bearing as a tripwire
  // if any field is later sourced independently of the live mint state.
  if (
    operatorFrame.initiator !== mintState.operator ||
    operatorFrame.countersigner !== mintState.issuer ||
    operatorFrame.nonceAccount !== OPERATOR_NONCE_ACCOUNT
  ) {
    throw new Error(
      "admin submit: coupling assert failed — Operator frame diverges from live PDA-1 / OPERATOR_NONCE_ACCOUNT",
    );
  }

  // Rotate-signer frame for rotate_signer wires: I-8 is Operator-initiated over
  // the Operator nonce and Reserve-countersigned — a DISTINCT frame from I-6's
  // operatorFrame above (whose countersigner is the ISSUER). Built
  // unconditionally from the same fresh PDA-1 read; dispatch uses it only
  // for rotate_signer wires. Mirrors the 4b countersign site.
  const rotateOperatorFrame: SignerFrame = {
    initiator: mintState.operator,
    initiatorLabel: "Operator",
    countersigner: mintState.reserve,
    countersignerLabel: "Reserve",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
  };
  // Coupling assert (mirrors the operatorFrame one): tautological here,
  // load-bearing as a tripwire if any field is later sourced independently
  // of the live mint state.
  if (
    rotateOperatorFrame.initiator !== mintState.operator ||
    rotateOperatorFrame.countersigner !== mintState.reserve ||
    rotateOperatorFrame.nonceAccount !== OPERATOR_NONCE_ACCOUNT
  ) {
    throw new Error(
      "admin submit: coupling assert failed — rotate Operator frame diverges from live PDA-1 / OPERATOR_NONCE_ACCOUNT",
    );
  }

  // Nonce read is WIRE-DRIVEN: the expected nonce account is keyed on the
  // wire ix1 discriminator (the Operator-initiated instructions — update-fee and
  // rotate-signer — run over the Operator nonce, everything else over the issuer
  // nonce), and the wire's ix0 nonce account must match it before the live
  // read.
  const disc = Buffer.from(
    decoded.instructions[1]?.data.subarray(0, 8) ?? new Uint8Array(0),
  ).toString("hex");
  const isOperatorInitiated =
    disc === Buffer.from(UPDATE_TRANSFER_FEE_DISCRIMINATOR).toString("hex") ||
    disc === Buffer.from(ROTATE_SIGNER_DISCRIMINATOR).toString("hex");
  const expectedNonce = isOperatorInitiated
    ? OPERATOR_NONCE_ACCOUNT
    : ISSUER_NONCE_ACCOUNT;
  const nonceLabel = isOperatorInitiated ? "operator" : "issuer";
  const wireNonceAccount = decoded.instructions[0]?.accounts?.[0];
  if (wireNonceAccount === undefined) {
    throw new Error("admin submit: decoded instruction 0 has no nonce account");
  }
  if (wireNonceAccount !== expectedNonce) {
    throw new Error(
      `admin submit: transaction nonce account ${wireNonceAccount} is not the expected ${nonceLabel} nonce ${expectedNonce} for this instruction`,
    );
  }
  const { value: nonceInfo } = await rpc
    .getAccountInfo(wireNonceAccount, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!nonceInfo) {
    throw new Error(
      `${nonceLabel} nonce account ${wireNonceAccount} not found on cluster ${config.rpcUrl}`,
    );
  }
  const [nonceBase64] = nonceInfo.data;
  const liveNonceValue = nonceValueFromAccountData(
    Uint8Array.from(Buffer.from(nonceBase64, "base64")),
    wireNonceAccount,
  );

  // Target disclosure, printed ONCE here rather than in each per-instruction
  // branch: this is straight-line code reached on every path, and nothing in
  // this file prints before it. Deliberately ahead of the structural-refusal
  // print below — a refusal caused by pointing at the wrong cluster is
  // indistinguishable from a genuinely malformed envelope without it.
  console.log(formatTargetBlock(config));

  const verdict = dispatchAdminVerify(
    decoded,
    {
      liveIssuer: mintState.issuer,
      liveReserve: mintState.reserve,
      liveNonceValue,
      issuerNonceAccount: ISSUER_NONCE_ACCOUNT,
      mint: config.mint,
      mintStatePda,
      token2022Program: TOKEN_2022_PROGRAM,
      programId: config.programId,
      systemProgram: SYSTEM_PROGRAM,
    },
    "submit",
    redemptionAuthorityPda,
    { feeAuthority: feeAuthorityPda, operatorFrame },
    { operatorFrame: rotateOperatorFrame },
  );
  if (!verdict.ok) {
    const message = `SUBMIT REFUSED (structural): ${verdict.reason}`;
    throw new Error(message);
  }

  assertEnvelopeFullySigned(transactionBytes);

  const wireSha256 = sha256HexOf(transactionBytes);

  switch (verdict.instruction) {
    case "mint_tokens": {
      const { value: supplyBefore } = await rpc
        .getTokenSupply(config.mint, { commitment: config.commitment })
        .send();

      console.log(
        formatSubmitInspection({
          amount: verdict.amount,
          destination: verdict.destination,
          feePayer: decoded.feePayer,
          nonceValue: liveNonceValue,
          supplyBaseUnits: supplyBefore.amount,
          sha256Hex: wireSha256,
        }),
      );
      break;
    }
    case "burn_tokens": {
      const { value: supplyBefore } = await rpc
        .getTokenSupply(config.mint, { commitment: config.commitment })
        .send();

      console.log(
        formatBurnSubmitInspection({
          amount: verdict.amount,
          source: verdict.source,
          feePayer: decoded.feePayer,
          nonceValue: liveNonceValue,
          supplyBaseUnits: supplyBefore.amount,
          sha256Hex: wireSha256,
        }),
      );
      break;
    }
    case "update_transfer_fee": {
      const { value: mintAccount } = await rpc
        .getAccountInfo(config.mint, {
          encoding: "base64",
          commitment: config.commitment,
        })
        .send();
      if (!mintAccount) {
        throw new Error(
          `mint account ${config.mint} not found on cluster ${config.rpcUrl}`,
        );
      }
      const [mintBase64] = mintAccount.data;
      const currentFee = decodeMintTransferFee(
        Uint8Array.from(Buffer.from(mintBase64, "base64")),
      );

      console.log(
        formatUpdateFeeSubmitInspection({
          newFeeBasisPoints: verdict.newFeeBasisPoints,
          newMaximumFee: verdict.newMaximumFee,
          newMinimumFee: verdict.newMinimumFee,
          currentBasisPoints: currentFee.basisPoints,
          currentMaximumFee: currentFee.maximumFee,
          currentMinimumFee: mintState.minimumFee,
          feePayer: decoded.feePayer,
          nonceValue: liveNonceValue,
          sha256Hex: wireSha256,
        }),
      );
      break;
    }
    case "rotate_signer": {
      // Submit has no confirm gate, so this inspection print is the last
      // human checkpoint before an irreversible action.
      console.log(
        formatRotateSignerSubmitInspection({
          role: verdict.role,
          newPubkey: verdict.newPubkey,
          liveIssuer: mintState.issuer,
          liveOperator: mintState.operator,
          liveReserve: mintState.reserve,
          feePayer: decoded.feePayer,
          nonceValue: liveNonceValue,
          sha256Hex: wireSha256,
        }),
      );
      break;
    }
    case "resume_issuance": {
      console.log(
        formatResumeSubmitInspection({
          feePayer: decoded.feePayer,
          nonceValue: liveNonceValue,
          pauseActive: mintState.pauseActive,
          sha256Hex: wireSha256,
        }),
      );
      break;
    }
    default: {
      const _exhaustive: never = verdict;
      throw new Error(
        `admin submit: unhandled instruction "${(_exhaustive as { instruction: string }).instruction}" in the submit inspection chain`,
      );
    }
  }

  if (!broadcast) {
    console.log(
      "INSPECT ONLY — not broadcast. Re-run with --broadcast to send.",
    );
    return;
  }

  // Cluster must be stated explicitly to send. Runs AFTER the inspection
  // output and AFTER the INSPECT-ONLY return: inspect-mode invocations keep
  // working on the devnet default; only a real send is gated. This is the
  // sharpest case for the guard — the transaction arriving here is already
  // fully signed, so the only remaining question is which cluster it goes to.
  requireStatedCluster(config);

  // --broadcast: single-shot send of the EXACT bytes hashed above.
  const wireB64 = getBase64Decoder().decode(
    transactionBytes,
  ) as Base64EncodedWireTransaction;
  const signature = await broadcastAndConfirm(
    rpc,
    wireB64,
    config.commitment,
    "SUBMIT",
  );

  switch (verdict.instruction) {
    case "mint_tokens": {
      const { value: supplyAfter } = await rpc
        .getTokenSupply(config.mint, { commitment: config.commitment })
        .send();
      console.log(
        `supply (post)  : ${supplyAfter.amount} base units = ${baseUnitsToDdc(BigInt(supplyAfter.amount))} DDC`,
      );
      const { value: destAfter } = await rpc
        .getTokenAccountBalance(verdict.destination, {
          commitment: config.commitment,
        })
        .send();
      console.log(
        `destination    : ${destAfter.amount} base units = ${baseUnitsToDdc(BigInt(destAfter.amount))} DDC (${verdict.destination})`,
      );
      break;
    }
    case "burn_tokens": {
      const { value: supplyAfter } = await rpc
        .getTokenSupply(config.mint, { commitment: config.commitment })
        .send();
      console.log(
        `supply (post)  : ${supplyAfter.amount} base units = ${baseUnitsToDdc(BigInt(supplyAfter.amount))} DDC (expect DOWN by the burn amount)`,
      );
      const { value: sourceAfter } = await rpc
        .getTokenAccountBalance(verdict.source, {
          commitment: config.commitment,
        })
        .send();
      console.log(
        `source         : ${sourceAfter.amount} base units = ${baseUnitsToDdc(BigInt(sourceAfter.amount))} DDC (${verdict.source}, expect DOWN)`,
      );
      break;
    }
    case "update_transfer_fee": {
      // No token-account read — update-fee touches no token account. Re-read
      // the mint (bps/max) and PDA-1 (minimum_fee) for the after-state.
      const { value: mintAfter } = await rpc
        .getAccountInfo(config.mint, {
          encoding: "base64",
          commitment: config.commitment,
        })
        .send();
      if (!mintAfter) {
        throw new Error(
          `mint account ${config.mint} not found on re-read after update-fee`,
        );
      }
      const [mintAfterBase64] = mintAfter.data;
      const feeAfter = decodeMintTransferFee(
        Uint8Array.from(Buffer.from(mintAfterBase64, "base64")),
      );
      const { value: pdaAfter } = await rpc
        .getAccountInfo(mintStatePda, {
          encoding: "base64",
          commitment: config.commitment,
        })
        .send();
      if (!pdaAfter) {
        throw new Error(
          `PDA-1 MintState account ${mintStatePda} not found on re-read after update-fee`,
        );
      }
      const [pdaAfterBase64] = pdaAfter.data;
      const stateAfter = decodeMintState(
        Uint8Array.from(Buffer.from(pdaAfterBase64, "base64")),
      );
      console.log(
        `fee (post)     : ${feeAfter.basisPoints} bps, maximum ${feeAfter.maximumFee} base units (newer_transfer_fee — effective two epochs after the epoch this landed in), minimum ${stateAfter.minimumFee} base units (PDA-1)`,
      );
      break;
    }
    case "rotate_signer": {
      // Re-read PDA-1 and report the authority NOW stored for the rotated
      // role — confirmed from chain state, never echoed from the wire.
      // (A role > 2 cannot reach here with a confirmed signature — the
      // program rejects it with InvalidRole — but the guard keeps this
      // branch honest rather than mismapping an impossible value.)
      if (verdict.role > 2) {
        console.log(
          "rotate (post)  : target-role > 2 — the program rejects this (InvalidRole); no PDA-1 authority changed",
        );
      } else {
        const { value: pdaAfter } = await rpc
          .getAccountInfo(mintStatePda, {
            encoding: "base64",
            commitment: config.commitment,
          })
          .send();
        if (!pdaAfter) {
          throw new Error(
            `PDA-1 MintState account ${mintStatePda} not found on re-read after rotate`,
          );
        }
        const [pdaAfterBase64] = pdaAfter.data;
        const stateAfter = decodeMintState(
          Uint8Array.from(Buffer.from(pdaAfterBase64, "base64")),
        );
        const roleLabel =
          verdict.role === 0 ? "issuer" : verdict.role === 1 ? "operator" : "reserve";
        const storedAfter =
          verdict.role === 0
            ? stateAfter.issuer
            : verdict.role === 1
              ? stateAfter.operator
              : stateAfter.reserve;
        console.log(
          `rotated (post) : ${storedAfter} (post-confirm PDA-1 ${roleLabel}_authority for target-role ${verdict.role})`,
        );
        if (verdict.role === 1 || verdict.role === 2) {
          console.log(
            "NOTE           : the rotated role co-signs two-party admin operations — subsequent serialize/countersign must use the NEW key",
          );
        }
      }
      break;
    }
    case "resume_issuance": {
      const { value: pdaAfter } = await rpc
        .getAccountInfo(mintStatePda, {
          encoding: "base64",
          commitment: config.commitment,
        })
        .send();
      if (!pdaAfter) {
        throw new Error(
          `PDA-1 MintState account ${mintStatePda} not found on re-read after resume`,
        );
      }
      const [pdaAfterBase64] = pdaAfter.data;
      const stateAfter = decodeMintState(
        Uint8Array.from(Buffer.from(pdaAfterBase64, "base64")),
      );
      console.log(
        `pause_active   : ${stateAfter.pauseActive} (post-confirm PDA-1)`,
      );
      break;
    }
    default: {
      // The broadcast has already confirmed — an unhandled instruction here
      // must not throw away the signature line below.
      const _exhaustive: never = verdict;
      console.log(
        `WARNING        : unhandled instruction "${(_exhaustive as { instruction: string }).instruction}" — no after-state report is available for it`,
      );
    }
  }
  console.log(
    `broadcast complete — signature ${signature}; re-ground the nonce and supply independently before the next admin action`,
  );
}
