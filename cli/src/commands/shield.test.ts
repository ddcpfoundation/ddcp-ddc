// Tests pinning the `ddc shield` copy and its pure pre-check helper. Per the
// suite convention nothing here
// calls runShield; its three pre-identity refusal orderings are in
// entry-ordering.test.ts, and the devnet run proves the send path. Every test
// name is prefixed `shield:` so it cannot collide with the shield-tx siblings.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Signature } from "@solana/kit";
import { NETWORK_FEE_LINE } from "../announcements.js";
import {
  SHIELD_OPERATION,
  SHIELD_UNCONFIGURED_STOP,
  SHIELD_USAGE,
  formatAtCapRefusal,
  formatInsufficientPublicRefusal,
  formatPendingPresentRefusal,
  formatShieldAnnouncement,
  formatShieldCounterMovedRefusal,
  formatShieldHeader,
  formatShieldSuccess,
  parseShieldAmount,
} from "./shield.js";

// TEST-ONLY cast, on the commands/apply-pending.test.ts precedent.
const TEST_SIGNATURE =
  "4EkGCTkVCJjMSFiPGkgcRDMTNjTQfsNBHYMkfjhBcbsnkQnvSNKmB4hTsXTNPWZDdRuLBFqCS8pR1aFwCFTQFbEt" as unknown as Signature;

test("shield: parseShieldAmount accepts exactly one decimal positional and returns base units", () => {
  assert.equal(parseShieldAmount(["1.5"]), 1_500_000n);
  assert.equal(parseShieldAmount(["0.000001"]), 1n);
  assert.equal(parseShieldAmount(["281474976.710655"]), 281_474_976_710_655n);
});

test("shield: a zero amount is a usage error naming the smallest amount, never a base-unit sentence", () => {
  for (const text of ["0", "0.0", "0.000000"]) {
    assert.throws(
      () => parseShieldAmount([text]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^shield: usage — shield <amount> --keypair <path> --rpc-url <url>\n/);
        assert.match(err.message, /the amount must be at least 0\.000001 DDC; got /);
        assert.doesNotMatch(err.message, /base unit/);
        assert.doesNotMatch(err.message, /refusing to shield/);
        return true;
      },
    );
  }
});

test("shield: no positional, two positionals, and a malformed amount are usage errors carrying the amount grammar message", () => {
  assert.throws(() => parseShieldAmount([]), /shield takes exactly one amount; got 0 positional arguments/);
  assert.throws(() => parseShieldAmount(["1", "2"]), /shield takes exactly one amount; got 2 positional arguments/);
  assert.throws(() => parseShieldAmount(["1.2345678"]), /at most six decimal places/);
  assert.throws(() => parseShieldAmount(["abc"]), /not a valid DDC amount/);
  for (const bad of [[], ["1", "2"], ["abc"]]) {
    assert.throws(
      () => parseShieldAmount(bad),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^shield: usage — shield <amount> --keypair <path> --rpc-url <url>\n/);
        return true;
      },
    );
  }
});

test("shield: the operation phrase names shielding and the fee-paying transaction, never --broadcast", () => {
  assert.equal(SHIELD_OPERATION, "shielding into your confidential balance (a signed, fee-paying transaction)");
  assert.doesNotMatch(SHIELD_OPERATION, /--broadcast/);
  assert.equal(SHIELD_USAGE, "shield: usage — shield <amount> --keypair <path> --rpc-url <url>");
});

test("shield: the unconfigured stop is one message for both unactivated states, naming the lowercase command literal and the sent/fee clause", () => {
  assert.equal(
    SHIELD_UNCONFIGURED_STOP,
    "Nothing to shield — Confidential Balances is not activated on this account, so there is no confidential balance to shield into. No transaction was sent and no fee was paid. Run ddc setup-privacy to activate (strongly recommended).",
  );
  assert.match(SHIELD_UNCONFIGURED_STOP, /Run ddc setup-privacy/);
  assert.doesNotMatch(SHIELD_UNCONFIGURED_STOP, /DDC setup-privacy/);
});

