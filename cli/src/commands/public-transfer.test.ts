// Tests pinning the 'ddc public-transfer' copy and its pure helpers.
// Per the suite convention nothing here calls runPublicTransfer; its
// pre-identity refusal orderings live in entry-ordering.test.ts and the devnet
// run proves the send path.
//
// EVERY TEST NAME IS PREFIXED 'public-transfer:' so it cannot collide with the
// 'public-transfer-tx:' names in tx/ or the 'confidential-transfer:' names
// beside this file. The em dash is built by String.fromCharCode, as in the
// module, so no test depends on the character surviving transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { address, generateKeyPairSigner, some, type Signature } from "@solana/kit";
import {
  AccountState,
  extension,
  getTokenEncoder,
  getTransferCheckedWithFeeInstructionDataDecoder,
} from "@solana-program/token-2022";
import { formatFeeLine, NETWORK_FEE_LINE } from "../announcements.js";
import { formatNotAWalletRefusal } from "../transfer-refusals.js";
import { DDC_MINT } from "../constants.js";
import { grossForNetPublic } from "../tx/transfer-fee-gross.js";
import { TRANSFER_AMOUNT_MAX_BASE_UNITS, type TransferFeeSchedule } from "../tx/transfer-fee-split.js";
import { assemblePublicTransferTransaction } from "../tx/public-transfer-tx.js";
import type { BlockhashLifetime } from "../tx/confidential-setup-tx.js";
import { CONFIDENTIAL_TRANSFER_USAGE, parseTransferArgs } from "./confidential-transfer.js";
import {
  CREATE_FACT_LINE,
  formatFeeScheduleMovedDuringSend,
  formatInsufficientPublicRefusal,
  formatPublicTransferAnnouncement,
  formatPublicTransferHeader,
  formatPublicTransferSuccess,
  formatRecipientRefusesPublicRefusal,
  formatRentChargeLine,
  NEW_RECIPIENT_ACCOUNT_BYTES,
  parsePublicTransferArgs,
  PUBLIC_ALERT_LINE,
  PUBLIC_TRANSFER_AFTER_FAILED_SEND,
  PUBLIC_TRANSFER_OPERATION,
  PUBLIC_TRANSFER_USAGE,
} from "./public-transfer.js";

const EM = String.fromCharCode(0x2014);
const RECIPIENT = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
// The devnet PDA-1 of record: program-derived, so off-curve by construction.
const OFF_CURVE = "4z8svPXAiChauUJDFcB9DPL4srZpL78TGn8FGSLym1D8";
const DEVNET: TransferFeeSchedule = { epoch: 1157n, maximumFee: 1_000_000n, basisPoints: 100 };
// Devnet, measured at 182 bytes on an account this command created.
const RENT_OF_RECORD = 1_574_800n;
// TEST-ONLY casts, on the sibling precedents.
const TEST_SIGNATURE =
  "4EkGCTkVCJjMSFiPGkgcRDMTNjTQfsNBHYMkfjhBcbsnkQnvSNKmB4hTsXTNPWZDdRuLBFqCS8pR1aFwCFTQFbEt" as unknown as Signature;
const TEST_BLOCKHASH = {
  blockhash: "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa",
  lastValidBlockHeight: 0n,
} as unknown as BlockhashLifetime;

test("public-transfer: the args are a decimal amount and a wallet address, and usage errors carry this command's line and word, never the sibling's", () => {
  const parsed = parsePublicTransferArgs(["1.5", RECIPIENT]);
  assert.equal(parsed.netBaseUnits, 1_500_000n);
  assert.equal(parsed.recipient, RECIPIENT);
  assert.equal(PUBLIC_TRANSFER_USAGE, "public-transfer: usage " + EM + " public-transfer <amount> <recipient-wallet> --keypair <path> --rpc-url <url>");
  assert.throws(() => parsePublicTransferArgs(["0", RECIPIENT]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message.split("\n")[0], PUBLIC_TRANSFER_USAGE);
    assert.match(err.message, /the amount must be at least 0\.000001 DDC; got 0$/);
    assert.doesNotMatch(err.message, /confidential/);
    return true;
  });
  assert.throws(() => parsePublicTransferArgs(["1.5"]), /\npublic-transfer takes exactly one amount and one recipient wallet address; got 1 positional arguments$/);
  assert.equal(PUBLIC_TRANSFER_OPERATION, "transferring from your public balance (one signed, fee-paying transaction)");
  assert.doesNotMatch(PUBLIC_TRANSFER_OPERATION, /--broadcast/);
});

