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
import { deriveAttestationPda, deriveFeeAuthorityPda, deriveMintStatePda } from "../pda.js";
import { decodeMintState, type MintState } from "../mint-state.js";
import { formatDdcAmount } from "../amount.js";
import { decodeMintTransferFeeAuthorities, decodeMintTransferFeeConfig } from "../mint-transfer-fee.js";
import { decideScheduleHeadroom } from "../tx/schedule-headroom.js";
import { decodeProgramUpgradeAuthority, deriveProgramDataAddress, formatProgramUpgradeAuthority } from "../program-upgrade-authority.js";
import { decodeMintAuthorities, formatMintAuthorityLines } from "../mint-authorities.js";
import { decodeReserveStatement, formatReserveStatementLines } from "../reserve-statement.js";

export async function runState(argv: string[]): Promise<MintState> {
  const config = resolveConfig(argv);
  const rpc = createRpc(config.rpcUrl);
  const [pda, derivedBump] = await deriveMintStatePda(
    config.programId,
    config.mint,
  );

  const { value: account } = await rpc
    .getAccountInfo(pda, {
      encoding: "base64",
      commitment: config.commitment,
    })
    .send();
  if (!account) {
    throw new Error(
      `PDA-1 MintState account ${pda} not found on cluster ${config.rpcUrl}`,
    );
  }

  const [base64Data] = account.data;
  const state = decodeMintState(
    Uint8Array.from(Buffer.from(base64Data, "base64")),
  );

  // The mint's fee schedule and authorities, and the epoch position that
  // decides which schedule is in force (the rule of tx/schedule-headroom.ts).
  const { value: mintAccount } = await rpc
    .getAccountInfo(config.mint, { encoding: "base64", commitment: config.commitment })
    .send();
  if (!mintAccount) {
    throw new Error(`mint account ${config.mint} not found on cluster ${config.rpcUrl}`);
  }
  const mintBytes = Uint8Array.from(Buffer.from(mintAccount.data[0], "base64"));
  const feeConfig = decodeMintTransferFeeConfig(mintBytes);
  const feeAuthorities = decodeMintTransferFeeAuthorities(mintBytes);
  const mintAuthorities = decodeMintAuthorities(mintBytes);
  const epochInfo = await rpc.getEpochInfo({ commitment: config.commitment }).send();
  const headroom = decideScheduleHeadroom(feeConfig, {
    epoch: BigInt(epochInfo.epoch),
    slotIndex: BigInt(epochInfo.slotIndex),
    slotsInEpoch: BigInt(epochInfo.slotsInEpoch),
  });
  const inForce = headroom.kind === "refuse" ? feeConfig.older : headroom.schedule;
  const [feeAuthorityPda] = await deriveFeeAuthorityPda(config.programId, config.mint);
  const feeAuthorityNote =
    feeAuthorities.feeConfigAuthority === feeAuthorityPda ? "the program's fee authority PDA-3" : "NOT the program's PDA-3";

  // The program's upgrade authority, from its ProgramData account.
  const programDataAddress = await deriveProgramDataAddress(config.programId);
  const { value: programData } = await rpc
    .getAccountInfo(programDataAddress, { encoding: "base64", commitment: config.commitment })
    .send();
  if (!programData) {
    throw new Error(`ProgramData account ${programDataAddress} for program ${config.programId} not found on cluster ${config.rpcUrl}`);
  }
  const upgrade = decodeProgramUpgradeAuthority(Uint8Array.from(Buffer.from(programData.data[0], "base64")));

  // The reserve statement, from PDA-2, which the program creates at genesis.
  const [reservePda] = await deriveAttestationPda(config.programId, config.mint);
  const { value: reserveAccount } = await rpc
    .getAccountInfo(reservePda, { encoding: "base64", commitment: config.commitment })
    .send();
  if (!reserveAccount) {
    throw new Error(`reserve statement account ${reservePda} not found on cluster ${config.rpcUrl}`);
  }
  const reserveStatement = decodeReserveStatement(Uint8Array.from(Buffer.from(reserveAccount.data[0], "base64")));

  console.log(`TARGET cluster : ${config.rpcUrl} (${config.source.rpcUrl})`);
  console.log(`TARGET mint    : ${config.mint} (${config.source.mint})`);
  console.log(`TARGET program : ${config.programId} (${config.source.program})`);
  console.log(`derived PDA-1  : ${pda} (bump ${derivedBump})`);
  console.log(`issuancePaused : ${state.pauseActive}`);
  console.log(`issuer         : ${state.issuer}`);
  console.log(`operator       : ${state.operator}`);
  console.log(`reserve        : ${state.reserve}`);
  console.log(`minimumFee     : ${state.minimumFee}`);
  console.log(`feeCeilingBps  : ${state.feeCeilingBasisPoints} bps (settled at issuance; no instruction raises it)`);
  console.log(`feeCeilingMax  : ${state.feeCeilingBaseUnits} base units = ${formatDdcAmount(state.feeCeilingBaseUnits)} DDC (settled at issuance; no instruction raises it)`);
  console.log(`feeInForce     : ${inForce.basisPoints} bps, maximum ${formatDdcAmount(inForce.maximumFee)} DDC (schedule from epoch ${inForce.epoch}; current epoch ${epochInfo.epoch}; other schedule from epoch ${(inForce === feeConfig.older ? feeConfig.newer : feeConfig.older).epoch})`);
  console.log(`feeAuthority   : ${feeAuthorities.feeConfigAuthority} (${feeAuthorityNote})`);
  console.log(`withdrawAuth   : ${feeAuthorities.withdrawWithheldAuthority}`);
  console.log(`upgradeAuth    : ${formatProgramUpgradeAuthority(upgrade)} (ProgramData ${programDataAddress}, last deployed slot ${upgrade.lastDeployedSlot})`);
  console.log(`bump           : ${state.bump}`);
  for (const line of formatMintAuthorityLines(mintAuthorities, { mint: config.mint, mintStatePda: pda })) {
    console.log(line);
  }
  for (const line of formatReserveStatementLines(reserveStatement, { pda: reservePda, reserve: state.reserve })) {
    console.log(line);
  }

  return state;
}
