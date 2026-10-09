// `ddc admin countersign` — the countersign half of the two-party admin
// lifecycle, dispatching five instructions; the countersigner is the ISSUER
// for update_transfer_fee and the Reserve for the other four. Order is
// load-bearing: parse + confirm flags first; structural verify against LIVE
// chain state (fresh PDA-1 + nonce reads); the typed-confirmation gate; only
// THEN load the countersigner's key, role-guard it (retired/wrong-key
// defense), apply the countersignature, and hard-gate on fully-signed before
// writing the countersigned envelope.
// FAIL-CLOSED: any refused check throws before anything is signed.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  address,
  assertIsFullySignedTransaction,
  getBase58Decoder,
  type Address,
} from "@solana/kit";
import {
  formatTargetBlock,
  requireSigningIdentity,
  resolveConfig,
} from "../config.js";
import { createRpc } from "../rpc.js";
import {
  deriveFeeAuthorityPda,
  deriveMintStatePda,
  deriveRedemptionAuthorityPda,
} from "../pda.js";
import { decodeMintState } from "../mint-state.js";
import { decideBurnSource, toBurnSourceRead } from "../burn-source.js";
import { decideDistinctCoSigners } from "../co-signers.js";
import { loadSignerFromFile } from "../signer.js";
import { assertRoleAuthority, type Role } from "../role-guard.js";
import { baseUnitsToDdc } from "./admin-serialize.js";
import {
  parseAdminTxEnvelope,
  serializeAdminTxEnvelope,
  type AdminTxClaim,
} from "../tx/envelope.js";
import { decodeAdminTxWire } from "../tx/countersign-verify.js";
import { dispatchAdminVerify } from "../tx/admin-verify-dispatch.js";
import { applyReserveCountersignature } from "../tx/countersign-apply.js";
import { UPDATE_TRANSFER_FEE_DISCRIMINATOR } from "../instructions/update-transfer-fee.js";
import { ROTATE_SIGNER_DISCRIMINATOR } from "../instructions/rotate-signer.js";
import type { SignerFrame } from "../tx/admin-verify-core.js";
import {
  ISSUER_NONCE_ACCOUNT,
  OPERATOR_NONCE_ACCOUNT,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "../constants.js";

// Single 6-dp formatter, shared with admin-serialize so the two cannot drift.
export { baseUnitsToDdc };

/**
 * The human typed-confirmation gate: Reserve states what it approves; this
 * compares it to what the verified transaction ACTUALLY does. FAIL-CLOSED —
 * the command refuses to sign on any ok:false.
 */
export function checkConfirmation(
  verified: { amount: bigint; destination: Address },
  confirm: { amount: bigint; destination: Address },
): { ok: true } | { ok: false; reason: string } {
  if (
    confirm.amount !== verified.amount ||
    confirm.destination !== verified.destination
  ) {
    return {
      ok: false,
      reason:
        `you approved ${confirm.amount} base units -> ${confirm.destination}, ` +
        `but the transaction mints ${verified.amount} base units -> ${verified.destination}`,
    };
  }
  return { ok: true };
}

export function countersignedOutPath(inputPath: string): string {
  return inputPath.endsWith(".json")
    ? `${inputPath.slice(0, -".json".length)}-countersigned.json`
    : `${inputPath}-countersigned.json`;
}

// Claim remains untrusted convenience data; submit re-derives from bytes.
export function buildCountersignedClaim(
  original: AdminTxClaim,
  reserveAddress: Address,
): AdminTxClaim {
  return {
    ...original,
    signedBy: [...original.signedBy, reserveAddress],
    awaitingSignature: "none",
  };
}

/**
 * Current nonce value from a durable-nonce account's raw data: bytes
 * [40, 72) of the 80-byte layout, base58. Single source for the offset
 * math — `admin countersign`, `admin submit`, and `admin cancel` all use
 * this rather than re-deriving offsets.
 */
export function nonceValueFromAccountData(
  nonceBytes: Uint8Array,
  nonceAccount: Address,
): string {
  if (nonceBytes.length < 72) {
    throw new Error(
      `nonce account ${nonceAccount} data is ${nonceBytes.length} bytes — expected the 80-byte nonce layout`,
    );
  }
  return getBase58Decoder().decode(nonceBytes.subarray(40, 72));
}

export interface CountersignDecodeInput {
  amount: bigint;
  destination: Address;
  liveIssuer: Address;
  liveReserve: Address;
  nonceValue: string;
  outPath: string;
}

/** Pure record of what passed verification and what Reserve confirmed. */
export function formatCountersignDecode(input: CountersignDecodeInput): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state",
  );
  lines.push(
    `amount         : ${input.amount} base units = ${baseUnitsToDdc(input.amount)} DDC`,
  );
  lines.push(`destination    : ${input.destination}`);
  lines.push(
    `CONFIRM MATCH  : approved == transaction (${input.amount} base units -> ${input.destination})`,
  );
  lines.push(
    `live issuer    : ${input.liveIssuer} (matched: fee payer + issuer slot)`,
  );
  lines.push(
    `live reserve : ${input.liveReserve} (matched: awaiting countersign slot; must equal the --keypair signer — role-guard enforced before signing)`,
  );
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`countersigned  : ${input.outPath}`);
  return lines.join("\n");
}