test("public-transfer: an off-curve recipient is refused by the text of record in BOTH transfer commands, and an on-curve one is not", () => {
  const expected =
    "REFUSED " + EM + " " + OFF_CURVE + " is not a wallet address. It may be a token account or a program address; this command sends only to a wallet. " +
    "Nothing was sent and no fee was paid. Ask the recipient for their correct wallet address.";
  assert.equal(formatNotAWalletRefusal(OFF_CURVE), expected);
  for (const parse of [parsePublicTransferArgs, parseTransferArgs]) {
    assert.throws(() => parse(["1.5", OFF_CURVE]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, expected);
      assert.doesNotMatch(err.message, /usage|--keypair/);
      return true;
    });
    assert.equal(parse(["1.5", RECIPIENT]).recipient, RECIPIENT);
  }
  // The sibling's usage line is untouched by the shared parser.
  assert.throws(() => parseTransferArgs(["0", RECIPIENT]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message.split("\n")[0], CONFIDENTIAL_TRANSFER_USAGE);
    return true;
  });
});

test("public-transfer: the three lines of record, and the rent rendered from lamports with no hedge", () => {
  assert.equal(CREATE_FACT_LINE, "This recipient has no DDC account. One will be created.");
  assert.equal(PUBLIC_ALERT_LINE, "THIS TRANSFER IS PUBLIC. The amount, your address and the recipient's address will be visible to anyone, permanently.");
  assert.equal(
    formatRentChargeLine(RENT_OF_RECORD),
    "You will pay the account's one-time rent, 0.0015748 SOL, on top of the network fee. The recipient receives the full amount.",
  );
  assert.doesNotMatch(formatRentChargeLine(RENT_OF_RECORD), /about/);
  assert.equal(NEW_RECIPIENT_ACCOUNT_BYTES, 182n);
  // DERIVED, not hand-counted: the installed package's own
  // encoder, given the two extensions the create path produces, must agree.
  const created = getTokenEncoder().encode({
    mint: RECIPIENT,
    owner: RECIPIENT,
    amount: 0n,
    delegate: null,
    state: AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    extensions: some([
      extension("ImmutableOwner", {}),
      extension("TransferFeeAmount", { withheldAmount: 0n }),
    ]),
  });
  assert.equal(BigInt(created.length), NEW_RECIPIENT_ACCOUNT_BYTES);
});

