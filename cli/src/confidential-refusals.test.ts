// Tests pinning the load-bearing sentences of the three confidential-path
// refusals, on the formatConsentBlock test pattern: without these pins, the
// "shield NOTHING" instruction is one careless edit from silently
// disappearing. Values are arbitrary well-formed fixtures in the
// setup-privacy.test.ts style — no devnet artifact is enshrined here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { address, signature } from "@solana/kit";
import {
  formatCopyCorrectionNotice,
  formatCopyShortRefusal,
  formatCopyUnreadableRefusal,
  formatPostApplyMismatch,
  formatPreSendKeyMismatch,
  formatReadBackFailed,
  formatReadBackMismatch,
  formatUnreadableRefusal,
} from "./confidential-refusals.js";

const ON_CHAIN = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
const DERIVED = address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp");
const ATA = address("3q84mCciN6dXksJymBVHKJqmpZYSM3BTZVysWGGK1bdm");
const SIG = signature(
  "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8",
);

test("formatPreSendKeyMismatch: names both keys and the earlier derivation, says nothing was sent, leaves the public balance alone, claims no loss, and carries the shield-nothing instruction", () => {
  const msg = formatPreSendKeyMismatch({ onChainKey: ON_CHAIN, derivedKey: DERIVED });
  assert.match(msg, /^KEY MISMATCH — /);
  assert.match(msg, new RegExp(ON_CHAIN));
  assert.match(msg, new RegExp(DERIVED));
  assert.match(msg, /different derivation/);
  assert.match(msg, /earlier version of this tool \(0\.1\.0\), whose derivation included the account's owner and mint, or another wallet application/);
  assert.match(msg, /This version cannot read or move this account's confidential balance/);
  assert.match(msg, /Its public balance is unaffected/);
  assert.match(msg, /nothing was sent/);
  assert.match(msg, /use the tool that set the account up/);
  assert.match(msg, /Shield nothing into this account's confidential balance/);
  assert.doesNotMatch(msg, /lost|unrecoverable|cannot be recovered/);
});

test("formatReadBackFailed: cause (stale read), risk (a second send pays a fee), the filled-in check line, and a conditioned re-run", () => {
  const msg = formatReadBackFailed({
    signature: SIG,
    tokenAccount: ATA,
    stateKind: "unconfigured",
  });
  assert.match(msg, /^READ-BACK FAILED — /);
  assert.match(msg, new RegExp(SIG));
  assert.match(msg, /reads as "unconfigured"/);
  assert.match(msg, /stale or lagging RPC read/);
  assert.match(msg, /Do NOT re-run/);
  assert.match(msg, /second send pays a fee/);
  assert.match(msg, new RegExp(`solana account ${ATA} --url`));
  assert.match(msg, /re-run only if/);
});

test("formatReadBackMismatch: UNSAFE verdict, the shield-NOTHING instruction, and the second-endpoint action, naming both keys and the signature", () => {
  const msg = formatReadBackMismatch({
    onChainKey: ON_CHAIN,
    derivedKey: DERIVED,
    signature: SIG,
  });
  assert.match(msg, /^READ-BACK MISMATCH — /);
  assert.match(msg, new RegExp(ON_CHAIN));
  assert.match(msg, new RegExp(DERIVED));
  assert.match(msg, new RegExp(SIG));
  assert.match(msg, /UNSAFE/);
  assert.match(msg, /shield NOTHING/);
  assert.match(msg, /cannot be decrypted by you/);
  assert.match(msg, /second RPC endpoint/);
  assert.match(msg, /record both keys/);
});

test("formatUnreadableRefusal: REFUSED headline, the per-branch cause with no parenthetical, the wrong-copy risk, and the send-nothing action", () => {
  const pending = formatUnreadableRefusal("pending");
  assert.match(pending, /^REFUSED — this CLI cannot read your confidential figures, so it will not send this request\./);
  assert.match(pending, /Cause: the pending balance did not decrypt\./);
  assert.match(pending, /Risk: this request writes a new balance copy computed from the figures just read\./);
  assert.match(pending, /would write a copy that is wrong/);
  assert.match(pending, /Nothing was sent and no fee was paid/);
  assert.match(pending, /run ddc balance to re-read/);
  assert.match(pending, /send nothing further into this account's confidential balance/);
  assert.doesNotMatch(pending, /[()]/);
  // One string, three consumers — apply-pending,
  // shield and unshield. It must not name any one command's request. Without
  // this pin the rewording can revert and only a reader would notice.
  assert.doesNotMatch(pending, /apply pending balance request/);
  const confidential = formatUnreadableRefusal("confidential");
  assert.match(confidential, /Cause: the confidential balance did not decrypt\./);
  assert.doesNotMatch(confidential, /pending balance did not decrypt/);
  assert.doesNotMatch(confidential, /apply pending balance request/);
});

test("formatPostApplyMismatch: a short copy names the amount, both counters, and apply-pending as the correction", () => {
  const check = { kind: "short", missingBaseUnits: 1_000_000n } as const;
  const msg = formatPostApplyMismatch({ expected: 1n, actual: 2n, check });
  assert.match(msg, /^APPLY-PENDING CONFIRMED — but the balance copy on this account is short by 1\.000000 DDC\./);
  assert.match(msg, /expected counter 1, actual counter 2/);
  assert.match(msg, /or another command on this account ran at the same time/);
  // The copy on the account may be another command's (D-212).
  assert.match(msg, /the copy now on the account, written by this request or by another command that ran at the same time, was computed without it \(expected counter 1, actual counter 2\)\./);
  assert.doesNotMatch(msg, /the copy this request wrote/);
  assert.match(msg, /nothing on-chain is wrong and no value is lost/);
  assert.match(msg, /Action: run ddc apply-pending\. It corrects the copy, even with nothing pending\.$/);
  assert.doesNotMatch(msg, /no repair exists/);
  // The headline names the command that ran; the body is byte-identical.
  const shield = formatPostApplyMismatch({ expected: 1n, actual: 2n, check, command: "shield" });
  assert.equal(shield.slice("SHIELD CONFIRMED".length), msg.slice("APPLY-PENDING CONFIRMED".length));
  assert.equal(formatPostApplyMismatch({ expected: 1n, actual: 2n, check, command: "apply-pending" }), msg);
});

test("formatPostApplyMismatch: an unreadable difference says so and does not send the holder to apply-pending", () => {
  const msg = formatPostApplyMismatch({ expected: 1n, actual: 1n, check: { kind: "unreadable" } });
  assert.match(msg, /by more than this tool can read/);
  assert.match(msg, /transaction history/);
  assert.doesNotMatch(msg, /run ddc apply-pending/);
});

test("the copy refusals and the correction notice: amount, action, and the nothing-sent clause", () => {
  assert.match(formatCopyShortRefusal(5n), /^REFUSED — the balance copy on this account is short by 0\.000005 DDC/);
  assert.match(formatCopyShortRefusal(5n), /Run ddc apply-pending first.*Nothing was sent and no fee was paid\.$/);
  assert.match(formatCopyUnreadableRefusal(), /^REFUSED — .*Nothing was sent and no fee was paid\.$/);
  assert.match(formatCopyCorrectionNotice(5n), /^CORRECTION — the balance copy on this account is short by 0\.000005 DDC.*This request also writes the corrected figure\.$/);
});