/**
 * Fail-loud five-way stray-flag matrix: each instruction REFUSES the other
 * instructions' confirm flags rather than silently ignoring them — the
 * operator believed they were gating something. mint_tokens takes
 * --confirm-amount + --confirm-destination; burn_tokens takes
 * --confirm-amount + --confirm-source; update_transfer_fee takes
 * --confirm-fee-bps + --confirm-max-fee + --confirm-min-fee; rotate_signer
 * takes --confirm-target-role + --confirm-new-signer;
 * resume_issuance takes none.
 * (Whether the REQUIRED flags are present is each instruction's own gate,
 * which runs separately.)
 */
export function assertNoStrayConfirmFlags(
  instruction:
    | "mint_tokens"
    | "resume_issuance"
    | "burn_tokens"
    | "update_transfer_fee"
    | "rotate_signer",
  confirmAmountRaw: string | undefined,
  confirmDestinationRaw: string | undefined,
  confirmSourceRaw: string | undefined,
  confirmFeeBpsRaw: string | undefined,
  confirmMaxFeeRaw: string | undefined,
  confirmMinFeeRaw: string | undefined,
  confirmTargetRoleRaw: string | undefined,
  confirmNewSignerRaw: string | undefined,
): void {
  if (instruction === "rotate_signer") {
    const stray =
      confirmAmountRaw !== undefined
        ? "--confirm-amount"
        : confirmDestinationRaw !== undefined
          ? "--confirm-destination"
          : confirmSourceRaw !== undefined
            ? "--confirm-source"
            : confirmFeeBpsRaw !== undefined
              ? "--confirm-fee-bps"
              : confirmMaxFeeRaw !== undefined
                ? "--confirm-max-fee"
                : confirmMinFeeRaw !== undefined
                  ? "--confirm-min-fee"
                  : undefined;
    if (stray !== undefined) {
      throw new Error(
        `admin countersign: ${stray} is not a rotate_signer confirm item — rotate_signer takes --confirm-target-role and --confirm-new-signer`,
      );
    }
    return;
  }
  // Every non-rotate instruction refuses the rotate flags (the second
  // direction of the matrix — checked before the per-instruction branches so
  // update_transfer_fee's early return cannot skip it).
  const strayRotateFlag =
    confirmTargetRoleRaw !== undefined
      ? "--confirm-target-role"
      : confirmNewSignerRaw !== undefined
        ? "--confirm-new-signer"
        : undefined;
  if (strayRotateFlag !== undefined) {
    throw new Error(
      `admin countersign: ${strayRotateFlag} is not a confirm item for ${instruction} — the rotate flags belong to rotate_signer`,
    );
  }
  if (instruction === "update_transfer_fee") {
    const stray =
      confirmAmountRaw !== undefined
        ? "--confirm-amount"
        : confirmDestinationRaw !== undefined
          ? "--confirm-destination"
          : confirmSourceRaw !== undefined
            ? "--confirm-source"
            : undefined;
    if (stray !== undefined) {
      throw new Error(
        `admin countersign: ${stray} is not an update_transfer_fee confirm item — update_transfer_fee takes --confirm-fee-bps, --confirm-max-fee, and --confirm-min-fee`,
      );
    }
    return;
  }
  const strayFeeFlag =
    confirmFeeBpsRaw !== undefined
      ? "--confirm-fee-bps"
      : confirmMaxFeeRaw !== undefined
        ? "--confirm-max-fee"
        : confirmMinFeeRaw !== undefined
          ? "--confirm-min-fee"
          : undefined;
  if (strayFeeFlag !== undefined) {
    throw new Error(
      `admin countersign: ${strayFeeFlag} is not a confirm item for ${instruction} — the fee flags belong to update_transfer_fee`,
    );
  }
  if (instruction === "resume_issuance") {
    if (
      confirmAmountRaw !== undefined ||
      confirmDestinationRaw !== undefined ||
      confirmSourceRaw !== undefined
    ) {
      throw new Error(
        "admin countersign: resume_issuance has no confirm items — remove --confirm-amount/--confirm-destination/--confirm-source",
      );
    }
    return;
  }
  switch (instruction) {
    case "mint_tokens":
      if (confirmSourceRaw !== undefined) {
        throw new Error(
          "admin countersign: --confirm-source is not a mint_tokens confirm item — mint_tokens takes --confirm-amount and --confirm-destination",
        );
      }
      return;
    case "burn_tokens":
      if (confirmDestinationRaw !== undefined) {
        throw new Error(
          "admin countersign: --confirm-destination is not a burn_tokens confirm item — burn_tokens takes --confirm-amount and --confirm-source",
        );
      }
      return;
    default: {
      const _exhaustive: never = instruction;
      throw new Error(
        `admin countersign: unhandled instruction "${String(_exhaustive)}" in the stray-confirm matrix`,
      );
    }
  }
}

