// Tests pinning the 'ddc confidential-transfer' copy and its pure helpers. Per the suite
// convention nothing here calls runConfidentialTransfer; its pre-identity refusal
// orderings live in entry-ordering.test.ts alongside the dispatcher
// registration, and the devnet run proves the send path.
//
// EVERY TEST NAME IS PREFIXED 'confidential-transfer:' so it cannot collide with the
// 'transfer proofs:' and 'transfer-tx:' names in tx/.
//
// THE COPY OF RECORD IS PINNED WHOLE where its wording is fixed: the auditor lines, the fee line shape, the not-an-address and
// not-activated refusals and the minimum-fee refusal. The em dash in every
// refusal frame is built by String.fromCharCode here as it is in the
// module, so no test depends on the character surviving transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { address, type Address, type Signature } from "@solana/kit";
import type { Mint } from "@solana-program/token-2022";
import { formatFeeLine, NETWORK_FEE_LINE } from "../announcements.js";
import {
  formatBelowMinimumFeeRefusal,
  formatNotAnAddressRefusal,
  formatSelfTransferRefusal,
} from "../transfer-refusals.js";
import { sameScheduleParameters, scheduleStillOnMint } from "../tx/schedule-headroom.js";
import { CONFIRM_ABORTED_BEFORE_SEND, TYPED_CONFIRM_QUESTION } from "../confirm-prompt.js";
import { splitTransferFee, type TransferFeeSchedule } from "../tx/transfer-fee-split.js";
import {
  AUDITOR_LINE_NONE,
  AUDITOR_LINE_PRESENT,
  CONFIDENTIAL_TRANSFER_AFTER_FAILED_SEND,
  CONFIDENTIAL_TRANSFER_OPERATION,
  CONFIDENTIAL_TRANSFER_UNAPPROVED_STOP,
  CONFIDENTIAL_TRANSFER_UNCONFIGURED_STOP,
  CONFIDENTIAL_TRANSFER_USAGE,
  formatBalanceMovedRefusal,
  formatInsufficientConfidentialRefusal,
  formatPendingCreditsNote,
  formatRecipientCannotReceiveRefusal,
  formatRecipientNotActivatedRefusal,
  formatScheduleMovedRefusal,
  formatConfidentialTransferAnnouncement,
  formatConfidentialTransferHeader,
  formatConfidentialTransferSuccess,
  parseTransferArgs,
  readMintConfidentialTransferKeys,
} from "./confidential-transfer.js";

const EM = String.fromCharCode(0x2014);
const RECIPIENT = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
const DEVNET: TransferFeeSchedule = { epoch: 1108n, maximumFee: 1_000_000n, basisPoints: 100 };
// TEST-ONLY cast, on the commands/apply-pending.test.ts precedent.
const TEST_SIGNATURE =
  "4EkGCTkVCJjMSFiPGkgcRDMTNjTQfsNBHYMkfjhBcbsnkQnvSNKmB4hTsXTNPWZDdRuLBFqCS8pR1aFwCFTQFbEt" as unknown as Signature;

test("confidential-transfer: parseTransferArgs takes a decimal amount and a wallet address, in that order", () => {
  const parsed = parseTransferArgs(["1.5", RECIPIENT]);
  assert.equal(parsed.netBaseUnits, 1_500_000n);
  assert.equal(parsed.recipient, RECIPIENT);
  assert.equal(parseTransferArgs(["0.000001", RECIPIENT]).netBaseUnits, 1n);
});

test("confidential-transfer: a zero, malformed or missing amount is a usage error naming no base unit", () => {
  for (const text of ["0", "0.0", "0.000000"]) {
    assert.throws(() => parseTransferArgs([text, RECIPIENT]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.split("\n")[0], CONFIDENTIAL_TRANSFER_USAGE);
      assert.match(err.message, /the amount must be at least 0\.000001 DDC; got /);
      assert.doesNotMatch(err.message, /base unit/);
      return true;
    });
  }
  assert.throws(() => parseTransferArgs([]), /confidential-transfer takes exactly one amount and one recipient wallet address; got 0 positional arguments/);
  assert.throws(() => parseTransferArgs(["1.5"]), /got 1 positional arguments/);
  assert.throws(() => parseTransferArgs(["1.5", RECIPIENT, "x"]), /got 3 positional arguments/);
  assert.throws(() => parseTransferArgs(["1.2345678", RECIPIENT]), /at most six decimal places/);
  assert.throws(() => parseTransferArgs(["abc", RECIPIENT]), /not a valid DDC amount/);
});