test("shield: the at-cap refusal names the exact count and cap, cause, risk, nothing sent, and points at apply-pending", () => {
  const msg = formatAtCapRefusal({ count: 65536n, cap: 65536n });
  assert.match(msg, /^REFUSED — this account's pending credit counter is at its cap \(65536 of 65536\)/);
  assert.match(msg, /Cause: unapplied pending credits have filled the counter\./);
  assert.match(msg, /Risk: a Deposit sent now fails on-chain after the fee is paid\./);
  assert.match(msg, /Nothing was sent and no fee was paid\./);
  assert.match(msg, /Action: run ddc apply-pending to fold pending and reset the counter to zero, then shield\.$/);
  assert.doesNotMatch(msg, /about /);
});

test("shield: the pending refusal names the count with a proper singular and plural, nothing sent, and points at apply-pending first", () => {
  const many = formatPendingPresentRefusal(3n);
  assert.equal(
    many,
    "REFUSED — 3 pending credits are waiting on this account, and a shield would fold them in together with the amount you stated. Nothing was sent and no fee was paid. Action: run ddc apply-pending first, then shield.",
  );
  const one = formatPendingPresentRefusal(1n);
  assert.match(one, /^REFUSED — 1 pending credit is waiting on this account, and a shield would fold it in together/);
  assert.doesNotMatch(one, /\(s\)/);
  assert.doesNotMatch(many, /DDC apply-pending/);
});

test("shield: the sufficiency refusal states both figures at fixed six places and the sent/fee clause", () => {
  const msg = formatInsufficientPublicRefusal({ amountBaseUnits: 700_000_000n, publicBaseUnits: 601_000_000n });
  assert.match(msg, /^REFUSED — 700\.000000 DDC is more than the 601\.000000 DDC in your public balance\./);
  assert.match(msg, /Nothing was sent and no fee was paid\. Restate a smaller amount\.$/);
});

test("shield: the counter-moved refusal names both counter values, nothing sent, and the fixed action sentence", () => {
  const msg = formatShieldCounterMovedRefusal({ atRead: 3n, atSend: 4n });
  assert.match(msg, /^REFUSED — the pending credit counter moved from 3 to 4 between this command's read and its send\./);
  assert.match(msg, /Cause: a confidential credit arrived in that window\./);
  assert.match(msg, /would understate your confidential balance/);
  assert.match(msg, /Nothing was sent and no fee was paid\./);
  assert.equal(
    msg.slice(msg.indexOf("Action:")),
    "Action: run ddc shield again; under a continuous stream of credits it will keep refusing; these refusals are deliberate and incur no cost.",
  );
  assert.doesNotMatch(msg, /DDC shield/);
});

test("shield: the announcement is the fixed five lines in order, carrying the fee line and the cluster source, and asking nothing", () => {
  const block = formatShieldAnnouncement({
    amountBaseUnits: 1_500_000n,
    confidentialAfterBaseUnits: 1_570_000n,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "flag",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], formatShieldHeader(1_500_000n));
  assert.equal(lines[0], "SHIELD — moving 1.500000 DDC from your public balance into your confidential balance");
  assert.equal(lines[1], "○ shielding : 1.500000 DDC");
  assert.equal(lines[2], "● confidential after : 1.570000 DDC");
  assert.equal(lines[3], NETWORK_FEE_LINE);
  assert.equal(lines[4], "cluster : https://api.devnet.solana.com (flag)");
  assert.doesNotMatch(block, /\?/);
  assert.doesNotMatch(block, /deposit/);
});

test("shield: the SHIELD CONFIRMED success line carries the signature, the amount shielded and the figure just written", () => {
  const msg = formatShieldSuccess({
    signature: TEST_SIGNATURE,
    amountBaseUnits: 1_500_000n,
    confidentialAfterBaseUnits: 1_570_000n,
  });
  assert.equal(
    msg,
    `SHIELD CONFIRMED — signature ${TEST_SIGNATURE}; 1.500000 DDC shielded; your confidential balance now reads 1.570000 DDC.`,
  );
  assert.doesNotMatch(msg, /deposit/i);
});