export interface ResumeCountersignDecodeInput {
  liveIssuer: Address;
  liveReserve: Address;
  nonceValue: string;
  outPath: string;
}

/** Resume flavor of the decode record — no amount/destination (no params). */
export function formatResumeCountersignDecode(
  input: ResumeCountersignDecodeInput,
): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state",
  );
  lines.push(
    "instruction    : resume_issuance (no params — clears pause_active)",
  );
  lines.push(
    `live issuer    : ${input.liveIssuer} (matched: fee payer + issuer slot)`,
  );
  lines.push(
    `live reserve : ${input.liveReserve} (matched: awaiting countersign slot; must equal the --keypair signer — role-guard enforced before signing)`,
  );
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`countersigned  : ${input.outPath}`);
  return lines.join("\n");
}

function parseConfirmDestination(raw: string): Address {
  try {
    return address(raw);
  } catch {
    throw new Error(
      `admin countersign: --confirm-destination "${raw}" is not a valid address`,
    );
  }
}

function parseConfirmSource(raw: string): Address {
  try {
    return address(raw);
  } catch {
    throw new Error(
      `admin countersign: --confirm-source "${raw}" is not a valid address`,
    );
  }
}

/**
 * Burn's fail-closed confirm requirement (mirrors mint's inline gate): both
 * flags mandatory, amount a non-negative integer, source a valid address.
 * Returns the parsed pair for checkBurnConfirmation.
 */
export function requireBurnConfirmFlags(
  confirmAmountRaw: string | undefined,
  confirmSourceRaw: string | undefined,
): { amount: bigint; source: Address } {
  if (confirmAmountRaw === undefined || confirmSourceRaw === undefined) {
    throw new Error(
      "admin countersign: you must confirm the amount and source you approve, via --confirm-amount <base-units> --confirm-source <address>",
    );
  }
  if (!/^[0-9]+$/.test(confirmAmountRaw)) {
    throw new Error(
      `admin countersign: --confirm-amount must be a non-negative integer in base units (6 dp), got "${confirmAmountRaw}"`,
    );
  }
  return {
    amount: BigInt(confirmAmountRaw),
    source: parseConfirmSource(confirmSourceRaw),
  };
}

/**
 * Burn's typed-confirmation gate: Reserve states what it approves; this
 * compares it to what the verified transaction ACTUALLY burns. FAIL-CLOSED
 * — the command refuses to sign on any ok:false.
 */
export function checkBurnConfirmation(
  verified: { amount: bigint; source: Address },
  confirm: { amount: bigint; source: Address },
): { ok: true } | { ok: false; reason: string } {
  if (
    confirm.amount !== verified.amount ||
    confirm.source !== verified.source
  ) {
    return {
      ok: false,
      reason:
        `you approved burning ${confirm.amount} base units from ${confirm.source}, ` +
        `but the transaction burns ${verified.amount} base units from ${verified.source}`,
    };
  }
  return { ok: true };
}

export interface BurnCountersignDecodeInput {
  amount: bigint;
  source: Address;
  liveIssuer: Address;
  liveReserve: Address;
  nonceValue: string;
  outPath: string;
}

/** Burn flavor of the decode record. */
export function formatBurnCountersignDecode(
  input: BurnCountersignDecodeInput,
): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state",
  );
  lines.push(
    `amount         : ${input.amount} base units = ${baseUnitsToDdc(input.amount)} DDC`,
  );
  lines.push(`source         : ${input.source}`);
  lines.push(
    `CONFIRM MATCH  : approved == transaction (burn ${input.amount} base units from ${input.source})`,
  );
  lines.push(
    `live issuer    : ${input.liveIssuer} (matched: fee payer + issuer slot)`,
  );
  lines.push(
    `live reserve : ${input.liveReserve} (matched: awaiting countersign slot; must equal the --keypair signer — role-guard enforced before signing)`,
  );
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`countersigned  : ${input.outPath}`);
  return lines.join("\n");
}

