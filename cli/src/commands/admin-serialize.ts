// `ddc admin serialize mint` — the live
// initiator half of the I-2 countersign lifecycle. Fresh PDA-1 read, then the
// role guard (retired-key defense) BEFORE any signing; nonce authority
// independently confirmed from the nonce account's own bytes; assembles and
// partially signs the durable-nonce mint transaction; prints a field-by-field
// decode derived from the assembled bytes (not echoed inputs); writes the
// ddc-admin-tx-v1 envelope.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  AccountRole,
  address,
  getAddressDecoder,
  getBase58Decoder,
  getU16Decoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  resolveConfig,
  requireSigningIdentity,
  type ConfigSource,
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
import { decideFeeCeiling } from "../fee-ceiling.js";
import { loadSignerFromFile } from "../signer.js";
import { assertRoleAuthority } from "../role-guard.js";
import { assembleMintTokensTransaction } from "../tx/mint-tx.js";
import { buildResumeIssuanceInstruction } from "../instructions/resume-issuance.js";
import { buildBurnTokensInstruction } from "../instructions/burn-tokens.js";
import { buildUpdateTransferFeeInstruction } from "../instructions/update-transfer-fee.js";
import { buildRotateSignerInstruction } from "../instructions/rotate-signer.js";
import { assembleDurableNonceTransaction } from "../tx/durable-nonce-tx.js";
import { serializeAdminTxEnvelope, type AdminTxClaim } from "../tx/envelope.js";
import {
  ISSUER_NONCE_ACCOUNT,
  OPERATOR_NONCE_ACCOUNT,
  TOKEN_2022_PROGRAM,
} from "../constants.js";

/** Format base units (6-dp mint) as a DDC decimal string. */
export function baseUnitsToDdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

function parseAmountBaseUnits(raw: string, sub: "mint" | "burn"): bigint {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `admin serialize ${sub}: amount must be a non-negative integer in base units (6 dp), got "${raw}"`,
    );
  }
  return BigInt(raw);
}

function parseDestination(raw: string): Address {
  try {
    return address(raw);
  } catch {
    throw new Error(
      `admin serialize mint: destination "${raw}" is not a valid address`,
    );
  }
}

function parseBurnSource(raw: string): Address {
  try {
    return address(raw);
  } catch {
    throw new Error(
      `admin serialize burn: source "${raw}" is not a valid address`,
    );
  }
}

function parseUpdateFeeArgs(
  bpsRaw: string | undefined,
  maxRaw: string | undefined,
  minRaw: string | undefined,
): { newFeeBasisPoints: number; newMaximumFee: bigint; newMinimumFee: bigint } {
  if (bpsRaw === undefined || maxRaw === undefined || minRaw === undefined) {
    throw new Error(
      "admin serialize update-fee: usage — admin serialize update-fee <bps> <max-base-units> <min-base-units> --keypair <path> --role operator [--out <path>]",
    );
  }
  if (!/^[0-9]+$/.test(bpsRaw)) {
    throw new Error(
      `admin serialize update-fee: bps must be a non-negative integer (basis points), got "${bpsRaw}"`,
    );
  }
  const newFeeBasisPoints = Number(bpsRaw);
  if (newFeeBasisPoints > 65535) {
    throw new Error(
      `admin serialize update-fee: bps must fit u16 (0..65535), got ${newFeeBasisPoints}`,
    );
  }
  if (!/^[0-9]+$/.test(maxRaw)) {
    throw new Error(
      `admin serialize update-fee: maximum fee must be a non-negative integer in base units (6 dp), got "${maxRaw}"`,
    );
  }
  if (!/^[0-9]+$/.test(minRaw)) {
    throw new Error(
      `admin serialize update-fee: minimum fee must be a non-negative integer in base units (6 dp), got "${minRaw}"`,
    );
  }
  return {
    newFeeBasisPoints,
    newMaximumFee: BigInt(maxRaw),
    newMinimumFee: BigInt(minRaw),
  };
}

const ROLE_NAMES: Record<AccountRole, string> = {
  [AccountRole.READONLY]: "readonly",
  [AccountRole.WRITABLE]: "writable",
  [AccountRole.READONLY_SIGNER]: "readonly-signer",
  [AccountRole.WRITABLE_SIGNER]: "writable-signer",
};

const I2_ACCOUNT_LABELS = [
  "mint",
  "destination",
  "PDA-1 MintState",
  "issuer_authority",
  "reserve_authority",
  "token_2022_program",
] as const;

export interface SerializeDecodeInput {
  rpcUrl: string;
  mint: Address;
  programId: Address;
  sources: { rpcUrl: ConfigSource; mint: ConfigSource; program: ConfigSource };
  mintStatePda: Address;
  role: string;
  signerAddress: Address;
  onChainIssuer: Address;
  reserveAuthority: Address;
  nonceAccount: Address;
  nonceValue: string;
  assembled: Awaited<ReturnType<typeof assembleMintTokensTransaction>>;
  outPath: string;
}

/**
 * Pure decode of the assembled transaction for operator review. Amount and
 * destination are DERIVED from the assembled instruction bytes/accounts, not
 * echoed from the inputs — what prints is what was actually built.
 */
