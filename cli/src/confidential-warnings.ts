// Threshold warnings for accumulated unapplied pending — the value warning
// and the counter pair, shared by `balance` and `apply-pending` (one
// formatter for both). PLACEMENT IS FLAT beside confidential-refusals.ts,
// for this reason: commands/,
// instructions/ and tx/ each hold a KIND of thing, and shared threshold copy
// is none of them.
//
// THE ARITHMETIC THESE WARNINGS REST ON: each credit adds its low 16 bits to
// the lo limb and the remainder to the hi limb, and the client decrypt wall
// is 2^32 per limb. The 65,536 counter cap is precisely the value that keeps
// the LO limb decryptable at any fill; the HI limb has no equivalent
// protection — the limbs accumulate and nothing caps the sum — so the
// readable wall sits where accumulated unapplied pending reaches 2^48 base
// units. The value trigger is 50% of that wall. The counter trigger is 75%
// of the account's OWN configured cap, computed against the EXACT cap read
// from its extension — never against the rounded display figure and never
// against MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER.
//
// NEITHER THRESHOLD IS A GUARANTEE: a single maximum-size credit contributes up
// to 2^32 − 1 to the hi limb on its own, so from a warned state ONE credit can
// cross the wall. The value warning's closing sentence states this and is not
// to be softened.
//
// DISPLAY ROUNDING IS RULED AND ASYMMETRIC: the wall renders as "about
// 280,000,000.000000 DDC", rounded DOWN so the limit reads nearer than it
// is; the counter CAP renders rounded down to the nearest thousand with
// "about", and exactly below a cap of 1,000 where rounding would print
// zero; the COUNT always renders exactly, with thousands grouping. Rounding
// the cap alone opens a band where an exact count exceeds the rounded cap,
// which is why the counter warning is TWO messages, split by the ROUNDED
// cap, while the trigger uses the EXACT one.

import { formatDdcAmount } from "./amount.js";

/** The client-readable wall: accumulated unapplied pending of 2^48 base units. */
export const PENDING_READ_WALL_BASE_UNITS = 1n << 48n;

/** The value trigger: 50% of the wall. */
export const PENDING_VALUE_WARNING_BASE_UNITS = 1n << 47n;

/** True when unapplied pending has crossed the value trigger. */
export function shouldWarnPendingValue(pendingBaseUnits: bigint): boolean {
  return pendingBaseUnits >= PENDING_VALUE_WARNING_BASE_UNITS;
}

/**
 * Thousands grouping for COUNTS only — 51999 renders "51,999". Deterministic
 * string arithmetic; never a locale call, whose output varies by machine.
 */
export function groupThousands(value: bigint): string {
  if (value < 0n) {
    throw new Error(`counts are non-negative, got ${value}`);
  }
  const digits = value.toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    out += digits.charAt(i);
    const remaining = digits.length - 1 - i;
    if (remaining > 0 && remaining % 3 === 0) out += ",";
  }
  return out;
}

/** The cap rounded down to the nearest thousand; exact below 1,000 where rounding would print zero. */
export function roundedCounterCap(cap: bigint): bigint {
  return cap < 1000n ? cap : cap - (cap % 1000n);
}

/** How the cap is SPOKEN: "about 65,000" above the rounding floor, exact below it. */
function displayCapPhrase(cap: bigint): string {
  return cap < 1000n
    ? groupThousands(cap)
    : `about ${groupThousands(roundedCounterCap(cap))}`;
}

export type CounterFill = "none" | "filling" | "full";

/**
 * Classify the counter against its account's cap: "none" below the 75%
 * trigger computed on the EXACT cap; then "filling" below the ROUNDED
 * display cap and "full" at or above it — the split that keeps an exact
 * count from exceeding a rounded cap inside one message.
 */
export function classifyCounterFill(count: bigint, cap: bigint): CounterFill {
  if (count * 4n < cap * 3n) return "none";
  return count >= roundedCounterCap(cap) ? "full" : "filling";
}

/** The value warning; the wall figure and the closing sentence are fixed verbatim. */
export function formatPendingValueWarning(pendingBaseUnits: bigint): string {
  return (
    "◎ UNAPPLIED PENDING IS APPROACHING THE LIMIT THIS CLI CAN READ. " +
    `Cause: this account's unapplied pending stands at ${formatDdcAmount(pendingBaseUnits)} DDC, against a readable limit of about 280,000,000.000000 DDC. ` +
    "Risk: the on-chain figures stay exact and no value is lost, but past the limit this CLI cannot show your pending total or write a truthful balance copy, and once the pending credit counter fills the account stops accepting confidential credits. " +
    "Action: run ddc apply-pending to fold pending into your confidential balance — any apply resets the pending balance and its counter to zero. " +
    "This warning is a margin, not a guarantee — one very large credit can cross the limit between one read and the next."
  );
}

/** Counter warning C1 — below the rounded cap; the headline is fixed verbatim at its example figures. */
export function formatCounterFillingWarning(count: bigint, cap: bigint): string {
  return (
    `◎ YOUR PENDING CREDIT COUNTER IS FILLING: ${groupThousands(count)} credits, out of ${displayCapPhrase(cap)} this account accepts. ` +
    "Risk: at the cap this account refuses further confidential credits, including your own shielded balances. " +
    "Action: run ddc apply-pending — any apply resets the counter to zero."
  );
}

/** Counter warning C2 — at or above the rounded cap; carries no fraction, and its risk sentence is fixed verbatim. */
export function formatCounterFullWarning(count: bigint): string {
  return (
    `◎ YOUR PENDING CREDIT COUNTER IS FULL OR NEARLY FULL: ${groupThousands(count)} credits. ` +
    "Risk: this account may already be refusing confidential credits, including your own shielded balances. " +
    "Action: run ddc apply-pending now — any apply resets the counter to zero."
  );
}