/**
 * Update-fee's fail-closed confirm requirement (mirrors burn's): all three
 * flags mandatory; bps a 0..65535 integer; max/min non-negative integers in
 * base units. Returns the parsed triple for checkUpdateFeeConfirmation.
 */
export function requireUpdateFeeConfirmFlags(
  confirmFeeBpsRaw: string | undefined,
  confirmMaxFeeRaw: string | undefined,
  confirmMinFeeRaw: string | undefined,
): { newFeeBasisPoints: number; newMaximumFee: bigint; newMinimumFee: bigint } {
  if (
    confirmFeeBpsRaw === undefined ||
    confirmMaxFeeRaw === undefined ||
    confirmMinFeeRaw === undefined
  ) {
    throw new Error(
      "admin countersign: you must confirm the full fee triple you approve, via --confirm-fee-bps <bps> --confirm-max-fee <base-units> --confirm-min-fee <base-units>",
    );
  }
  if (!/^[0-9]+$/.test(confirmFeeBpsRaw)) {
    throw new Error(
      `admin countersign: --confirm-fee-bps must be a non-negative integer (basis points), got "${confirmFeeBpsRaw}"`,
    );
  }
  const newFeeBasisPoints = Number(confirmFeeBpsRaw);
  if (newFeeBasisPoints > 65535) {
    throw new Error(
      `admin countersign: --confirm-fee-bps must fit u16 (0..65535), got ${newFeeBasisPoints}`,
    );
  }
  if (!/^[0-9]+$/.test(confirmMaxFeeRaw)) {
    throw new Error(
      `admin countersign: --confirm-max-fee must be a non-negative integer in base units (6 dp), got "${confirmMaxFeeRaw}"`,
    );
  }
  if (!/^[0-9]+$/.test(confirmMinFeeRaw)) {
    throw new Error(
      `admin countersign: --confirm-min-fee must be a non-negative integer in base units (6 dp), got "${confirmMinFeeRaw}"`,
    );
  }
  return {
    newFeeBasisPoints,
    newMaximumFee: BigInt(confirmMaxFeeRaw),
    newMinimumFee: BigInt(confirmMinFeeRaw),
  };
}

/**
 * Update-fee's typed-confirmation gate: the issuer countersigner states the
 * triple it approves; this compares it to what the verified transaction
 * ACTUALLY sets. FAIL-CLOSED — the command refuses to sign on any ok:false.
 */
export function checkUpdateFeeConfirmation(
  verified: {
    newFeeBasisPoints: number;
    newMaximumFee: bigint;
    newMinimumFee: bigint;
  },
  confirm: {
    newFeeBasisPoints: number;
    newMaximumFee: bigint;
    newMinimumFee: bigint;
  },
): { ok: true } | { ok: false; reason: string } {
  if (
    confirm.newFeeBasisPoints !== verified.newFeeBasisPoints ||
    confirm.newMaximumFee !== verified.newMaximumFee ||
    confirm.newMinimumFee !== verified.newMinimumFee
  ) {
    return {
      ok: false,
      reason:
        `you approved fee ${confirm.newFeeBasisPoints} bps / max ${confirm.newMaximumFee} / min ${confirm.newMinimumFee} base units, ` +
        `but the transaction sets fee ${verified.newFeeBasisPoints} bps / max ${verified.newMaximumFee} / min ${verified.newMinimumFee} base units`,
    };
  }
  return { ok: true };
}

export interface UpdateFeeCountersignDecodeInput {
  newFeeBasisPoints: number;
  newMaximumFee: bigint;
  newMinimumFee: bigint;
  liveOperator: Address;
  liveIssuer: Address;
  nonceValue: string;
  outPath: string;
}

/**
 * Update-fee flavor of the decode record — I-6 is Operator-initiated and
 * ISSUER-countersigned, so the matched-slot labels flip relative to the
 * issuer-initiated instructions.
 */