export function formatSerializeDecode(input: SerializeDecodeInput): string {
  const instructions: readonly Instruction[] =
    input.assembled.message.instructions;
  const ix0 = instructions[0];
  const ix1 = instructions[1];
  if (ix0 === undefined || ix1 === undefined || instructions.length !== 2) {
    throw new Error("assembled message must have exactly 2 instructions");
  }
  const ix0FirstAccount = ix0.accounts?.[0];
  if (ix0FirstAccount === undefined) {
    throw new Error("instruction 0 has no accounts");
  }
  const ix1Data = ix1.data ?? new Uint8Array(0);
  if (ix1Data.length !== 16) {
    throw new Error(
      `instruction 1 data must be 16 bytes, got ${ix1Data.length}`,
    );
  }
  const discriminatorHex = Buffer.from(ix1Data.subarray(0, 8)).toString("hex");
  const amount = getU64Decoder().decode(ix1Data.subarray(8, 16));
  const ix1Accounts = ix1.accounts ?? [];
  if (ix1Accounts.length !== 6) {
    throw new Error(
      `instruction 1 must have 6 accounts, got ${ix1Accounts.length}`,
    );
  }
  const destination = ix1Accounts[1];
  if (destination === undefined) {
    throw new Error("instruction 1 has no destination account");
  }

  const lines: string[] = [];
  lines.push(`TARGET cluster : ${input.rpcUrl} (${input.sources.rpcUrl})`);
  lines.push(`TARGET mint    : ${input.mint} (${input.sources.mint})`);
  lines.push(`TARGET program : ${input.programId} (${input.sources.program})`);
  lines.push(`PDA-1 MintState: ${input.mintStatePda}`);
  lines.push(
    `ROLE GUARD     : role "${input.role}" — signer ${input.signerAddress} matches on-chain issuer ${input.onChainIssuer}`,
  );
  lines.push(`nonce account  : ${input.nonceAccount}`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `ix0 AdvanceNonceAccount: nonce account ${ix0FirstAccount.address}`,
  );
  lines.push(
    `ix1 mint_tokens (discriminator ${discriminatorHex}): amount ${amount} base units = ${baseUnitsToDdc(amount)} DDC -> destination ${destination.address}`,
  );
  ix1Accounts.forEach((acct, i) => {
    lines.push(
      `  account ${i} ${I2_ACCOUNT_LABELS[i]}: ${acct.address} (${ROLE_NAMES[acct.role]})`,
    );
  });
  lines.push(`fee payer      : ${input.assembled.message.feePayer.address}`);
  for (const [addr, sig] of Object.entries(
    input.assembled.transaction.signatures,
  )) {
    const who =
      addr === input.onChainIssuer
        ? "issuer"
        : addr === input.reserveAuthority
          ? "reserve"
          : "signer";
    lines.push(`signature ${who} ${addr}: ${sig ? "FILLED" : "AWAITING"}`);
  }
  lines.push(`envelope file  : ${input.outPath}`);
  return lines.join("\n");
}

const I5_ACCOUNT_LABELS = [
  "mint",
  "PDA-1 MintState",
  "issuer_authority",
  "reserve_authority",
] as const;

export interface ResumeSerializeDecodeInput {
  rpcUrl: string;
  mint: Address;
  programId: Address;
  sources: { rpcUrl: ConfigSource; mint: ConfigSource; program: ConfigSource };
  mintStatePda: Address;
  role: string;
  signerAddress: Address;
  onChainIssuer: Address;
  reserveAuthority: Address;
  nonceAccount: Address;
  nonceValue: string;
  assembled: Awaited<ReturnType<typeof assembleDurableNonceTransaction>>;
  outPath: string;
}

/**
 * Resume flavor of the serialize decode — everything derived from the
 * assembled bytes; there is NO amount/destination (I-5 has no params).
 */
export function formatResumeSerializeDecode(
  input: ResumeSerializeDecodeInput,
): string {
  const instructions: readonly Instruction[] =
    input.assembled.message.instructions;
  const ix0 = instructions[0];
  const ix1 = instructions[1];
  if (ix0 === undefined || ix1 === undefined || instructions.length !== 2) {
    throw new Error("assembled message must have exactly 2 instructions");
  }
  const ix0FirstAccount = ix0.accounts?.[0];
  if (ix0FirstAccount === undefined) {
    throw new Error("instruction 0 has no accounts");
  }
  const ix1Data = ix1.data ?? new Uint8Array(0);
  if (ix1Data.length !== 8) {
    throw new Error(
      `instruction 1 data must be 8 bytes, got ${ix1Data.length}`,
    );
  }
  const discriminatorHex = Buffer.from(ix1Data).toString("hex");
  const ix1Accounts = ix1.accounts ?? [];
  if (ix1Accounts.length !== 4) {
    throw new Error(
      `instruction 1 must have 4 accounts, got ${ix1Accounts.length}`,
    );
  }

  const lines: string[] = [];
  lines.push(`TARGET cluster : ${input.rpcUrl} (${input.sources.rpcUrl})`);
  lines.push(`TARGET mint    : ${input.mint} (${input.sources.mint})`);
  lines.push(`TARGET program : ${input.programId} (${input.sources.program})`);
  lines.push(`PDA-1 MintState: ${input.mintStatePda}`);
  lines.push(
    `ROLE GUARD     : role "${input.role}" — signer ${input.signerAddress} matches on-chain issuer ${input.onChainIssuer}`,
  );
  lines.push(`nonce account  : ${input.nonceAccount}`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `ix0 AdvanceNonceAccount: nonce account ${ix0FirstAccount.address}`,
  );
  lines.push(
    `ix1 resume_issuance (discriminator ${discriminatorHex}): no params — clears pause_active on PDA-1`,
  );
  ix1Accounts.forEach((acct, i) => {
    lines.push(
      `  account ${i} ${I5_ACCOUNT_LABELS[i]}: ${acct.address} (${ROLE_NAMES[acct.role]})`,
    );
  });
  lines.push(`fee payer      : ${input.assembled.message.feePayer.address}`);
  for (const [addr, sig] of Object.entries(
    input.assembled.transaction.signatures,
  )) {
    const who =
      addr === input.onChainIssuer
        ? "issuer"
        : addr === input.reserveAuthority
          ? "reserve"
          : "signer";
    lines.push(`signature ${who} ${addr}: ${sig ? "FILLED" : "AWAITING"}`);
  }
  lines.push(`envelope file  : ${input.outPath}`);
  return lines.join("\n");
}

