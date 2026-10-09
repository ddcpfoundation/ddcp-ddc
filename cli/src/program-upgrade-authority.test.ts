import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddressEncoder, type Address } from "@solana/kit";
import { decodeProgramUpgradeAuthority, deriveProgramDataAddress, formatProgramUpgradeAuthority } from "./program-upgrade-authority.js";

const AUTHORITY = "FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY" as Address;

function header(tag: number, option: number, slot: bigint): Uint8Array {
  const bytes = new Uint8Array(45 + 7);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, tag, true);
  view.setBigUint64(4, slot, true);
  view.setUint8(12, option);
  bytes.set(getAddressEncoder().encode(AUTHORITY), 13);
  return bytes;
}

test("decodeProgramUpgradeAuthority reads an authority and the last-deployed slot", () => {
  const value = decodeProgramUpgradeAuthority(header(3, 1, 476_476_261n));
  assert.deepEqual(value, { kind: "authority", address: AUTHORITY, lastDeployedSlot: 476_476_261n });
  assert.equal(formatProgramUpgradeAuthority(value), AUTHORITY);
});

test("decodeProgramUpgradeAuthority reports an immutable program", () => {
  const value = decodeProgramUpgradeAuthority(header(3, 0, 7n));
  assert.deepEqual(value, { kind: "immutable", lastDeployedSlot: 7n });
  assert.equal(formatProgramUpgradeAuthority(value), "none (program is immutable)");
});

test("decodeProgramUpgradeAuthority refuses a wrong tag, a bad option and short data by name", () => {
  assert.throws(() => decodeProgramUpgradeAuthority(header(2, 1, 1n)), /tag must be 3/);
  assert.throws(() => decodeProgramUpgradeAuthority(header(3, 2, 1n)), /option must be 0 or 1/);
  assert.throws(() => decodeProgramUpgradeAuthority(header(3, 1, 1n).subarray(0, 44)), /at least 45 bytes/);
});

test("deriveProgramDataAddress derives the devnet program's ProgramData address", async () => {
  // Measured on devnet 2026-09-28 with `solana program show`.
  assert.equal(
    await deriveProgramDataAddress("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp" as Address),
    "3E12roc1asN7PwHQd8BrbfYcgJoUiSLQJVSPRRuWD9Je",
  );
});