export function formatUpdateFeeCountersignDecode(
  input: UpdateFeeCountersignDecodeInput,
): string {
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state",
  );
  lines.push(
    `fee            : ${input.newFeeBasisPoints} bps, maximum ${input.newMaximumFee} base units = ${baseUnitsToDdc(input.newMaximumFee)} DDC, minimum ${input.newMinimumFee} base units = ${baseUnitsToDdc(input.newMinimumFee)} DDC`,
  );
  lines.push(
    `CONFIRM MATCH  : approved == transaction (fee ${input.newFeeBasisPoints} bps / max ${input.newMaximumFee} / min ${input.newMinimumFee} base units)`,
  );
  lines.push(
    `live operator  : ${input.liveOperator} (matched: fee payer + operator slot)`,
  );
  lines.push(
    `live issuer    : ${input.liveIssuer} (countersigner — matched: awaiting countersign slot; must equal the --keypair signer, role-guard enforced before signing)`,
  );
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`countersigned  : ${input.outPath}`);
  return lines.join("\n");
}

/**
 * Rotate-signer's fail-closed confirm requirement (mirrors update-fee's):
 * both flags mandatory; target-role a 0..255 integer (the u8 encoder bound —
 * the role<=2 bound is owned by the on-chain InvalidRole check, mirroring
 * parseRotateArgs in admin-serialize); new-signer a valid address. Returns
 * the parsed pair for checkRotateSignerConfirmation.
 */
export function requireRotateSignerConfirmFlags(
  confirmTargetRoleRaw: string | undefined,
  confirmNewSignerRaw: string | undefined,
): { role: number; newPubkey: Address } {
  if (confirmTargetRoleRaw === undefined || confirmNewSignerRaw === undefined) {
    throw new Error(
      "admin countersign: you must confirm the rotation you approve, via --confirm-target-role <target-role> --confirm-new-signer <address>",
    );
  }
  if (!/^[0-9]+$/.test(confirmTargetRoleRaw)) {
    throw new Error(
      `admin countersign: --confirm-target-role must be a non-negative integer (0=Issuer, 1=Operator, 2=Reserve), got "${confirmTargetRoleRaw}"`,
    );
  }
  const role = Number(confirmTargetRoleRaw);
  if (role > 255) {
    throw new Error(
      `admin countersign: --confirm-target-role must fit u8 (0..255), got ${role}`,
    );
  }
  let newPubkey: Address;
  try {
    newPubkey = address(confirmNewSignerRaw);
  } catch {
    throw new Error(
      `admin countersign: --confirm-new-signer "${confirmNewSignerRaw}" is not a valid address`,
    );
  }
  return { role, newPubkey };
}

/**
 * Rotate-signer's typed-confirmation gate: the Reserve countersigner states the
 * rotation it approves; this compares it to what the verified transaction
 * ACTUALLY rotates. FAIL-CLOSED — the command refuses to sign on any
 * ok:false. This gate is the ONLY client-side control on the rotation
 * values: the structural verify surfaces role + new_pubkey but
 * never judges them.
 */
export function checkRotateSignerConfirmation(
  verified: { role: number; newPubkey: Address },
  confirm: { role: number; newPubkey: Address },
): { ok: true } | { ok: false; reason: string } {
  if (
    confirm.role !== verified.role ||
    confirm.newPubkey !== verified.newPubkey
  ) {
    return {
      ok: false,
      reason:
        `you approved rotating role ${confirm.role} -> ${confirm.newPubkey}, ` +
        `but the transaction rotates role ${verified.role} -> ${verified.newPubkey}`,
    };
  }
  return { ok: true };
}

export interface RotateSignerCountersignDecodeInput {
  role: number;
  newPubkey: Address;
  liveOperator: Address;
  liveReserve: Address;
  nonceValue: string;
  outPath: string;
}

/**
 * Rotate-signer flavor of the decode record — I-8 is Operator-initiated and
 * Reserve-countersigned (contrast I-6, whose countersigner is the issuer). A
 * target-role > 2 renders as "unknown (rejected on-chain)" — the bound is
 * judged on-chain (InvalidRole), not here.
 */
export function formatRotateSignerCountersignDecode(
  input: RotateSignerCountersignDecodeInput,
): string {
  const roleName =
    input.role === 0
      ? "Issuer"
      : input.role === 1
        ? "Operator"
        : input.role === 2
          ? "Reserve"
          : "unknown (rejected on-chain)";
  const lines: string[] = [];
  lines.push(
    "VERIFY PASSED  : structural checks (a-f) OK against live chain state",
  );
  lines.push(
    `rotation       : target-role ${input.role} (${roleName}) -> new signer ${input.newPubkey}`,
  );
  lines.push(
    `CONFIRM MATCH  : approved == transaction (rotate role ${input.role} -> ${input.newPubkey})`,
  );
  lines.push(
    `live operator  : ${input.liveOperator} (matched: fee payer + operator slot)`,
  );
  lines.push(
    `live reserve : ${input.liveReserve} (countersigner — matched: awaiting countersign slot; must equal the --keypair signer, role-guard enforced before signing)`,
  );
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(`countersigned  : ${input.outPath}`);
  return lines.join("\n");
}