const I3_ACCOUNT_LABELS = [
  "mint",
  "source",
  "PDA-1 MintState",
  "PDA-5",
  "issuer_authority",
  "reserve_authority",
  "token_2022_program",
] as const;

export interface BurnSerializeDecodeInput {
  rpcUrl: string;
  mint: Address;
  programId: Address;
  sources: { rpcUrl: ConfigSource; mint: ConfigSource; program: ConfigSource };
  mintStatePda: Address;
  redemptionAuthorityPda: Address;
  role: string;
  signerAddress: Address;
  onChainIssuer: Address;
  reserveAuthority: Address;
  nonceAccount: Address;
  nonceValue: string;
  assembled: Awaited<ReturnType<typeof assembleDurableNonceTransaction>>;
  outPath: string;
}

/**
 * Burn flavor of the serialize decode — amount and source are DERIVED from
 * the assembled instruction bytes/accounts, not echoed from the inputs.
 */
export function formatBurnSerializeDecode(
  input: BurnSerializeDecodeInput,
): string {
  const instructions: readonly Instruction[] =
    input.assembled.message.instructions;
  const ix0 = instructions[0];
  const ix1 = instructions[1];
  if (ix0 === undefined || ix1 === undefined || instructions.length !== 2) {
    throw new Error("assembled message must have exactly 2 instructions");
  }
  const ix0FirstAccount = ix0.accounts?.[0];
  if (ix0FirstAccount === undefined) {
    throw new Error("instruction 0 has no accounts");
  }
  const ix1Data = ix1.data ?? new Uint8Array(0);
  if (ix1Data.length !== 16) {
    throw new Error(
      `instruction 1 data must be 16 bytes, got ${ix1Data.length}`,
    );
  }
  const discriminatorHex = Buffer.from(ix1Data.subarray(0, 8)).toString("hex");
  const amount = getU64Decoder().decode(ix1Data.subarray(8, 16));
  const ix1Accounts = ix1.accounts ?? [];
  if (ix1Accounts.length !== 7) {
    throw new Error(
      `instruction 1 must have 7 accounts, got ${ix1Accounts.length}`,
    );
  }
  const source = ix1Accounts[1];
  if (source === undefined) {
    throw new Error("instruction 1 has no source account");
  }

  const lines: string[] = [];
  lines.push(`TARGET cluster : ${input.rpcUrl} (${input.sources.rpcUrl})`);
  lines.push(`TARGET mint    : ${input.mint} (${input.sources.mint})`);
  lines.push(`TARGET program : ${input.programId} (${input.sources.program})`);
  lines.push(`PDA-1 MintState: ${input.mintStatePda}`);
  lines.push(`PDA-5 redeem   : ${input.redemptionAuthorityPda}`);
  lines.push(
    `ROLE GUARD     : role "${input.role}" — signer ${input.signerAddress} matches on-chain issuer ${input.onChainIssuer}`,
  );
  lines.push(`nonce account  : ${input.nonceAccount}`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `ix0 AdvanceNonceAccount: nonce account ${ix0FirstAccount.address}`,
  );
  lines.push(
    `ix1 burn_tokens (discriminator ${discriminatorHex}): amount ${amount} base units = ${baseUnitsToDdc(amount)} DDC from source ${source.address}`,
  );
  ix1Accounts.forEach((acct, i) => {
    lines.push(
      `  account ${i} ${I3_ACCOUNT_LABELS[i]}: ${acct.address} (${ROLE_NAMES[acct.role]})`,
    );
  });
  lines.push(`fee payer      : ${input.assembled.message.feePayer.address}`);
  for (const [addr, sig] of Object.entries(
    input.assembled.transaction.signatures,
  )) {
    const who =
      addr === input.onChainIssuer
        ? "issuer"
        : addr === input.reserveAuthority
          ? "reserve"
          : "signer";
    lines.push(`signature ${who} ${addr}: ${sig ? "FILLED" : "AWAITING"}`);
  }
  lines.push(`envelope file  : ${input.outPath}`);
  return lines.join("\n");
}

/**
 * Burn claim (untrusted display data). Decision 2 (3b-2): the claim's
 * `destination` field is REUSED to carry burn's source address — the wire
 * is authoritative and the countersigner re-derives everything from it.
 */
export function buildBurnClaim(
  amount: bigint,
  source: Address,
  feePayer: Address,
): AdminTxClaim {
  return {
    amountDisplay: `burn ${baseUnitsToDdc(amount)} DDC from ${source}`,
    amount: amount.toString(),
    destination: source,
    nonceAccount: ISSUER_NONCE_ACCOUNT,
    feePayer,
    initiatorRole: "issuer",
    signedBy: [feePayer],
    awaitingSignature: "reserve",
  };
}

const I6_ACCOUNT_LABELS = [
  "mint",
  "PDA-3 fee_authority",
  "PDA-1 MintState",
  "issuer_authority",
  "operator_authority",
  "token_2022_program",
] as const;

