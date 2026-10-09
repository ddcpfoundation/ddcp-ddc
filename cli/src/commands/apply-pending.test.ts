// Tests pinning the apply-pending command copy — the header and
// zero-stop that landed ahead of the body, plus the four strings the body
// itself introduces. Per the suite convention nothing here calls
// runApplyPending; its three pre-identity refusal orderings are in
// entry-ordering.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Signature } from "@solana/kit";
import { NETWORK_FEE_LINE } from "../announcements.js";
import {
  APPLY_UNACTIVATED_STOP,
  APPLY_ZERO_STOP,
  formatApplyAnnouncement,
  formatApplyHeader,
  formatApplySuccess,
  formatCounterMovedRefusal,
} from "./apply-pending.js";

// TEST-ONLY cast, on the tx/apply-pending-tx.test.ts precedent: Signature is a
// branded string with no constructor this build has verified, and the formatter
// under test only interpolates it.
const TEST_SIGNATURE =
  "4EkGCTkVCJjMSFiPGkgcRDMTNjTQfsNBHYMkfjhBcbsnkQnvSNKmB4hTsXTNPWZDdRuLBFqCS8pR1aFwCFTQFbEt" as unknown as Signature;

test("formatApplyHeader: the fixed example verbatim at 4, a proper singular at 1, and never the (s) form", () => {
  assert.equal(
    formatApplyHeader(4n),
    "APPLY PENDING BALANCE — folding 4 pending credits into your confidential balance",
  );
  assert.equal(
    formatApplyHeader(1n),
    "APPLY PENDING BALANCE — folding 1 pending credit into your confidential balance",
  );
  assert.doesNotMatch(formatApplyHeader(1n), /\(s\)/);
  assert.doesNotMatch(formatApplyHeader(4n), /\(s\)/);
});

test("APPLY_ZERO_STOP: the fixed sentence exactly — counter only, no figure, and the sent/fee clause", () => {
  assert.equal(
    APPLY_ZERO_STOP,
    "Nothing to apply — pending credit counter 0. No transaction was sent and no fee was paid.",
  );
});

test("APPLY_UNACTIVATED_STOP: one sentence for both unactivated states, naming the lowercase command literal and the sent/fee clause", () => {
  assert.equal(
    APPLY_UNACTIVATED_STOP,
    "Nothing to apply — Confidential Balances is not activated on this account, so nothing can be pending. No transaction was sent and no fee was paid. Run ddc setup-privacy to activate (strongly recommended).",
  );
  // The currency is DDC and the command is ddc; the two never converge.
  assert.match(APPLY_UNACTIVATED_STOP, /Run ddc setup-privacy/);
  assert.doesNotMatch(APPLY_UNACTIVATED_STOP, /DDC setup-privacy/);
});

test("formatCounterMovedRefusal: cause names both counter values, nothing sent and no fee, and the action is honest about a sustained stream", () => {
  const message = formatCounterMovedRefusal({ atRead: 3n, atSend: 4n });
  assert.match(message, /^REFUSED — /);
  assert.match(message, /Cause: the pending credit counter moved from 3 to 4/);
  assert.match(message, /Nothing was sent and no fee was paid\./);
  assert.match(message, /Action: run ddc apply-pending again/);
  assert.match(message, /continuous stream of credits/);
  assert.match(message, /these refusals are deliberate and incur no cost/);
  assert.doesNotMatch(message, /DDC apply-pending/);
});

test("formatApplyAnnouncement: the fixed five lines in order, carrying the fee bound and the cluster source, and asking nothing", () => {
  const block = formatApplyAnnouncement({
    credits: 4n,
    pendingBaseUnits: 70_000n,
    confidentialAfterBaseUnits: 1_570_000n,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "flag",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], formatApplyHeader(4n));
  assert.equal(lines[1], "◎ pending to fold : 0.070000 DDC");
  assert.equal(lines[2], "● confidential after : 1.570000 DDC");
  assert.equal(lines[3], NETWORK_FEE_LINE);
  assert.equal(lines[4], "cluster : https://api.devnet.solana.com (flag)");
  // The fee line is fixed verbatim and is asserted here rather
  // than only through the block, so a change to it fails by name.
  assert.equal(
    NETWORK_FEE_LINE,
    "network fee : less than 0.00002 SOL (base signature fee, paid by this wallet)",
  );
  // A disclosure, not a question: nothing here asks anything.
  assert.doesNotMatch(block, /\?/);
  assert.doesNotMatch(block, /\(s\)/);
});

test("formatApplySuccess: the APPLY-PENDING CONFIRMED headline, the signature, a proper plural and the figure just written", () => {
  const many = formatApplySuccess({
    signature: TEST_SIGNATURE,
    credits: 4n,
    confidentialAfterBaseUnits: 1_570_000n,
  });
  assert.match(many, /^APPLY-PENDING CONFIRMED — signature /);
  assert.match(many, new RegExp(TEST_SIGNATURE));
  assert.match(many, /4 pending credits folded into your confidential balance/);
  assert.match(many, /now reads 1\.570000 DDC\.$/);
  const one = formatApplySuccess({
    signature: TEST_SIGNATURE,
    credits: 1n,
    confidentialAfterBaseUnits: 1n,
  });
  assert.match(one, /1 pending credit folded/);
  assert.match(one, /now reads 0\.000001 DDC\.$/);
  assert.doesNotMatch(one, /\(s\)/);
});
