// Tests pinning the load-bearing sentences of the three confidential-path
// refusals, on the formatConsentBlock test pattern: without these pins, the
// "shield NOTHING" instruction is one careless edit from silently
// disappearing. Values are arbitrary well-formed fixtures in the
// setup-privacy.test.ts style — no devnet artifact is enshrined here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { address, signature } from "@solana/kit";
import {
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

test("formatPreSendKeyMismatch: names both keys, says nothing was sent, and carries the shield-NOTHING instruction", () => {
  const msg = formatPreSendKeyMismatch({ onChainKey: ON_CHAIN, derivedKey: DERIVED });
  assert.match(msg, /^KEY MISMATCH — /);
  assert.match(msg, new RegExp(ON_CHAIN));
  assert.match(msg, new RegExp(DERIVED));
  assert.match(msg, /nothing was sent/);
  assert.match(msg, /Shield NOTHING/);
  assert.match(msg, /cannot be decrypted by this wallet/);
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

test("formatPostApplyMismatch: APPLY-PENDING CONFIRMED headline, both counters, the may-be-refused clause, and the no-repair-yet action line", () => {
  const msg = formatPostApplyMismatch({ expected: 3n, actual: 5n });
  assert.match(msg, /^APPLY-PENDING CONFIRMED — /);
  assert.doesNotMatch(msg, /^APPLY CONFIRMED/);
  assert.match(msg, /^APPLY-PENDING CONFIRMED — but your displayed confidential balance may understate what you hold\./);
  assert.match(msg, /expected counter 3, actual counter 5/);
  assert.match(msg, /network folded it correctly/);
  assert.match(msg, /nothing on-chain is wrong and no value is lost/);
  assert.match(msg, /does not correct the copy/);
  assert.match(msg, /confidential sends from this account may be refused by the network/);
  assert.match(msg, /no repair exists yet/);
  assert.match(msg, /a later capability/);
  assert.match(msg, /lower bound/);
  assert.match(msg, /Shielding into this account continues to work normally/);
  assert.match(msg, /Do not repeat the request expecting a fix\.$/);
  assert.doesNotMatch(msg, /requires reconstructing/);
  // The headline names the command that ran; the body is byte-identical.
  const shield = formatPostApplyMismatch({ expected: 3n, actual: 5n, command: "shield" });
  assert.match(shield, /^SHIELD CONFIRMED — but your displayed confidential balance may understate what you hold\./);
  assert.equal(shield.slice("SHIELD CONFIRMED".length), msg.slice("APPLY-PENDING CONFIRMED".length));
  assert.equal(formatPostApplyMismatch({ expected: 3n, actual: 5n, command: "apply-pending" }), msg);
});
