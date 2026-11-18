// The fee reads shared by the two transfer operations: the cluster's epoch
// position, the schedule in force with its headroom before the epoch boundary,
// the mint's fee schedules and the program's minimum fee.

import { fetchEncodedAccount } from "@solana/kit";
import { decodeMintState } from "../mint-state.js";
import { decodeMintTransferFeeConfig } from "../mint-transfer-fee.js";
import { deriveMintStatePda } from "../pda.js";
import type { decideScheduleHeadroom, EpochPosition } from "../tx/schedule-headroom.js";
import type { TransferFeeConfig, TransferFeeSchedule } from "../tx/transfer-fee-split.js";
import type { HolderContext, ProgramContext } from "./context.js";
import { HolderRefusal } from "./refusal.js";

/** One fresh read of the mint's two fee schedules. */
export async function readMintFeeSchedules(ctx: HolderContext): Promise<TransferFeeConfig> {
  const encoded = await fetchEncodedAccount(ctx.rpc, ctx.mint, { commitment: ctx.commitment });
  if (!encoded.exists) throw new HolderRefusal({ kind: "account-not-found", account: "mint", address: ctx.mint });
  return decodeMintTransferFeeConfig(new Uint8Array(encoded.data));
}

/** The cluster's epoch position, which decides the fee schedule in force. */
export async function readEpochPosition(ctx: HolderContext): Promise<EpochPosition> {
  const info = await ctx.rpc.getEpochInfo({ commitment: ctx.commitment }).send();
  return { epoch: BigInt(info.epoch), slotIndex: BigInt(info.slotIndex), slotsInEpoch: BigInt(info.slotsInEpoch) };
}

/** The schedule in force, or a refusal when it changes within the headroom before the epoch boundary. */
export function scheduleOrRefuse(verdict: ReturnType<typeof decideScheduleHeadroom>): TransferFeeSchedule {
  if (verdict.kind === "refuse") {
    throw new HolderRefusal({ kind: "schedule-headroom", slotsRemaining: verdict.slotsRemaining });
  }
  return verdict.schedule;
}

/** The program's minimum fee, from PDA-1. */
export async function readMinimumFee(ctx: ProgramContext): Promise<bigint> {
  const [mintStatePda] = await deriveMintStatePda(ctx.programId, ctx.mint);
  const account = await fetchEncodedAccount(ctx.rpc, mintStatePda, { commitment: ctx.commitment });
  if (!account.exists) throw new HolderRefusal({ kind: "account-not-found", account: "mint-state", address: mintStatePda });
  return decodeMintState(new Uint8Array(account.data)).minimumFee;
}