test("confidential-transfer: a recipient that is not a Solana wallet address is refused by name at the shape stage", () => {
  for (const bad of ["not-an-address", "0x1234", ""]) {
    assert.throws(() => parseTransferArgs(["1.5", bad]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, formatNotAnAddressRefusal(bad));
      assert.equal(err.message, "REFUSED " + EM + " " + bad + " is not a Solana wallet address. Nothing was sent and no fee was paid.");
      assert.doesNotMatch(err.message, /--keypair/);
      return true;
    });
  }
});

test("confidential-transfer: the usage line and the operation phrase name the recipient and never --broadcast", () => {
  assert.equal(CONFIDENTIAL_TRANSFER_USAGE, "confidential-transfer: usage " + EM + " confidential-transfer <amount> <recipient-wallet> --keypair <path> --rpc-url <url>");
  assert.equal(CONFIDENTIAL_TRANSFER_OPERATION, "transferring from your confidential balance (one signed, fee-paying transaction)");
  assert.doesNotMatch(CONFIDENTIAL_TRANSFER_OPERATION, /--broadcast|five/);
});

test("confidential-transfer: the sender-side stops say nothing was sent and name no flag", () => {
  assert.match(CONFIDENTIAL_TRANSFER_UNCONFIGURED_STOP, /^Nothing to transfer /);
  assert.match(CONFIDENTIAL_TRANSFER_UNCONFIGURED_STOP, /No transaction was sent and no fee was paid\./);
  assert.match(CONFIDENTIAL_TRANSFER_UNCONFIGURED_STOP, /Run ddc setup-privacy to activate/);
  assert.match(CONFIDENTIAL_TRANSFER_UNAPPROVED_STOP, /^REFUSED /);
  assert.match(CONFIDENTIAL_TRANSFER_UNAPPROVED_STOP, /Nothing was sent and no fee was paid\.$/);
  assert.doesNotMatch(CONFIDENTIAL_TRANSFER_UNAPPROVED_STOP, /--/);
});

test("confidential-transfer: the recipient refusals of record", () => {
  assert.equal(
    formatRecipientNotActivatedRefusal(RECIPIENT),
    "REFUSED " + EM + " " + RECIPIENT + " has no Confidential Balances activated, so a confidential transfer to it cannot be built. " +
      "Nothing was sent and no fee was paid. The recipient can activate with ddc setup-privacy.",
  );
  for (const why of ["unapproved", "credits-disabled", "pending-full"] as const) {
    const msg = formatRecipientCannotReceiveRefusal(RECIPIENT, why);
    assert.match(msg, /^REFUSED /);
    assert.match(msg, new RegExp(RECIPIENT + " cannot receive a confidential transfer right now: "));
    assert.match(msg, /Nothing was sent and no fee was paid\.$/);
  }
  assert.match(formatRecipientCannotReceiveRefusal(RECIPIENT, "pending-full"), /ddc apply-pending/);
  assert.match(formatSelfTransferRefusal(RECIPIENT), /^REFUSED /);
  assert.match(formatSelfTransferRefusal(RECIPIENT), /is this wallet\. A transfer to yourself moves nothing\. Nothing was sent and no fee was paid\.$/);
});

test("confidential-transfer: the minimum-fee refusal of record and the gross-based insufficiency refusal", () => {
  assert.equal(
    formatBelowMinimumFeeRefusal({ feeBaseUnits: 1_000n, minimumFeeBaseUnits: 5_000n }),
    "REFUSED " + EM + " the fee on this amount (0.001000 DDC) is below the minimum fee this instrument sets (0.005000 DDC). " +
      "Nothing was sent and no fee was paid. Restate a larger amount.",
  );
  const msg = formatInsufficientConfidentialRefusal({ netBaseUnits: 700_000_000n, grossBaseUnits: 701_000_000n, confidentialBaseUnits: 601_000_000n });
  assert.match(msg, /sending 700\.000000 DDC costs 701\.000000 DDC with the fee, which is more than the 601\.000000 DDC your confidential balance reads\./);
  assert.match(msg, /Nothing was sent and no fee was paid\. Restate a smaller amount\.$/);
});

