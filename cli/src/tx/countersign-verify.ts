// PURE countersign decode + verify core. Offline,
// deterministic, no I/O, no signing. The countersigner trusts NOTHING from
// the envelope claim: everything is re-derived here from the wire bytes and
// compared against live-read chain state supplied by the caller (ctx).
// Shared by countersign AND submit via the stage parameter — the
// only stage difference is the required Reserve-slot signature state.
// Check f is reconstruct-and-compare: it transitively verifies the
// discriminator, mint, PDA-1, token-2022 program, issuer, reserve, and account
// order. Amount and destination are deliberately NOT judged here — they are
// the human typed-confirm items, extracted and returned for display.

import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getU64Decoder,
  type Address,
} from "@solana/kit";
import { buildMintTokensInstruction } from "../instructions/mint-tokens.js";

export interface DecodedAdminTxInstruction {
  readonly programAddress: Address;
  readonly accounts: readonly Address[];
  readonly data: Uint8Array;
}

export interface DecodedAdminTx {
  readonly feePayer: Address;
  readonly signatures: ReadonlyArray<{
    readonly address: Address;
    readonly signed: boolean;
  }>;
  readonly nonceValue: string;
  readonly instructions: readonly DecodedAdminTxInstruction[];
}

/**
 * Decode wire-transaction bytes into an ADDRESS-RESOLVED structured view:
 * every instruction account index is resolved to its Address via the
 * message's static account list, so downstream logic is address-based.
 * A slot counts as signed only if it is non-null AND non-zero (the wire
 * format writes 64 zero bytes for an empty slot).
 */
export function decodeAdminTxWire(wireBytes: Uint8Array): DecodedAdminTx {
  let tx;
  try {
    tx = getTransactionDecoder().decode(wireBytes);
  } catch (err) {
    throw new Error(
      `admin-tx wire bytes are not a decodable transaction: ${(err as Error).message}`,
    );
  }
  let compiled;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch (err) {
    throw new Error(
      `admin-tx message bytes are not a decodable transaction message: ${(err as Error).message}`,
    );
  }

  if (compiled.version !== 0) {
    throw new Error(
      `admin-tx message must be a version-0 transaction message, got version ${String(compiled.version)}`,
    );
  }

  const staticAccounts: readonly Address[] = compiled.staticAccounts;
  const feePayer = staticAccounts[0];
  if (feePayer === undefined) {
    throw new Error("decoded transaction message has no static accounts");
  }

  const signatures = Object.entries(tx.signatures).map(([addr, sig]) => ({
    address: addr as Address,
    signed: sig != null && sig.some((b) => b !== 0),
  }));

  const instructions = compiled.instructions.map((ix, i) => {
    const programAddress = staticAccounts[ix.programAddressIndex];
    if (programAddress === undefined) {
      throw new Error(
        `instruction ${i} program-address index ${ix.programAddressIndex} is out of range`,
      );
    }
    const accounts = (ix.accountIndices ?? []).map((accountIndex) => {
      const account = staticAccounts[accountIndex];
      if (account === undefined) {
        throw new Error(
          `instruction ${i} account index ${accountIndex} is out of range`,
        );
      }
      return account;
    });
    return {
      programAddress,
      accounts,
      data: Uint8Array.from(ix.data ?? new Uint8Array(0)),
    };
  });

  return {
    feePayer,
    signatures,
    nonceValue: compiled.lifetimeToken,
    instructions,
  };
}

export interface CountersignContext {
  liveIssuer: Address;
  liveReserve: Address;
  liveNonceValue: string;
  issuerNonceAccount: Address;
  mint: Address;
  mintStatePda: Address;
  token2022Program: Address;
  programId: Address;
  systemProgram: Address;
}

export type CountersignVerdict =
  | { readonly ok: true; readonly amount: bigint; readonly destination: Address }
  | { readonly ok: false; readonly reason: string };

const I2_ACCOUNT_POSITION_LABELS = [
  "mint",
  "destination",
  "PDA-1 MintState",
  "issuer_authority",
  "reserve_authority",
  "token_2022_program",
] as const;

/**
 * Signature-state expectation: "countersign" (the Reserve slot must still
 * be EMPTY) or "submit" (the Reserve slot must be SIGNED). Every other
 * check is identical; the default is the countersign stage.
 */
export type VerifyStage = "countersign" | "submit";

