// DDC amount parsing and display. USER-surface only: decimal in, decimal out, FIXED SIX
// places, string integer arithmetic throughout — no floating point anywhere,
// so no rounding rule exists at either door (a seventh decimal place is
// REFUSED, never rounded). Admin input stays base units; the admin DISPLAY
// retrofit (decimal with base units in parentheses) is owed separately.
//
// DDC_DECIMALS lives HERE and not in constants.ts: everything in
// constants.ts is an overridable default by that file's own header, and a
// mint's decimals is a protocol constant of the instrument, not a setting.
// It is also the value supplied as Deposit's expected_decimals field, which
// keeps the on-chain decimals cross-check genuine.

export const DDC_DECIMALS = 6;

/** The base-unit scale: 10^DDC_DECIMALS. */
export const BASE_UNITS_PER_DDC = 10n ** BigInt(DDC_DECIMALS);

// The accepted grammar, whole: digits, then optionally one dot and one to six
// fraction digits. No sign, no separators, no exponent, no whitespace, and an
// integer part is required ("0.5", never ".5").
const AMOUNT_GRAMMAR = /^([0-9]+)(?:\.([0-9]{1,6}))?$/;
// The one defect that gets its own message: a fraction of seven or more digits.
const TOO_MANY_PLACES = /^[0-9]+\.([0-9]{7,})$/;

/**
 * Parse a user-typed decimal DDC amount into base units (millionths).
 * Pure string integer arithmetic; never floating point. Format-only: range
 * rules (non-zero, deposit caps, balance sufficiency) belong to the calling
 * command, and 0 parses to 0n.
 */
export function parseDdcAmount(text: string): bigint {
  const tooMany = TOO_MANY_PLACES.exec(text);
  if (tooMany !== null) {
    const places = tooMany[1] === undefined ? 0 : tooMany[1].length;
    throw new Error(
      `DDC amounts carry at most six decimal places (one millionth of a DDC); "${text}" has ${places}. ` +
        "Nothing is rounded — restate the amount.",
    );
  }
  const match = AMOUNT_GRAMMAR.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `not a valid DDC amount: "${text}" — use a plain decimal such as 1.5 or 0.000001 ` +
        "(digits with at most one dot and at most six decimal places; an integer part is required; " +
        "no sign, separators, exponent or spaces)",
    );
  }
  const whole = BigInt(match[1]);
  const fraction = match[2] === undefined ? 0n : BigInt(match[2].padEnd(DDC_DECIMALS, "0"));
  return whole * BASE_UNITS_PER_DDC + fraction;
}

/**
 * Render base units as decimal DDC at FIXED SIX places, numeric only —
 * callers add the unit word and any label (output shape never depends on
 * the value). A negative input is a bug upstream, not a display
 * case: balances and amounts are unsigned on-chain, so this throws rather
 * than inventing a sign convention.
 */
export function formatDdcAmount(baseUnits: bigint): string {
  if (baseUnits < 0n) {
    throw new Error(`amount in base units must be non-negative, got ${baseUnits}`);
  }
  const whole = baseUnits / BASE_UNITS_PER_DDC;
  const fraction = baseUnits % BASE_UNITS_PER_DDC;
  return `${whole}.${fraction.toString().padStart(DDC_DECIMALS, "0")}`;
}