export async function runAdminCountersign(argv: string[]): Promise<void> {
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
      "confirm-amount": { type: "string" },
      "confirm-destination": { type: "string" },
      "confirm-source": { type: "string" },
      "confirm-fee-bps": { type: "string" },
      "confirm-max-fee": { type: "string" },
      "confirm-min-fee": { type: "string" },
      "confirm-target-role": { type: "string" },
      "confirm-new-signer": { type: "string" },
      out: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  // positionals: ["admin", "countersign", <envelope-path>]
  const [, , envelopePath] = positionals;
  if (envelopePath === undefined) {
    throw new Error(
      `admin countersign: usage — admin countersign <envelope-path> --keypair <path> --role <reserve|issuer> <confirm flags> [--out <path>]
the required --role and confirm flags depend on the envelope's instruction:
  mint_tokens          --role reserve --confirm-amount --confirm-destination
  burn_tokens          --role reserve --confirm-amount --confirm-source
  update_transfer_fee  --role issuer  --confirm-fee-bps --confirm-max-fee --confirm-min-fee
  rotate_signer        --role reserve --confirm-target-role --confirm-new-signer
  resume_issuance      --role reserve no confirm flags`,
    );
  }

  // SHAPE BEFORE IDENTITY: the positional/usage check above runs FIRST so the
  // usage block is reachable without --keypair/--role. admin-submit.ts is the
  // reference ordering. Do not move this call back above the check.
  const identity = requireSigningIdentity(config);

  // Raw confirm flags only — whether they are REQUIRED is decided after the
  // structural verify, keyed on the WIRE instruction (mint: amount +
  // destination; burn: amount + source; update-fee: the fee triple; rotate:
  // target-role + new-signer; resume: no confirm items exist).
  const confirmAmountRaw =
    typeof values["confirm-amount"] === "string"
      ? values["confirm-amount"]
      : undefined;
  const confirmDestinationRaw =
    typeof values["confirm-destination"] === "string"
      ? values["confirm-destination"]
      : undefined;
  const confirmSourceRaw =
    typeof values["confirm-source"] === "string"
      ? values["confirm-source"]
      : undefined;
  const confirmFeeBpsRaw =
    typeof values["confirm-fee-bps"] === "string"
      ? values["confirm-fee-bps"]
      : undefined;
  const confirmMaxFeeRaw =
    typeof values["confirm-max-fee"] === "string"
      ? values["confirm-max-fee"]
      : undefined;
  const confirmMinFeeRaw =
    typeof values["confirm-min-fee"] === "string"
      ? values["confirm-min-fee"]
      : undefined;
  const confirmTargetRoleRaw =
    typeof values["confirm-target-role"] === "string"
      ? values["confirm-target-role"]
      : undefined;
  const confirmNewSignerRaw =
    typeof values["confirm-new-signer"] === "string"
      ? values["confirm-new-signer"]
      : undefined;

  let envelopeJson: string;
  try {
    envelopeJson = readFileSync(envelopePath, "utf8");
  } catch {
    throw new Error(
      `admin countersign: envelope file missing or not readable: ${envelopePath}`,
    );
  }
  const { transactionBytes, claim } = parseAdminTxEnvelope(envelopeJson);

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
      "admin countersign: coupling assert failed — Operator frame diverges from live PDA-1 / OPERATOR_NONCE_ACCOUNT",
    );
  }

  // Rotate-signer frame for rotate_signer wires: I-8 is Operator-initiated over
  // the Operator nonce and Reserve-countersigned — a DISTINCT frame from I-6's
  // operatorFrame above (whose countersigner is the ISSUER; reusing it for I-8
  // would demand an issuer countersignature on an instruction the issuer
  // must not gate). Built unconditionally from the same fresh PDA-1
  // read; dispatch uses it only for rotate_signer wires.
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
      "admin countersign: coupling assert failed — rotate Operator frame diverges from live PDA-1 / OPERATOR_NONCE_ACCOUNT",
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
    throw new Error(
      "admin countersign: decoded instruction 0 has no nonce account",
    );
  }
  if (wireNonceAccount !== expectedNonce) {
    throw new Error(
      `admin countersign: transaction nonce account ${wireNonceAccount} is not the expected ${nonceLabel} nonce ${expectedNonce} for this instruction`,
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

  // Target disclosure, printed ONCE here rather than in each of the five
  // per-instruction branches: this is straight-line code reached on every path,
  // so no branch can skip it. Deliberately ahead of the structural-refusal
  // print below — a refusal caused by pointing at the wrong cluster is
  // indistinguishable from a genuinely malformed envelope without it.
  // No cluster guard in this file: countersign has no --broadcast path.
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
    "countersign",
    redemptionAuthorityPda,
    { feeAuthority: feeAuthorityPda, operatorFrame },
    { operatorFrame: rotateOperatorFrame },
  );
  if (!verdict.ok) {
    const message = `COUNTERSIGN REFUSED (structural): ${verdict.reason}`;
    throw new Error(message);
  }

  // Countersigner role is INSTRUCTION-CONDITIONAL (Decision 1), checked
  // after the wire verify: update-fee is issuer-countersigned; every other
  // two-party instruction is Reserve-countersigned.
  const expectedCountersignerRole: Role =
    verdict.instruction === "update_transfer_fee" ? "issuer" : "reserve";
  if (identity.role !== expectedCountersignerRole) {
    throw new Error(
      `admin countersign: --role must be "${expectedCountersignerRole}" — ${verdict.instruction}'s countersigner is the ${expectedCountersignerRole} (got "${identity.role}")`,
    );
  }

  // Fail-loud: stray confirm flags (another instruction's, or any on the
  // no-param resume) are refused BEFORE any printing/signing/write (same
  // fail-closed placement as the confirm requirements below).
  assertNoStrayConfirmFlags(
    verdict.instruction,
    confirmAmountRaw,
    confirmDestinationRaw,
    confirmSourceRaw,
    confirmFeeBpsRaw,
    confirmMaxFeeRaw,
    confirmMinFeeRaw,
    confirmTargetRoleRaw,
    confirmNewSignerRaw,
  );

  // The typed-confirm gate is INSTRUCTION-CONDITIONAL, keyed on the wire
  // instruction: mint requires amount+destination; burn requires
  // amount+source; update-fee requires the fee triple; rotate requires
  // target-role+new-signer; resume has no params and therefore no confirm
  // items.
  switch (verdict.instruction) {
    case "mint_tokens": {
      if (confirmAmountRaw === undefined || confirmDestinationRaw === undefined) {
        throw new Error(
          "admin countersign: you must confirm the amount and destination you approve, via --confirm-amount <base-units> --confirm-destination <address>",
        );
      }
      if (!/^[0-9]+$/.test(confirmAmountRaw)) {
        throw new Error(
          `admin countersign: --confirm-amount must be a non-negative integer in base units (6 dp), got "${confirmAmountRaw}"`,
        );
      }
      const confirmAmount = BigInt(confirmAmountRaw);
      const confirmDestination = parseConfirmDestination(confirmDestinationRaw);
      const confirmation = checkConfirmation(
        { amount: verdict.amount, destination: verdict.destination },
        { amount: confirmAmount, destination: confirmDestination },
      );
      if (!confirmation.ok) {
        const message = `COUNTERSIGN REFUSED (confirmation mismatch): ${confirmation.reason}`;
        throw new Error(message);
      }
      break;
    }
    case "burn_tokens": {
      const confirm = requireBurnConfirmFlags(confirmAmountRaw, confirmSourceRaw);
      const confirmation = checkBurnConfirmation(
        { amount: verdict.amount, source: verdict.source },
        confirm,
      );
      if (!confirmation.ok) {
        const message = `COUNTERSIGN REFUSED (confirmation mismatch): ${confirmation.reason}`;
        throw new Error(message);
      }
      // The source the wire burns from is read live and judged by the
      // program's three checks BEFORE the reserve countersigns (burn-source.ts).
      const { value: sourceInfo } = await rpc
        .getAccountInfo(verdict.source, {
          encoding: "base64",
          commitment: config.commitment,
        })
        .send();
      const sourceRefusal = decideBurnSource(toBurnSourceRead(sourceInfo), {
        source: verdict.source,
        mint: config.mint,
        redemptionAuthority: redemptionAuthorityPda,
        token2022Program: TOKEN_2022_PROGRAM,
      });
      if (sourceRefusal !== undefined) {
        throw new Error(`COUNTERSIGN REFUSED (burn source): ${sourceRefusal}`);
      }
      break;
    }
    case "update_transfer_fee": {
      const confirm = requireUpdateFeeConfirmFlags(
        confirmFeeBpsRaw,
        confirmMaxFeeRaw,
        confirmMinFeeRaw,
      );
      const confirmation = checkUpdateFeeConfirmation(
        {
          newFeeBasisPoints: verdict.newFeeBasisPoints,
          newMaximumFee: verdict.newMaximumFee,
          newMinimumFee: verdict.newMinimumFee,
        },
        confirm,
      );
      if (!confirmation.ok) {
        const message = `COUNTERSIGN REFUSED (confirmation mismatch): ${confirmation.reason}`;
        throw new Error(message);
      }
      break;
    }
    case "rotate_signer": {
      // The rotate confirm gate is the ONLY client-side control on the
      // rotation values — requireRotateSignerConfirmFlags throws on
      // a missing flag, so a rotate wire can never fall through to signing
      // unconfirmed.
      const confirm = requireRotateSignerConfirmFlags(
        confirmTargetRoleRaw,
        confirmNewSignerRaw,
      );
      const confirmation = checkRotateSignerConfirmation(
        { role: verdict.role, newPubkey: verdict.newPubkey },
        confirm,
      );
      if (!confirmation.ok) {
        const message = `COUNTERSIGN REFUSED (confirmation mismatch): ${confirmation.reason}`;
        throw new Error(message);
      }
      // The three keys as they would stand, judged on the live PDA-1 read
      // BEFORE the reserve countersigns (co-signers.ts).
      const coSignerRefusal = decideDistinctCoSigners({
        role: verdict.role,
        newSigner: verdict.newPubkey,
        issuer: mintState.issuer,
        operator: mintState.operator,
        reserve: mintState.reserve,
      });
      if (coSignerRefusal !== undefined) {
        throw new Error(`COUNTERSIGN REFUSED (co-signers): ${coSignerRefusal}`);
      }
      break;
    }
    case "resume_issuance": {
      // resume has no params and therefore no confirm items — deliberately a
      // no-op.
      break;
    }
    default: {
      const _exhaustive: never = verdict;
      throw new Error(
        `admin countersign: unhandled instruction "${(_exhaustive as { instruction: string }).instruction}" in the typed-confirm gate`,
      );
    }
  }

  const outPath =
    typeof values["out"] === "string"
      ? values["out"]
      : countersignedOutPath(envelopePath);

  switch (verdict.instruction) {
    case "mint_tokens": {
      console.log(
        formatCountersignDecode({
          amount: verdict.amount,
          destination: verdict.destination,
          liveIssuer: mintState.issuer,
          liveReserve: mintState.reserve,
          nonceValue: liveNonceValue,
          outPath,
        }),
      );
      break;
    }
    case "burn_tokens": {
      console.log(
        formatBurnCountersignDecode({
          amount: verdict.amount,
          source: verdict.source,
          liveIssuer: mintState.issuer,
          liveReserve: mintState.reserve,
          nonceValue: liveNonceValue,
          outPath,
        }),
      );
      break;
    }
    case "update_transfer_fee": {
      console.log(
        formatUpdateFeeCountersignDecode({
          newFeeBasisPoints: verdict.newFeeBasisPoints,
          newMaximumFee: verdict.newMaximumFee,
          newMinimumFee: verdict.newMinimumFee,
          liveOperator: mintState.operator,
          liveIssuer: mintState.issuer,
          nonceValue: liveNonceValue,
          outPath,
        }),
      );
      break;
    }
    case "rotate_signer": {
      console.log(
        formatRotateSignerCountersignDecode({
          role: verdict.role,
          newPubkey: verdict.newPubkey,
          liveOperator: mintState.operator,
          liveReserve: mintState.reserve,
          nonceValue: liveNonceValue,
          outPath,
        }),
      );
      break;
    }
    case "resume_issuance": {
      console.log(
        formatResumeCountersignDecode({
          liveIssuer: mintState.issuer,
          liveReserve: mintState.reserve,
          nonceValue: liveNonceValue,
          outPath,
        }),
      );
      break;
    }
    default: {
      const _exhaustive: never = verdict;
      throw new Error(
        `admin countersign: unhandled instruction "${(_exhaustive as { instruction: string }).instruction}" in the countersign decode chain`,
      );
    }
  }

  const signer = await loadSignerFromFile(identity.keypairPath);

  // Retired/wrong-key defense: refuse BEFORE signing unless the loaded key
  // is the CURRENT on-chain authority for the instruction's countersigner
  // role per the fresh PDA-1 read above (issuer for update-fee, Reserve
  // otherwise).
  assertRoleAuthority(expectedCountersignerRole, signer.address, mintState);

  const fullyTx = await applyReserveCountersignature(transactionBytes, signer);

  // Hard final gate — throws if any signature slot is still unsigned.
  assertIsFullySignedTransaction(fullyTx);

  writeFileSync(
    outPath,
    serializeAdminTxEnvelope(
      fullyTx,
      buildCountersignedClaim(claim, signer.address),
      verdict.instruction,
    ),
  );
  console.log(`wrote countersigned envelope: ${outPath}`);
}