export function verifyMintCountersign(
  decoded: DecodedAdminTx,
  ctx: CountersignContext,
  stage: VerifyStage = "countersign",
): CountersignVerdict {
  // a. exactly 2 instructions
  if (decoded.instructions.length !== 2) {
    return {
      ok: false,
      reason: `expected exactly 2 instructions, got ${decoded.instructions.length}`,
    };
  }

  // b. exactly 2 signature slots; fee-payer slot signed and == live issuer;
  //    live-Reserve slot present and in the stage's required state (countersign:
  //    NOT signed; submit: signed); no stray slot signed.
  if (decoded.signatures.length !== 2) {
    return {
      ok: false,
      reason: `expected exactly 2 signature slots, got ${decoded.signatures.length}`,
    };
  }
  const feePayerSlot = decoded.signatures[0];
  if (feePayerSlot === undefined) {
    return { ok: false, reason: "missing fee-payer signature slot" };
  }
  if (!feePayerSlot.signed) {
    return {
      ok: false,
      reason: `fee-payer slot ${feePayerSlot.address} is not signed`,
    };
  }
  if (feePayerSlot.address !== ctx.liveIssuer) {
    return {
      ok: false,
      reason: `fee-payer slot is ${feePayerSlot.address}, not the live on-chain issuer ${ctx.liveIssuer}`,
    };
  }
  const reserveSlot = decoded.signatures.find((s) => s.address === ctx.liveReserve);
  if (reserveSlot === undefined) {
    return {
      ok: false,
      reason: `no signature slot for the live on-chain Reserve ${ctx.liveReserve}`,
    };
  }
  if (stage === "countersign" && reserveSlot.signed) {
    return { ok: false, reason: `Reserve slot ${ctx.liveReserve} is already signed` };
  }
  if (stage === "submit" && !reserveSlot.signed) {
    return {
      ok: false,
      reason: `Reserve slot ${ctx.liveReserve} is not signed — the envelope is not countersigned`,
    };
  }
  const straySigned = decoded.signatures.find(
    (s) =>
      s.address !== ctx.liveIssuer && s.address !== ctx.liveReserve && s.signed,
  );
  if (straySigned !== undefined) {
    return {
      ok: false,
      reason: `unexpected signed slot ${straySigned.address}`,
    };
  }

  // c. fee payer field
  if (decoded.feePayer !== ctx.liveIssuer) {
    return {
      ok: false,
      reason: `fee payer ${decoded.feePayer} is not the live issuer ${ctx.liveIssuer}`,
    };
  }

  // d. nonce freshness
  if (decoded.nonceValue !== ctx.liveNonceValue) {
    return {
      ok: false,
      reason: `stale nonce: transaction nonce ${decoded.nonceValue} != live nonce ${ctx.liveNonceValue}`,
    };
  }

  // e. instruction 0 is AdvanceNonceAccount over the issuer nonce account,
  //    with the live issuer as nonce authority.
  const ix0 = decoded.instructions[0];
  const ix1 = decoded.instructions[1];
  if (ix0 === undefined || ix1 === undefined) {
    return { ok: false, reason: "missing instruction 0 or 1" };
  }
  if (ix0.programAddress !== ctx.systemProgram) {
    return {
      ok: false,
      reason: `instruction 0 program is ${ix0.programAddress}, not the System program ${ctx.systemProgram}`,
    };
  }
  const ix0DataHex = Buffer.from(ix0.data).toString("hex");
  if (ix0DataHex !== "04000000") {
    return {
      ok: false,
      reason: `instruction 0 data is ${ix0DataHex}, not AdvanceNonceAccount (04000000)`,
    };
  }
  if (ix0.accounts[0] !== ctx.issuerNonceAccount) {
    return {
      ok: false,
      reason: `instruction 0 nonce account is ${ix0.accounts[0]}, not the issuer nonce account ${ctx.issuerNonceAccount}`,
    };
  }
  if (ix0.accounts[2] !== ctx.liveIssuer) {
    return {
      ok: false,
      reason: `instruction 0 nonce authority is ${ix0.accounts[2]}, not the live issuer ${ctx.liveIssuer}`,
    };
  }

  // f. instruction 1: reconstruct-and-compare against a freshly built
  //    mint_tokens instruction over the live authorities.
  if (ix1.programAddress !== ctx.programId) {
    return {
      ok: false,
      reason: `instruction 1 program is ${ix1.programAddress}, not the issuer-ops program ${ctx.programId}`,
    };
  }
  if (ix1.data.length !== 16) {
    return {
      ok: false,
      reason: `instruction 1 data must be 16 bytes, got ${ix1.data.length}`,
    };
  }
  const amount = getU64Decoder().decode(ix1.data.subarray(8, 16));
  const destination = ix1.accounts[1];
  if (destination === undefined) {
    return {
      ok: false,
      reason: "instruction 1 has no destination account (position 1)",
    };
  }
  const rebuilt = buildMintTokensInstruction({
    mint: ctx.mint,
    destination,
    mintState: ctx.mintStatePda,
    issuerAuthority: ctx.liveIssuer,
    reserveAuthority: ctx.liveReserve,
    token2022Program: ctx.token2022Program,
    amount,
  });
  const receivedDataHex = Buffer.from(ix1.data).toString("hex");
  const rebuiltDataHex = Buffer.from(rebuilt.data).toString("hex");
  if (receivedDataHex !== rebuiltDataHex) {
    if (receivedDataHex.slice(0, 16) !== rebuiltDataHex.slice(0, 16)) {
      return {
        ok: false,
        reason: `instruction 1 discriminator is ${receivedDataHex.slice(0, 16)}, expected ${rebuiltDataHex.slice(0, 16)}`,
      };
    }
    return {
      ok: false,
      reason: `instruction 1 data mismatch: received ${receivedDataHex}, rebuilt ${rebuiltDataHex}`,
    };
  }
  const rebuiltAccounts = rebuilt.accounts.map((a) => a.address);
  if (ix1.accounts.length !== rebuiltAccounts.length) {
    return {
      ok: false,
      reason: `instruction 1 has ${ix1.accounts.length} accounts, expected ${rebuiltAccounts.length}`,
    };
  }
  for (let i = 0; i < rebuiltAccounts.length; i += 1) {
    if (ix1.accounts[i] !== rebuiltAccounts[i]) {
      return {
        ok: false,
        reason: `instruction 1 account ${i} (${I2_ACCOUNT_POSITION_LABELS[i] ?? "unknown"}) is ${ix1.accounts[i]}, expected ${rebuiltAccounts[i]}`,
      };
    }
  }

  return { ok: true, amount, destination };
}
