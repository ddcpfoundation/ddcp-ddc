// Tests for the pure display and copy helpers of `ddc balance`. Per the suite convention nothing here calls runBalance; its
// two pre-identity refusal orderings are in entry-ordering.test.ts. The
// pins hold the FIXED display — order confidential/public/pending, glyphs
// ○/◎/●, fixed six places, no "balance" in the labels under the BALANCE
// heading — and the alert/warning copy's cause-risk-action content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import {
  formatActivationOffer,
  formatBalanceBlock,
  formatCountersLine,
  formatFigure,
  formatForeignNote,
  formatPendingAlert,
  formatShieldAlert,
  formatStaleWarning,
  formatThresholdWarnings,
  formatUnreadableWarning,
} from "./balance.js";
import { PENDING_VALUE_WARNING_BASE_UNITS } from "../confidential-warnings.js";

const OWNER = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
const ATA = address("3q84mCciN6dXksJymBVHKJqmpZYSM3BTZVysWGGK1bdm");

test("formatBalanceBlock: fixed order and glyphs, fixed-six figures, no label repeats the word balance", () => {
  const block = formatBalanceBlock(ATA, OWNER, {
    confidential: "1.500000 DDC",
    public: "20.000000 DDC",
    pending: "0.070000 DDC",
  });
  assert.match(block, /^BALANCE — token account /);
  assert.match(block, new RegExp(ATA));
  assert.match(block, new RegExp(OWNER));
  const confidentialAt = block.indexOf("● confidential");
  const publicAt = block.indexOf("○ public");
  const pendingAt = block.indexOf("◎ pending");
  assert.ok(publicAt > 0 && pendingAt > publicAt && confidentialAt > pendingAt);
  assert.match(block, /● confidential {1,}: 1\.500000 DDC/);
  assert.match(block, /○ public {1,}: 20\.000000 DDC/);
  assert.match(block, /◎ pending {1,}: 0\.070000 DDC/);
  assert.doesNotMatch(block, /available/);
  assert.doesNotMatch(block, /confidential balance :/);
  const publicOnly = formatBalanceBlock(ATA, OWNER, { public: "0.000000 DDC" });
  assert.doesNotMatch(publicOnly, /●|◎/);
  assert.match(publicOnly, /○ public {1,}: 0\.000000 DDC/);
});

test("formatFigure: readable renders fixed six with the unit; unreadable renders UNREADABLE, never zero", () => {
  assert.equal(formatFigure({ readable: true, baseUnits: 1_500_000n }), "1.500000 DDC");
  assert.equal(formatFigure({ readable: true, baseUnits: 0n }), "0.000000 DDC");
  assert.equal(formatFigure({ readable: false, reason: "x" }), "UNREADABLE");
});

test("offer, foreign and counters copy: name the command, state the scope, pass the counters through", () => {
  assert.match(formatActivationOffer("absent"), /no DDC token account yet/);
  assert.match(formatActivationOffer("absent"), /ddc setup-privacy/);
  assert.match(formatActivationOffer("unconfigured"), /not activated/);
  assert.match(formatActivationOffer("unconfigured"), /strongly recommended/);
  assert.match(formatForeignNote(true), /readable only by the account holder; showing public state and counters$/);
  assert.match(formatForeignNote(false), /showing public state$/);
  assert.doesNotMatch(formatForeignNote(false), /counters/);
  const counters = formatCountersLine({
    pendingBalanceCreditCounter: 3n,
    maximumPendingBalanceCreditCounter: 65536n,
    expectedPendingBalanceCreditCounter: 2n,
    actualPendingBalanceCreditCounter: 3n,
  });
  assert.match(counters, /pending credits 3 of 65536/);
  assert.match(counters, /expected 2 \/ actual 3/);
});

test("pending and shield alerts: alert-plus-offer, a proper singular and plural, naming the command, never automatic", () => {
  const pending = formatPendingAlert(4n);
  assert.match(pending, /4 pending credits are not yet spendable/);
  assert.match(pending, /fold them into your confidential balance/);
  assert.match(pending, /ddc apply-pending/);
  assert.doesNotMatch(pending, /\(s\)/);
  assert.doesNotMatch(pending, /DDC apply-pending/);
  const onePending = formatPendingAlert(1n);
  assert.match(onePending, /1 pending credit is not yet spendable/);
  assert.match(onePending, /fold it into your confidential balance/);
  assert.doesNotMatch(onePending, /pending credits/);
  assert.doesNotMatch(onePending, /\(s\)/);
  const shield = formatShieldAlert(20_000_000n);
  assert.match(shield, /20\.000000 DDC/);
  assert.match(shield, /PUBLIC balance/);
  assert.match(shield, /ddc shield/);
  assert.match(shield, /never shields automatically/);
  assert.doesNotMatch(shield, /deposit/);
});