export interface UpdateFeeSerializeDecodeInput {
  rpcUrl: string;
  mint: Address;
  programId: Address;
  sources: { rpcUrl: ConfigSource; mint: ConfigSource; program: ConfigSource };
  mintStatePda: Address;
  feeAuthorityPda: Address;
  role: string;
  signerAddress: Address;
  onChainOperator: Address;
  issuerAuthority: Address;
  nonceAccount: Address;
  nonceValue: string;
  assembled: Awaited<ReturnType<typeof assembleDurableNonceTransaction>>;
  outPath: string;
}

/**
 * Update-fee flavor of the serialize decode — the fee triple is DERIVED
 * from the assembled instruction bytes (bps@8, max@10, min@18), not echoed
 * from the inputs. I-6 is Operator-initiated: the fee payer / nonce authority
 * is the Operator and the issuer countersigns.
 */
export function formatUpdateFeeSerializeDecode(
  input: UpdateFeeSerializeDecodeInput,
): string {
  const instructions: readonly Instruction[] =
    input.assembled.message.instructions;
  const ix0 = instructions[0];
  const ix1 = instructions[1];
  if (ix0 === undefined || ix1 === undefined || instructions.length !== 2) {
    throw new Error("assembled message must have exactly 2 instructions");
  }
  const ix0FirstAccount = ix0.accounts?.[0];
  if (ix0FirstAccount === undefined) {
    throw new Error("instruction 0 has no accounts");
  }
  const ix1Data = ix1.data ?? new Uint8Array(0);
  if (ix1Data.length !== 26) {
    throw new Error(
      `instruction 1 data must be 26 bytes, got ${ix1Data.length}`,
    );
  }
  const discriminatorHex = Buffer.from(ix1Data.subarray(0, 8)).toString("hex");
  const newFeeBasisPoints = getU16Decoder().decode(ix1Data.subarray(8, 10));
  const newMaximumFee = getU64Decoder().decode(ix1Data.subarray(10, 18));
  const newMinimumFee = getU64Decoder().decode(ix1Data.subarray(18, 26));
  const ix1Accounts = ix1.accounts ?? [];
  if (ix1Accounts.length !== 6) {
    throw new Error(
      `instruction 1 must have 6 accounts, got ${ix1Accounts.length}`,
    );
  }

  const lines: string[] = [];
  lines.push(`TARGET cluster : ${input.rpcUrl} (${input.sources.rpcUrl})`);
  lines.push(`TARGET mint    : ${input.mint} (${input.sources.mint})`);
  lines.push(`TARGET program : ${input.programId} (${input.sources.program})`);
  lines.push(`PDA-1 MintState: ${input.mintStatePda}`);
  lines.push(`PDA-3 fee_auth : ${input.feeAuthorityPda}`);
  lines.push(
    `ROLE GUARD     : role "${input.role}" — signer ${input.signerAddress} matches on-chain operator ${input.onChainOperator}`,
  );
  lines.push(`nonce account  : ${input.nonceAccount}`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `ix0 AdvanceNonceAccount: nonce account ${ix0FirstAccount.address}`,
  );
  lines.push(
    `ix1 update_transfer_fee (discriminator ${discriminatorHex}): fee ${newFeeBasisPoints} bps, maximum ${newMaximumFee} base units = ${baseUnitsToDdc(newMaximumFee)} DDC, minimum ${newMinimumFee} base units = ${baseUnitsToDdc(newMinimumFee)} DDC`,
  );
  ix1Accounts.forEach((acct, i) => {
    lines.push(
      `  account ${i} ${I6_ACCOUNT_LABELS[i]}: ${acct.address} (${ROLE_NAMES[acct.role]})`,
    );
  });
  lines.push(`fee payer      : ${input.assembled.message.feePayer.address}`);
  for (const [addr, sig] of Object.entries(
    input.assembled.transaction.signatures,
  )) {
    const who =
      addr === input.onChainOperator
        ? "operator"
        : addr === input.issuerAuthority
          ? "issuer"
          : "signer";
    lines.push(`signature ${who} ${addr}: ${sig ? "FILLED" : "AWAITING"}`);
  }
  lines.push(`envelope file  : ${input.outPath}`);
  return lines.join("\n");
}

/**
 * Update-fee claim (untrusted display data). There is no amount/destination
 * for I-6 — the fee triple is carried in amountDisplay; the countersigner
 * re-derives everything from the wire.
 */
export function buildUpdateFeeClaim(
  newFeeBasisPoints: number,
  newMaximumFee: bigint,
  newMinimumFee: bigint,
  feePayer: Address,
): AdminTxClaim {
  return {
    amountDisplay: `update fee: ${newFeeBasisPoints} bps, max ${baseUnitsToDdc(newMaximumFee)} DDC, min ${baseUnitsToDdc(newMinimumFee)} DDC`,
    amount: "0",
    destination: "(n/a — update-fee has no destination)",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
    feePayer,
    initiatorRole: "operator",
    signedBy: [feePayer],
    awaitingSignature: "issuer",
  };
}