test("confidential-transfer: the two moved refusals say nothing was sent and point at ddc confidential-transfer", () => {
  for (const msg of [formatBalanceMovedRefusal(), formatScheduleMovedRefusal()]) {
    assert.match(msg, /^REFUSED /);
    assert.match(msg, /Nothing was sent and no fee was paid\. Run ddc confidential-transfer again\.$/);
    assert.doesNotMatch(msg, /rent|cleanup|result account/i);
  }
  assert.match(formatScheduleMovedRefusal(), /fee schedule on the mint changed/);
});

test("confidential-transfer: the announcement is nine lines in order, with the fee shown, the auditor line, the shared fee line, and asks nothing", () => {
  const split = splitTransferFee(101_000_000n, DEVNET);
  const block = formatConfidentialTransferAnnouncement({
    netBaseUnits: 100_000_000n,
    recipient: RECIPIENT,
    confidentialBeforeBaseUnits: 600_500_000n,
    split,
    schedule: DEVNET,
    grossBaseUnits: 101_000_000n,
    zeroAuditorKey: true,
    pendingBaseUnits: 0n,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "flag",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], formatConfidentialTransferHeader({ netBaseUnits: 100_000_000n, recipient: RECIPIENT }));
  assert.equal(lines[0], "TRANSFER " + EM + " sending 100.000000 DDC from your confidential balance to " + RECIPIENT);
  assert.equal(lines[1], "confidential before : 600.500000 DDC");
  assert.equal(lines[2], "recipient receives : 100.000000 DDC");
  assert.equal(lines[3], formatFeeLine({ feeBaseUnits: split.feeAmount, schedule: DEVNET }));
  assert.equal(lines[3], "fee : 1.000000 DDC (100 bps, cap 1.000000 DDC) withheld to the mint's fee ledger");
  assert.equal(lines[4], "total debited : 101.000000 DDC (recipient receives + fee)");
  assert.equal(lines[5], "confidential after : 499.500000 DDC");
  assert.equal(lines[6], AUDITOR_LINE_NONE);
  assert.equal(lines[7], NETWORK_FEE_LINE);
  assert.equal(lines[8], "cluster : https://api.devnet.solana.com (flag)");
  assert.doesNotMatch(block, /\?/);
  assert.doesNotMatch(block, /TransferWithFee|withdraw/i);
  assert.match(TYPED_CONFIRM_QUESTION, /^Type CONFIRM to send this transaction, /);
});

test("confidential-transfer: the auditor lines of record, neither printing a key; the present form swaps in", () => {
  assert.equal(AUDITOR_LINE_NONE, "auditor : The transaction amount is encrypted, only you and the recipient can read it.");
  assert.equal(AUDITOR_LINE_PRESENT, "auditor : The transaction amount is encrypted, only the secured auditor key manager, you and the recipient can read it.");
  const block = formatConfidentialTransferAnnouncement({
    netBaseUnits: 1n,
    recipient: RECIPIENT,
    confidentialBeforeBaseUnits: 10n,
    split: splitTransferFee(2n, DEVNET),
    schedule: DEVNET,
    grossBaseUnits: 2n,
    zeroAuditorKey: false,
    pendingBaseUnits: undefined,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "file",
  });
  assert.equal(block.split("\n")[6], AUDITOR_LINE_PRESENT);
  assert.equal(block.split("\n").length, 9);
});

