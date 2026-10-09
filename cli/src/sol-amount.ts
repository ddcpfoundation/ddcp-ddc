// SOL display for a lamport figure the CLI has just read.
// Decimal SOL with trailing zeros TRIMMED: 1,554,480 lamports renders as
// 0.00155448, the form the account-creation line shows, and 1,574,800
// renders as 0.0015748. This differs BY DESIGN from formatDdcAmount's fixed
// six places, which apply to DDC and not to SOL; do not reconcile the two.
// Whole-number arithmetic only, on the amount.ts rule against floating point.

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL_DECIMALS = 9;

export function formatSolAmount(lamports: bigint): string {
  if (lamports < 0n) {
    throw new Error("a lamport amount must be non-negative, got " + lamports);
  }
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(SOL_DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : whole + "." + fraction;
}