function parseRotateArgs(
  roleRaw: string | undefined,
  newSignerRaw: string | undefined,
): { role: number; newPubkey: Address } {
  if (roleRaw === undefined || newSignerRaw === undefined) {
    throw new Error(
      "admin serialize rotate: usage — admin serialize rotate <target-role> <new-signer> --keypair <path> --role operator [--out <path>]",
    );
  }
  if (!/^[0-9]+$/.test(roleRaw)) {
    throw new Error(
      `admin serialize rotate: target-role must be a non-negative integer (0=Issuer, 1=Operator, 2=Reserve), got "${roleRaw}"`,
    );
  }
  const role = Number(roleRaw);
  // u8 encoder bound only (0..255). The role<=2 bound is deferred to the
  // on-chain InvalidRole (6005) check and the --confirm-target-role gate,
  // mirroring update-fee deferring min<=max to FeeBoundsInvalid.
  if (role > 255) {
    throw new Error(
      `admin serialize rotate: target-role must fit u8 (0..255), got ${role}`,
    );
  }
  let newPubkey: Address;
  try {
    newPubkey = address(newSignerRaw);
  } catch {
    throw new Error(
      `admin serialize rotate: new-signer "${newSignerRaw}" is not a valid address`,
    );
  }
  return { role, newPubkey };
}

const I8_ACCOUNT_LABELS = [
  "mint",
  "PDA-1 MintState",
  "operator_authority",
  "reserve_authority",
] as const;

export interface RotateSignerSerializeDecodeInput {
  rpcUrl: string;
  mint: Address;
  programId: Address;
  sources: { rpcUrl: ConfigSource; mint: ConfigSource; program: ConfigSource };
  mintStatePda: Address;
  role: string;
  signerAddress: Address;
  onChainOperator: Address;
  reserveAuthority: Address;
  nonceAccount: Address;
  nonceValue: string;
  assembled: Awaited<ReturnType<typeof assembleDurableNonceTransaction>>;
  outPath: string;
}

/**
 * Rotate-signer flavor of the serialize decode — target-role and new_pubkey
 * are DERIVED from the assembled instruction bytes (role@8, new_pubkey@9..41),
 * not echoed from the inputs. I-8 is Operator-initiated and Reserve-countersigned:
 * the fee payer / nonce authority is the Operator and the Reserve countersigns. A
 * target-role > 2 prints as "unknown (rejected on-chain)" rather than
 * crashing — the role<=2 bound is judged on-chain (InvalidRole), not here.
 */
export function formatRotateSignerSerializeDecode(
  input: RotateSignerSerializeDecodeInput,
): string {
  const instructions: readonly Instruction[] =
    input.assembled.message.instructions;
  const ix0 = instructions[0];
  const ix1 = instructions[1];
  if (ix0 === undefined || ix1 === undefined || instructions.length !== 2) {
    throw new Error("assembled message must have exactly 2 instructions");
  }
  const ix0FirstAccount = ix0.accounts?.[0];
  if (ix0FirstAccount === undefined) {
    throw new Error("instruction 0 has no accounts");
  }
  const ix1Data = ix1.data ?? new Uint8Array(0);
  if (ix1Data.length !== 41) {
    throw new Error(
      `instruction 1 data must be 41 bytes, got ${ix1Data.length}`,
    );
  }
  const discriminatorHex = Buffer.from(ix1Data.subarray(0, 8)).toString("hex");
  const role = getU8Decoder().decode(ix1Data.subarray(8, 9));
  const newPubkey = getAddressDecoder().decode(ix1Data.subarray(9, 41));
  const roleName =
    role === 0
      ? "Issuer"
      : role === 1
        ? "Operator"
        : role === 2
          ? "Reserve"
          : "unknown (rejected on-chain)";
  const ix1Accounts = ix1.accounts ?? [];
  if (ix1Accounts.length !== 4) {
    throw new Error(
      `instruction 1 must have 4 accounts, got ${ix1Accounts.length}`,
    );
  }

  const lines: string[] = [];
  lines.push(`TARGET cluster : ${input.rpcUrl} (${input.sources.rpcUrl})`);
  lines.push(`TARGET mint    : ${input.mint} (${input.sources.mint})`);
  lines.push(`TARGET program : ${input.programId} (${input.sources.program})`);
  lines.push(`PDA-1 MintState: ${input.mintStatePda}`);
  lines.push(
    `ROLE GUARD     : role "${input.role}" — signer ${input.signerAddress} matches on-chain operator ${input.onChainOperator}`,
  );
  lines.push(`nonce account  : ${input.nonceAccount}`);
  lines.push(`nonce value    : ${input.nonceValue}`);
  lines.push(
    `ix0 AdvanceNonceAccount: nonce account ${ix0FirstAccount.address}`,
  );
  lines.push(
    `ix1 rotate_signer (discriminator ${discriminatorHex}): target-role ${role} (${roleName}) -> new signer ${newPubkey}`,
  );
  ix1Accounts.forEach((acct, i) => {
    lines.push(
      `  account ${i} ${I8_ACCOUNT_LABELS[i]}: ${acct.address} (${ROLE_NAMES[acct.role]})`,
    );
  });
  lines.push(`fee payer      : ${input.assembled.message.feePayer.address}`);
  for (const [addr, sig] of Object.entries(
    input.assembled.transaction.signatures,
  )) {
    const who =
      addr === input.onChainOperator
        ? "operator"
        : addr === input.reserveAuthority
          ? "reserve"
          : "signer";
    lines.push(`signature ${who} ${addr}: ${sig ? "FILLED" : "AWAITING"}`);
  }
  lines.push(`envelope file  : ${input.outPath}`);
  return lines.join("\n");
}

/**
 * Rotate-signer claim (untrusted display data). There is no amount for I-8;
 * the target-role + new signer are carried in amountDisplay, and destination
 * reuses to carry the new signer pubkey (as burn reuses it for source). The
 * countersigner re-derives everything from the wire.
 */