test("public-transfer: when an account will be created the announcement is eleven lines, closing creation, alert, charge in that order", () => {
  const gross = grossForNetPublic(100_000_000n, DEVNET);
  const block = formatPublicTransferAnnouncement({
    netBaseUnits: 100_000_000n,
    recipient: RECIPIENT,
    publicBeforeBaseUnits: 401_000_000n,
    feeBaseUnits: gross.amounts.feeAmount,
    schedule: DEVNET,
    grossBaseUnits: gross.grossBaseUnits,
    rentLamports: RENT_OF_RECORD,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "flag",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 11);
  assert.equal(lines[0], formatPublicTransferHeader({ netBaseUnits: 100_000_000n, recipient: RECIPIENT }));
  assert.equal(lines[0], "PUBLIC TRANSFER " + EM + " sending 100.000000 DDC from your public balance to " + RECIPIENT);
  assert.equal(lines[1], "public before : 401.000000 DDC");
  assert.equal(lines[2], "recipient receives : 100.000000 DDC");
  assert.equal(lines[3], formatFeeLine({ feeBaseUnits: 1_000_000n, schedule: DEVNET }));
  assert.equal(lines[4], "total debited : 101.000000 DDC (recipient receives + fee)");
  assert.equal(lines[5], "public after : 300.000000 DDC");
  assert.equal(lines[6], NETWORK_FEE_LINE);
  assert.equal(lines[7], "cluster : https://api.devnet.solana.com (flag)");
  assert.equal(lines[8], CREATE_FACT_LINE);
  assert.equal(lines[9], PUBLIC_ALERT_LINE);
  assert.equal(lines[10], formatRentChargeLine(RENT_OF_RECORD));
  assert.doesNotMatch(block, /\?/);
  assert.doesNotMatch(block, /TransferChecked|auditor|encrypted|confidential/i);
});

test("public-transfer: when the recipient's account exists the announcement is nine lines and the alert alone closes it", () => {
  const gross = grossForNetPublic(5_000_000n, DEVNET);
  const block = formatPublicTransferAnnouncement({
    netBaseUnits: 5_000_000n,
    recipient: RECIPIENT,
    publicBeforeBaseUnits: 10_000_000n,
    feeBaseUnits: gross.amounts.feeAmount,
    schedule: DEVNET,
    grossBaseUnits: gross.grossBaseUnits,
    rentLamports: undefined,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "file",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[8], PUBLIC_ALERT_LINE);
  assert.doesNotMatch(block, /rent|will be created/);
  assert.equal(lines[3], "fee : 0.050506 DDC (100 bps, cap 1.000000 DDC) withheld to the mint's fee ledger");
});

test("public-transfer: the fee shown and the fee sent are ONE value, above the confidential bound as well as below it", async () => {
  const signer = await generateKeyPairSigner();
  for (const net of [5_000_000n, TRANSFER_AMOUNT_MAX_BASE_UNITS + 1n]) {
    const gross = grossForNetPublic(net, DEVNET);
    const shown = formatFeeLine({ feeBaseUnits: gross.amounts.feeAmount, schedule: DEVNET });
    const { message } = await assemblePublicTransferTransaction({
      signer,
      mint: DDC_MINT,
      recipient: RECIPIENT,
      grossBaseUnits: gross.grossBaseUnits,
      feeBaseUnits: gross.amounts.feeAmount,
      blockhash: TEST_BLOCKHASH,
    });
    const data = (message.instructions as unknown as Array<{ data?: Uint8Array }>)[1]?.data;
    assert.ok(data);
    const sent = getTransferCheckedWithFeeInstructionDataDecoder().decode(data);
    assert.equal(sent.fee, gross.amounts.feeAmount);
    assert.equal(sent.amount, gross.grossBaseUnits);
    assert.equal(sent.amount - sent.fee, net);
    assert.ok(shown.startsWith("fee : " + (Number(sent.fee) / 1e6).toFixed(6) + " DDC "));
  }
});

test("public-transfer: the three refusals only this command prints, each saying nothing was sent, none naming unshield or a proof", () => {
  assert.equal(
    formatInsufficientPublicRefusal({ netBaseUnits: 700_000_000n, grossBaseUnits: 701_000_000n, publicBaseUnits: 401_000_000n }),
    "REFUSED " + EM + " sending 700.000000 DDC costs 701.000000 DDC with the fee, which is more than the 401.000000 DDC your public balance reads. " +
      "Nothing was sent and no fee was paid. Restate a smaller amount.",
  );
  assert.equal(
    formatRecipientRefusesPublicRefusal(RECIPIENT),
    "REFUSED " + EM + " " + RECIPIENT + " does not accept public transfers on its DDC account. " +
      "Nothing was sent and no fee was paid. If the recipient has Confidential Balances activated, use ddc confidential-transfer.",
  );
  const moved = formatFeeScheduleMovedDuringSend();
  assert.match(moved, /^REFUSED /);
  assert.match(moved, /Nothing was sent and no fee was paid\. Run ddc public-transfer again to quote the fee now in force\.$/);
  for (const msg of [formatInsufficientPublicRefusal({ netBaseUnits: 1n, grossBaseUnits: 2n, publicBaseUnits: 0n }), formatRecipientRefusesPublicRefusal(RECIPIENT), moved]) {
    assert.doesNotMatch(msg, /unshield|proof|proven/i);
  }
});

test("public-transfer: the success and after-failed-send lines", () => {
  const msg = formatPublicTransferSuccess({ signature: TEST_SIGNATURE, netBaseUnits: 100_000_000n, recipient: RECIPIENT, publicAfterBaseUnits: 300_000_000n });
  assert.match(msg, /^PUBLIC TRANSFER CONFIRMED /);
  assert.match(msg, new RegExp(TEST_SIGNATURE));
  assert.match(msg, /100\.000000 DDC sent to /);
  assert.match(msg, /your public balance now reads 300\.000000 DDC\.$/);
  assert.doesNotMatch(msg, /pending/);
  assert.equal(
    PUBLIC_TRANSFER_AFTER_FAILED_SEND,
    "The transaction is atomic: if the network reported an error, nothing moved, no account was created and no rent was paid. If no confirmation arrived, run ddc balance before retrying.",
  );
});