test("stale and unreadable warnings: cause, risk and action, honest about non-repair and never claiming zero", () => {
  const stale = formatStaleWarning(1n, 2n);
  assert.match(stale, /UNDERSTATE/);
  assert.match(stale, /expected counter 1, actual 2/);
  assert.match(stale, /Cause: a past apply raced an incoming credit/);
  assert.match(stale, /NOT recoverable by re-applying/);
  assert.match(stale, /lower bound/);
  const unreadable = formatUnreadableWarning("pending", "wrong key");
  assert.match(unreadable, /pending figure is UNREADABLE/);
  assert.match(unreadable, /\(wrong key\)/);
  assert.match(unreadable, /NOT zero/);
  assert.match(unreadable, /second RPC endpoint/);
  assert.match(unreadable, /do not transact confidentially/);
  // THE CAUSE IS ONE OF THREE AND THE COPY NAMES IT AS SUCH. An unreadable
  // figure was once blamed on another client outright; a fee-bearing credit
  // that leaves the lo limb negative is read now, and what remains is a wrong
  // key, a foreign write or a figure past the read limit.
  assert.match(unreadable, /one of a wrong key/);
  assert.doesNotMatch(unreadable, /persists, the stored copy was written by another client/);
});

// THRESHOLD WARNINGS on the holder's own account. The triggers are the module's own: value at 2^47 base units,
// counter at 75% of the EXACT cap. What this file pins is the BRANCH LOGIC:
// which warnings print for which state, in which order, and that an
// unreadable pending figure silences the value warning without silencing the
// counter pair.

test("formatThresholdWarnings: nothing below both triggers; value at exactly 2^47; counter filling at exactly 75% of the exact cap; full at the rounded cap", () => {
  const cap = 65536n;
  const quiet = { pending: { readable: true as const, baseUnits: PENDING_VALUE_WARNING_BASE_UNITS - 1n }, pendingBalanceCreditCounter: 49151n, maximumPendingBalanceCreditCounter: cap };
  assert.deepEqual(formatThresholdWarnings(quiet), []);
  const value = formatThresholdWarnings({ ...quiet, pending: { readable: true, baseUnits: PENDING_VALUE_WARNING_BASE_UNITS } });
  assert.equal(value.length, 1);
  assert.match(value[0]!, /UNAPPLIED PENDING IS APPROACHING THE LIMIT/);
  assert.match(value[0]!, /140,737,488\.355328 DDC|140737488\.355328 DDC/);
  const filling = formatThresholdWarnings({ ...quiet, pendingBalanceCreditCounter: 49152n });
  assert.equal(filling.length, 1);
  assert.match(filling[0]!, /COUNTER IS FILLING: 49,152 credits, out of about 65,000/);
  const full = formatThresholdWarnings({ ...quiet, pendingBalanceCreditCounter: 65000n });
  assert.equal(full.length, 1);
  assert.match(full[0]!, /COUNTER IS FULL OR NEARLY FULL: 65,000 credits/);
  assert.doesNotMatch(full[0]!, /out of/);
});

test("formatThresholdWarnings: value then counter when both fire; an unreadable pending figure silences the value warning and not the counter pair", () => {
  const cap = 65536n;
  const both = formatThresholdWarnings({ pending: { readable: true, baseUnits: PENDING_VALUE_WARNING_BASE_UNITS }, pendingBalanceCreditCounter: 60000n, maximumPendingBalanceCreditCounter: cap });
  assert.equal(both.length, 2);
  assert.match(both[0]!, /UNAPPLIED PENDING/);
  assert.match(both[1]!, /COUNTER IS FILLING/);
  const unreadable = formatThresholdWarnings({ pending: { readable: false, reason: "x" }, pendingBalanceCreditCounter: 60000n, maximumPendingBalanceCreditCounter: cap });
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0]!, /COUNTER IS FILLING/);
  assert.deepEqual(formatThresholdWarnings({ pending: { readable: false, reason: "x" }, pendingBalanceCreditCounter: 0n, maximumPendingBalanceCreditCounter: cap }), []);
});