export function buildRotateSignerClaim(
  role: number,
  newPubkey: Address,
  feePayer: Address,
): AdminTxClaim {
  return {
    amountDisplay: `rotate role ${role} -> ${newPubkey}`,
    amount: "0",
    destination: newPubkey,
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
    feePayer,
    initiatorRole: "operator",
    signedBy: [feePayer],
    awaitingSignature: "reserve",
  };
}

export async function runAdminSerialize(argv: string[]): Promise<void> {
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
      out: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  // positionals: ["admin", "serialize", <sub>, <amount>, <account>, <min>]
  // (<account> is the destination for mint, the source for burn;
  // update-fee takes <bps> <max-base-units> <min-base-units> instead)
  const [, , sub, amountRaw, accountRaw, minRaw] = positionals;
  if (
    sub !== "mint" &&
    sub !== "resume" &&
    sub !== "burn" &&
    sub !== "update-fee" &&
    sub !== "rotate"
  ) {
    throw new Error(
      `admin serialize: unknown subcommand "${sub ?? ""}" — "mint", "burn", "resume", "update-fee", and "rotate" are supported`,
    );
  }
  let mintArgs: { amount: bigint; destination: Address } | undefined;
  if (sub === "mint") {
    if (amountRaw === undefined || accountRaw === undefined) {
      throw new Error(
        "admin serialize mint: usage — admin serialize mint <amount-base-units> <destination> --keypair <path> --role issuer [--out <path>]",
      );
    }
    mintArgs = {
      amount: parseAmountBaseUnits(amountRaw, "mint"),
      destination: parseDestination(accountRaw),
    };
  }
  let burnArgs: { amount: bigint; source: Address } | undefined;
  if (sub === "burn") {
    if (amountRaw === undefined || accountRaw === undefined) {
      throw new Error(
        "admin serialize burn: usage — admin serialize burn <amount-base-units> <source> --keypair <path> --role issuer [--out <path>]",
      );
    }
    burnArgs = {
      amount: parseAmountBaseUnits(amountRaw, "burn"),
      source: parseBurnSource(accountRaw),
    };
  }
  let updateFeeArgs:
    | { newFeeBasisPoints: number; newMaximumFee: bigint; newMinimumFee: bigint }
    | undefined;
  if (sub === "update-fee") {
    updateFeeArgs = parseUpdateFeeArgs(amountRaw, accountRaw, minRaw);
  }
  let rotateArgs: { role: number; newPubkey: Address } | undefined;
  if (sub === "rotate") {
    rotateArgs = parseRotateArgs(amountRaw, accountRaw);
  }
  // SHAPE BEFORE IDENTITY: the subcommand check and every per-subcommand
  // argument parse above run FIRST so each usage message is reachable without
  // --keypair/--role. admin-submit.ts is the reference ordering. Do not move
  // these checks back above the argument parsing.
  const identity = requireSigningIdentity(config);
  if (sub === "update-fee" || sub === "rotate") {
    if (identity.role !== "operator") {
      const inst = sub === "update-fee" ? "I-6" : "I-8";
      throw new Error(
        `admin serialize ${sub}: --role must be "operator" — ${inst}'s initiator is the Operator (got "${identity.role}")`,
      );
    }
  } else if (identity.role !== "issuer") {
    if (sub === "mint") {
      throw new Error(
        `admin serialize mint: --role must be "issuer" — I-2's initiator is the issuer; other roles initiate other instructions (got "${identity.role}")`,
      );
    }
    if (sub === "burn") {
      throw new Error(
        `admin serialize burn: --role must be "issuer" — I-3's initiator is the issuer (got "${identity.role}")`,
      );
    }
    throw new Error(
      `admin serialize resume: --role must be "issuer" — I-5's initiator is the issuer (got "${identity.role}")`,
    );
  }

  const outPath =
    typeof values["out"] === "string"
      ? values["out"]
      : `./admin-tx-${sub}-${Math.floor(Date.now() / 1000)}.json`;

  const rpc = createRpc(config.rpcUrl);
  const [mintStatePda] = await deriveMintStatePda(config.programId, config.mint);
  // PDA-5 (burn's redemption collection authority) — live-derived here in
  // the command layer, never wire-fed.
  const [redemptionAuthorityPda] = await deriveRedemptionAuthorityPda(
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

  const signer = await loadSignerFromFile(identity.keypairPath);

  // Retired-key defense: refuse — before anything is signed — unless the
  // loaded key is the CURRENT on-chain authority for the stated role per the
  // fresh PDA-1 read above (role validated per-sub: operator for update-fee,
  // issuer otherwise).
  assertRoleAuthority(identity.role, signer.address, mintState);

  // Nonce selection: the Operator-initiated subs (I-6 update-fee, I-8 rotate) run
  // over the Operator nonce (the initiating party is the nonce authority);
  // every other sub runs over the issuer nonce.
  const nonceAccount =
    sub === "update-fee" || sub === "rotate"
      ? OPERATOR_NONCE_ACCOUNT
      : ISSUER_NONCE_ACCOUNT;
  const nonceLabel =
    sub === "update-fee" || sub === "rotate" ? "operator" : "issuer";

  const { value: nonceInfo } = await rpc
    .getAccountInfo(nonceAccount, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!nonceInfo) {
    throw new Error(
      `${nonceLabel} nonce account ${nonceAccount} not found on cluster ${config.rpcUrl}`,
    );
  }
  const [nonceBase64] = nonceInfo.data;
  const nonceBytes = Uint8Array.from(Buffer.from(nonceBase64, "base64"));
  if (nonceBytes.length < 72) {
    throw new Error(
      `${nonceLabel} nonce account ${nonceAccount} data is ${nonceBytes.length} bytes — expected the 80-byte nonce layout`,
    );
  }
  // Independent authority confirmation from the account's own bytes [8:40].
  const nonceAuthority = getAddressDecoder().decode(nonceBytes.subarray(8, 40));
  if (nonceAuthority !== signer.address) {
    throw new Error(
      `${nonceLabel} nonce account ${nonceAccount} authority is ${nonceAuthority}, not the signer ${signer.address} — the nonce is misconfigured for this initiator`,
    );
  }
  // Current nonce value: bytes [40:72], base58.
  const nonceValue = getBase58Decoder().decode(nonceBytes.subarray(40, 72));

  if (mintArgs !== undefined) {
    const assembled = await assembleMintTokensTransaction({
      mint: config.mint,
      destination: mintArgs.destination,
      mintState: mintStatePda,
      issuerAuthority: signer.address,
      reserveAuthority: mintState.reserve,
      token2022Program: TOKEN_2022_PROGRAM,
      amount: mintArgs.amount,
      nonceAccount: ISSUER_NONCE_ACCOUNT,
      nonceAuthority: signer.address,
      nonceValue,
      initiatorSigner: signer,
    });

    console.log(
      formatSerializeDecode({
        rpcUrl: config.rpcUrl,
        mint: config.mint,
        programId: config.programId,
        sources: config.source,
        mintStatePda,
        role: identity.role,
        signerAddress: signer.address,
        onChainIssuer: mintState.issuer,
        reserveAuthority: mintState.reserve,
        nonceAccount: ISSUER_NONCE_ACCOUNT,
        nonceValue,
        assembled,
        outPath,
      }),
    );

    const claim: AdminTxClaim = {
      amountDisplay: `${baseUnitsToDdc(mintArgs.amount)} DDC`,
      amount: mintArgs.amount.toString(),
      destination: mintArgs.destination,
      nonceAccount: ISSUER_NONCE_ACCOUNT,
      feePayer: signer.address,
      initiatorRole: "issuer",
      signedBy: [signer.address],
      awaitingSignature: "reserve",
    };
    writeFileSync(
      outPath,
      serializeAdminTxEnvelope(assembled.transaction, claim),
    );
    console.log(`wrote admin-tx envelope: ${outPath}`);
    return;
  }

  if (burnArgs !== undefined) {
    // burn: I-3 — same issuer-nonce durable path as mint/resume; PDA-5
    // live-derived above. The source is read live and judged by the program's
    // three checks BEFORE the issuer signs (burn-source.ts).
    const { value: sourceInfo } = await rpc
      .getAccountInfo(burnArgs.source, {
        encoding: "base64",
        commitment: config.commitment,
      })
      .send();
    const sourceRefusal = decideBurnSource(toBurnSourceRead(sourceInfo), {
      source: burnArgs.source,
      mint: config.mint,
      redemptionAuthority: redemptionAuthorityPda,
      token2022Program: TOKEN_2022_PROGRAM,
    });
    if (sourceRefusal !== undefined) throw new Error(sourceRefusal);
    const assembled = await assembleDurableNonceTransaction(
      buildBurnTokensInstruction({
        mint: config.mint,
        source: burnArgs.source,
        mintState: mintStatePda,
        redemptionAuthority: redemptionAuthorityPda,
        issuerAuthority: signer.address,
        reserveAuthority: mintState.reserve,
        token2022Program: TOKEN_2022_PROGRAM,
        amount: burnArgs.amount,
      }),
      {
        nonceAccount: ISSUER_NONCE_ACCOUNT,
        nonceAuthority: signer.address,
        nonceValue,
      },
      signer,
    );

    console.log(
      formatBurnSerializeDecode({
        rpcUrl: config.rpcUrl,
        mint: config.mint,
        programId: config.programId,
        sources: config.source,
        mintStatePda,
        redemptionAuthorityPda,
        role: identity.role,
        signerAddress: signer.address,
        onChainIssuer: mintState.issuer,
        reserveAuthority: mintState.reserve,
        nonceAccount: ISSUER_NONCE_ACCOUNT,
        nonceValue,
        assembled,
        outPath,
      }),
    );

    writeFileSync(
      outPath,
      serializeAdminTxEnvelope(
        assembled.transaction,
        buildBurnClaim(burnArgs.amount, burnArgs.source, signer.address),
        "burn_tokens",
      ),
    );
    console.log(`wrote admin-tx envelope: ${outPath}`);
    return;
  }

  if (updateFeeArgs !== undefined) {
    // Genesis-settled ceilings, judged on the fresh PDA-1 read before anything
    // is built; the program refuses the same cases on-chain (6008, 6009).
    const ceilingRefusal = decideFeeCeiling({
      newFeeBasisPoints: updateFeeArgs.newFeeBasisPoints,
      newMaximumFee: updateFeeArgs.newMaximumFee,
      feeCeilingBasisPoints: mintState.feeCeilingBasisPoints,
      feeCeilingBaseUnits: mintState.feeCeilingBaseUnits,
    });
    if (ceilingRefusal !== undefined) {
      throw new Error(ceilingRefusal);
    }
    // update-fee: I-6 — the first Operator-initiated instruction, over the OPERATOR
    // nonce selected above. PDA-3 live-derived here in the command layer,
    // never wire-fed; the issuer countersigner is read from PDA-1.
    const [feeAuthorityPda] = await deriveFeeAuthorityPda(
      config.programId,
      config.mint,
    );
    const assembled = await assembleDurableNonceTransaction(
      buildUpdateTransferFeeInstruction({
        mint: config.mint,
        feeAuthority: feeAuthorityPda,
        mintState: mintStatePda,
        issuerAuthority: mintState.issuer, // countersigner, read from PDA-1
        operatorAuthority: signer.address, // initiator
        token2022Program: TOKEN_2022_PROGRAM,
        newFeeBasisPoints: updateFeeArgs.newFeeBasisPoints,
        newMaximumFee: updateFeeArgs.newMaximumFee,
        newMinimumFee: updateFeeArgs.newMinimumFee,
      }),
      {
        nonceAccount: OPERATOR_NONCE_ACCOUNT,
        nonceAuthority: signer.address,
        nonceValue,
      },
      signer,
    );

    console.log(
      formatUpdateFeeSerializeDecode({
        rpcUrl: config.rpcUrl,
        mint: config.mint,
        programId: config.programId,
        sources: config.source,
        mintStatePda,
        feeAuthorityPda,
        role: identity.role,
        signerAddress: signer.address,
        onChainOperator: mintState.operator,
        issuerAuthority: mintState.issuer,
        nonceAccount: OPERATOR_NONCE_ACCOUNT,
        nonceValue,
        assembled,
        outPath,
      }),
    );

    writeFileSync(
      outPath,
      serializeAdminTxEnvelope(
        assembled.transaction,
        buildUpdateFeeClaim(
          updateFeeArgs.newFeeBasisPoints,
          updateFeeArgs.newMaximumFee,
          updateFeeArgs.newMinimumFee,
          signer.address,
        ),
        "update_transfer_fee",
      ),
    );
    console.log(`wrote admin-tx envelope: ${outPath}`);
    return;
  }

  if (rotateArgs !== undefined) {
    // The three keys as they would stand after the rotation, judged on the
    // fresh PDA-1 read before anything is built; the program refuses the same
    // cases on-chain (6012).
    const coSignerRefusal = decideDistinctCoSigners({
      role: rotateArgs.role,
      newSigner: rotateArgs.newPubkey,
      issuer: mintState.issuer,
      operator: mintState.operator,
      reserve: mintState.reserve,
    });
    if (coSignerRefusal !== undefined) {
      throw new Error(coSignerRefusal);
    }
    // rotate: I-8 — Operator-initiated over the OPERATOR nonce selected above,
    // Reserve-countersigned. No PDA-3, no CPI (contrast I-6). The Reserve
    // countersigner is read from PDA-1; the Operator initiator is the signer.
    const assembled = await assembleDurableNonceTransaction(
      buildRotateSignerInstruction({
        mint: config.mint,
        mintState: mintStatePda,
        operatorAuthority: signer.address, // initiator
        reserveAuthority: mintState.reserve, // countersigner, read from PDA-1
        role: rotateArgs.role,
        newPubkey: rotateArgs.newPubkey,
      }),
      {
        nonceAccount: OPERATOR_NONCE_ACCOUNT,
        nonceAuthority: signer.address,
        nonceValue,
      },
      signer,
    );

    console.log(
      formatRotateSignerSerializeDecode({
        rpcUrl: config.rpcUrl,
        mint: config.mint,
        programId: config.programId,
        sources: config.source,
        mintStatePda,
        role: identity.role,
        signerAddress: signer.address,
        onChainOperator: mintState.operator,
        reserveAuthority: mintState.reserve,
        nonceAccount: OPERATOR_NONCE_ACCOUNT,
        nonceValue,
        assembled,
        outPath,
      }),
    );

    writeFileSync(
      outPath,
      serializeAdminTxEnvelope(
        assembled.transaction,
        buildRotateSignerClaim(
          rotateArgs.role,
          rotateArgs.newPubkey,
          signer.address,
        ),
        "rotate_signer",
      ),
    );
    console.log(`wrote admin-tx envelope: ${outPath}`);
    return;
  }

  // resume: no params — I-5 clears pause_active. Assembled via the generic
  // durable-nonce pipe over the same issuer nonce.
  const assembled = await assembleDurableNonceTransaction(
    buildResumeIssuanceInstruction({
      mint: config.mint,
      mintState: mintStatePda,
      issuerAuthority: signer.address,
      reserveAuthority: mintState.reserve,
    }),
    {
      nonceAccount: ISSUER_NONCE_ACCOUNT,
      nonceAuthority: signer.address,
      nonceValue,
    },
    signer,
  );

  console.log(
    formatResumeSerializeDecode({
      rpcUrl: config.rpcUrl,
      mint: config.mint,
      programId: config.programId,
      sources: config.source,
      mintStatePda,
      role: identity.role,
      signerAddress: signer.address,
      onChainIssuer: mintState.issuer,
      reserveAuthority: mintState.reserve,
      nonceAccount: ISSUER_NONCE_ACCOUNT,
      nonceValue,
      assembled,
      outPath,
    }),
  );

  const claim: AdminTxClaim = {
    amountDisplay: "(n/a — resume has no params)",
    amount: "0",
    destination: "(n/a — resume has no params)",
    nonceAccount: ISSUER_NONCE_ACCOUNT,
    feePayer: signer.address,
    initiatorRole: "issuer",
    signedBy: [signer.address],
    awaitingSignature: "reserve",
  };
  writeFileSync(
    outPath,
    serializeAdminTxEnvelope(assembled.transaction, claim, "resume_issuance"),
  );
  console.log(`wrote admin-tx envelope: ${outPath}`);
}
