// `ddc state` — fetch and decode the on-chain PDA-1 MintState
// and, beside it, the facts a holder needs to judge the
// program's fee power: the two genesis-settled fee ceilings, the fee schedule
// in force on the mint, who holds the mint's transfer-fee authority, and who
// can upgrade the program (or that nobody can); then the mint's own authority
// set: mint and Freeze Authorities, every extension, the Confidential Transfer
// settings and authority, the withheld-fee ElGamal public key, and the
// metadata pointer and update authorities;
// then the program's reserve statement for the mint (PDA-2). Read-only; prints
// the resolved target first so an overridden cluster/mint/program is always
// visible.

import { resolveConfig } from "../config.js";
import { createRpc } from "../rpc.js";
import { type MintState } from "../mint-state.js";
import { formatDdcAmount } from "../amount.js";
import { formatProgramUpgradeAuthority } from "../program-upgrade-authority.js";
import { formatMintAuthorityLines } from "../mint-authorities.js";
import { formatReserveStatementLines } from "../reserve-statement.js";
import { readMintOverview } from "../holder/state.js";
import { withRefusalText } from "../holder-refusal-text.js";
import type { HolderRefusalReason } from "../holder/refusal.js";

/** The not-found sentences `state` has always printed, by the account it read. */
function stateRefusalText(cluster: string, programId: string): (reason: HolderRefusalReason) => string | undefined {
  return (reason) => {
    if (reason.kind !== "account-not-found") return undefined;
    switch (reason.account) {
      case "mint-state":
        return `PDA-1 MintState account ${reason.address} not found on cluster ${cluster}`;
      case "mint":
        return `mint account ${reason.address} not found on cluster ${cluster}`;
      case "program-data":
        return `ProgramData account ${reason.address} for program ${programId} not found on cluster ${cluster}`;
      case "reserve-statement":
        return `reserve statement account ${reason.address} not found on cluster ${cluster}`;
    }
  };
}

export async function runState(argv: string[]): Promise<MintState> {
  const config = resolveConfig(argv);
  const rpc = createRpc(config.rpcUrl);
  const o = await withRefusalText(
    () => readMintOverview({ rpc, commitment: config.commitment, mint: config.mint, programId: config.programId }),
    stateRefusalText(config.rpcDisplay, config.programId),
  );
  const state = o.mintState;
  const inForce = o.scheduleInForce;
  const otherSchedule = inForce === o.feeConfig.older ? o.feeConfig.newer : o.feeConfig.older;
  const feeAuthorityNote =
    o.feeConfigAuthority === o.feeAuthorityPda ? "the program's fee authority PDA-3" : "NOT the program's PDA-3";

  console.log(`TARGET cluster : ${config.rpcDisplay} (${config.source.rpcUrl})`);
  console.log(`TARGET mint    : ${config.mint} (${config.source.mint})`);
  console.log(`TARGET program : ${config.programId} (${config.source.program})`);
  console.log(`derived PDA-1  : ${o.mintStatePda} (bump ${o.mintStateBump})`);
  console.log(`issuancePaused : ${state.pauseActive}`);
  console.log(`issuer         : ${state.issuer}`);
  console.log(`operator       : ${state.operator}`);
  console.log(`reserve        : ${state.reserve}`);
  console.log(`minimumFee     : ${state.minimumFee}`);
  console.log(`feeCeilingBps  : ${state.feeCeilingBasisPoints} bps (settled at issuance; no instruction raises it)`);
  console.log(`feeCeilingMax  : ${state.feeCeilingBaseUnits} base units = ${formatDdcAmount(state.feeCeilingBaseUnits)} DDC (settled at issuance; no instruction raises it)`);
  console.log(`feeInForce     : ${inForce.basisPoints} bps, maximum ${formatDdcAmount(inForce.maximumFee)} DDC (schedule from epoch ${inForce.epoch}; current epoch ${o.epoch}; other schedule from epoch ${otherSchedule.epoch})`);
  console.log(`feeAuthority   : ${o.feeConfigAuthority} (${feeAuthorityNote})`);
  console.log(`withdrawAuth   : ${o.withdrawWithheldAuthority}`);
  console.log(`upgradeAuth    : ${formatProgramUpgradeAuthority(o.upgrade)} (ProgramData ${o.programDataAddress}, last deployed slot ${o.upgrade.lastDeployedSlot})`);
  console.log(`bump           : ${state.bump}`);
  for (const line of formatMintAuthorityLines(o.mintAuthorities, { mint: config.mint, mintStatePda: o.mintStatePda })) {
    console.log(line);
  }
  for (const line of formatReserveStatementLines(o.reserveStatement, { pda: o.reservePda, reserve: state.reserve })) {
    console.log(line);
  }

  return state;
}
