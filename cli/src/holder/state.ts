// The read behind `state`: the program's record for the mint (PDA-1), the
// mint's fee schedules and every authority on it, the program's upgrade
// authority and the reserve statement (PDA-2). What a holder or an evaluator
// checks a mint against; read-only.

import type { Address } from "@solana/kit";
import { deriveAttestationPda, deriveFeeAuthorityPda, deriveMintStatePda } from "../pda.js";
import { decodeMintState, type MintState } from "../mint-state.js";
import { decodeMintTransferFeeAuthorities, decodeMintTransferFeeConfig } from "../mint-transfer-fee.js";
import { decideScheduleHeadroom } from "../tx/schedule-headroom.js";
import type { TransferFeeConfig, TransferFeeSchedule } from "../tx/transfer-fee-split.js";
import {
  decodeProgramUpgradeAuthority,
  deriveProgramDataAddress,
  type ProgramUpgradeAuthority,
} from "../program-upgrade-authority.js";
import { decodeMintAuthorities, type MintAuthorities } from "../mint-authorities.js";
import { decodeReserveStatement, type ReserveStatement } from "../reserve-statement.js";
import type { ProgramContext } from "./context.js";
import { HolderRefusal } from "./refusal.js";

export interface MintOverview {
  readonly mintStatePda: Address;
  readonly mintStateBump: number;
  readonly mintState: MintState;
  readonly feeConfig: TransferFeeConfig;
  /** The schedule in force at the epoch read. */
  readonly scheduleInForce: TransferFeeSchedule;
  readonly epoch: bigint;
  readonly feeConfigAuthority: Address | undefined;
  readonly withdrawWithheldAuthority: Address | undefined;
  /** The program's fee authority PDA-3 for this mint. */
  readonly feeAuthorityPda: Address;
  readonly mintAuthorities: MintAuthorities;
  readonly programDataAddress: Address;
  readonly upgrade: ProgramUpgradeAuthority;
  readonly reservePda: Address;
  readonly reserveStatement: ReserveStatement;
}

function bytesOf(base64Data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64Data, "base64"));
}

/** Read and decode everything `state` reports. Refuses when an account it reads is absent. */
export async function readMintOverview(ctx: ProgramContext): Promise<MintOverview> {
  const { rpc, commitment, mint, programId } = ctx;
  const [mintStatePda, mintStateBump] = await deriveMintStatePda(programId, mint);
  const { value: account } = await rpc.getAccountInfo(mintStatePda, { encoding: "base64", commitment }).send();
  if (!account) {
    throw new HolderRefusal({ kind: "account-not-found", account: "mint-state", address: mintStatePda });
  }
  const mintState = decodeMintState(bytesOf(account.data[0]));

  // The fee schedules and authorities, and the epoch position that decides
  // which schedule is in force (the rule of tx/schedule-headroom.ts).
  const { value: mintAccount } = await rpc.getAccountInfo(mint, { encoding: "base64", commitment }).send();
  if (!mintAccount) {
    throw new HolderRefusal({ kind: "account-not-found", account: "mint", address: mint });
  }
  const mintBytes = bytesOf(mintAccount.data[0]);
  const feeConfig = decodeMintTransferFeeConfig(mintBytes);
  const feeAuthorities = decodeMintTransferFeeAuthorities(mintBytes);
  const mintAuthorities = decodeMintAuthorities(mintBytes);
  const epochInfo = await rpc.getEpochInfo({ commitment }).send();
  const headroom = decideScheduleHeadroom(feeConfig, {
    epoch: BigInt(epochInfo.epoch),
    slotIndex: BigInt(epochInfo.slotIndex),
    slotsInEpoch: BigInt(epochInfo.slotsInEpoch),
  });
  const scheduleInForce = headroom.kind === "refuse" ? feeConfig.older : headroom.schedule;
  const [feeAuthorityPda] = await deriveFeeAuthorityPda(programId, mint);

  // The program's upgrade authority, from its ProgramData account.
  const programDataAddress = await deriveProgramDataAddress(programId);
  const { value: programData } = await rpc.getAccountInfo(programDataAddress, { encoding: "base64", commitment }).send();
  if (!programData) {
    throw new HolderRefusal({ kind: "account-not-found", account: "program-data", address: programDataAddress });
  }
  const upgrade = decodeProgramUpgradeAuthority(bytesOf(programData.data[0]));

  // The reserve statement, from PDA-2, which the program creates at genesis.
  const [reservePda] = await deriveAttestationPda(programId, mint);
  const { value: reserveAccount } = await rpc.getAccountInfo(reservePda, { encoding: "base64", commitment }).send();
  if (!reserveAccount) {
    throw new HolderRefusal({ kind: "account-not-found", account: "reserve-statement", address: reservePda });
  }
  const reserveStatement = decodeReserveStatement(bytesOf(reserveAccount.data[0]));

  return {
    mintStatePda,
    mintStateBump,
    mintState,
    feeConfig,
    scheduleInForce,
    epoch: BigInt(epochInfo.epoch),
    feeConfigAuthority: feeAuthorities.feeConfigAuthority,
    withdrawWithheldAuthority: feeAuthorities.withdrawWithheldAuthority,
    feeAuthorityPda,
    mintAuthorities,
    programDataAddress,
    upgrade,
    reservePda,
    reserveStatement,
  };
}