test("confidential-transfer: pending credits are stated as a tenth line and never applied", () => {
  const block = formatConfidentialTransferAnnouncement({
    netBaseUnits: 1_000_000n,
    recipient: RECIPIENT,
    confidentialBeforeBaseUnits: 10_000_000n,
    split: splitTransferFee(1_010_102n, DEVNET),
    schedule: DEVNET,
    grossBaseUnits: 1_010_102n,
    zeroAuditorKey: true,
    pendingBaseUnits: 250_000n,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "flag",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 10);
  assert.equal(lines[9], formatPendingCreditsNote(250_000n));
  assert.match(lines[9], /^note : 0\.250000 DDC of pending credits is not included in your confidential balance\./);
  assert.match(lines[9], /run ddc apply-pending to fold them in\.$/);
});

test("confidential-transfer: the abort, success and after-failed-send lines", () => {
  assert.equal(CONFIRM_ABORTED_BEFORE_SEND, "ABORTED " + EM + " the word CONFIRM was not typed. Nothing was sent and no fee was paid.");
  const msg = formatConfidentialTransferSuccess({ signature: TEST_SIGNATURE, netBaseUnits: 100_000_000n, recipient: RECIPIENT, confidentialAfterBaseUnits: 499_500_000n });
  assert.match(msg, /^TRANSFER CONFIRMED /);
  assert.match(msg, new RegExp(TEST_SIGNATURE));
  assert.match(msg, /100\.000000 DDC sent to /);
  assert.match(msg, /arrives in their pending balance/);
  assert.match(msg, /now reads 499\.500000 DDC\.$/);
  assert.match(CONFIDENTIAL_TRANSFER_AFTER_FAILED_SEND, /^The transaction is atomic: /);
  assert.match(CONFIDENTIAL_TRANSFER_AFTER_FAILED_SEND, /the recipient received nothing/);
  assert.match(CONFIDENTIAL_TRANSFER_AFTER_FAILED_SEND, /run ddc balance before retrying\.$/);
});

test("confidential-transfer: readMintConfidentialTransferKeys reads the auditor (None or Some) and the withheld-fee key off a decoded mint", () => {
  const withheldKey = address("2s6cdzqUUTwMpgddGp5j9SMqFAy5U5RPaRyhBaa8YAKM");
  const auditorKey = address("9m4ZX1kQ5cPrmNP6rB3rZQ3kSakDJdEQ5F4ZTMVTAHN1");
  const mintWith = (auditor: { __option: "None" } | { __option: "Some"; value: Address }) =>
    ({
      extensions: {
        __option: "Some",
        value: [
          { __kind: "ConfidentialTransferMint", authority: { __option: "None" }, autoApproveNewAccounts: true, auditorElgamalPubkey: auditor },
          { __kind: "ConfidentialTransferFee", authority: { __option: "None" }, elgamalPubkey: withheldKey, harvestToMintEnabled: true, withheldAmount: new Uint8Array(64) },
        ],
      },
    }) as unknown as Mint;
  const none = readMintConfidentialTransferKeys(mintWith({ __option: "None" }));
  assert.equal(none.auditorElgamalPubkey, undefined);
  assert.equal(none.withdrawWithheldAuthorityElgamalPubkey.length, 32);
  const some = readMintConfidentialTransferKeys(mintWith({ __option: "Some", value: auditorKey }));
  assert.ok(some.auditorElgamalPubkey);
  assert.equal(some.auditorElgamalPubkey.length, 32);
  assert.notDeepEqual(some.auditorElgamalPubkey, some.withdrawWithheldAuthorityElgamalPubkey);
  assert.throws(() => readMintConfidentialTransferKeys({ extensions: { __option: "None" } } as unknown as Mint), /no extensions/);
});

test("confidential-transfer: schedule parameter agreement and the after-miss evidence test", () => {
  const same = { epoch: 9999n, maximumFee: 1_000_000n, basisPoints: 100 };
  const rate = { ...DEVNET, basisPoints: 200 };
  const cap = { ...DEVNET, maximumFee: 2_000_000n };
  assert.equal(sameScheduleParameters(DEVNET, same), true);
  assert.equal(sameScheduleParameters(DEVNET, rate), false);
  assert.equal(sameScheduleParameters(DEVNET, cap), false);
  assert.equal(scheduleStillOnMint(DEVNET, { older: DEVNET, newer: same }), true);
  assert.equal(scheduleStillOnMint(DEVNET, { older: rate, newer: DEVNET }), true);
  assert.equal(scheduleStillOnMint(DEVNET, { older: rate, newer: cap }), false);
});
