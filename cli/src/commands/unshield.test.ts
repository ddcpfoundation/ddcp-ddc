// Tests pinning the `ddc unshield` copy and its pure helpers.
// Per the suite convention nothing here calls runUnshield; its pre-identity
// refusal orderings are owed in entry-ordering.test.ts alongside the
// dispatcher registration, and the devnet run proves the send path.
//
// EVERY TEST NAME IS PREFIXED `unshield:` so it cannot collide with the
// unprefixed names in tx/unshield-tx.test.ts, on the shield.test.ts precedent.
//
// THE FEE LINE IS THE SHARED ONE, and its condition is costed from the
// artifact: the one transaction is assembled here, its filled
// signature slots counted, and the count must be exactly one — the bound the
// shared line states. A signature added to the transaction fails this test
// rather than letting a shipped sentence quietly become false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, type Signature } from "@solana/kit";
import { DDC_MINT } from "../constants.js";
import { NETWORK_FEE_LINE } from "../announcements.js";
import { CONFIRM_ABORTED_BEFORE_SEND, TYPED_CONFIRM_QUESTION } from "../confirm-prompt.js";
import { EQUALITY_PROOF_BYTES, RANGE_U64_PROOF_BYTES } from "../tx/unshield-proofs.js";
import { DECRYPTABLE_BALANCE_BYTES } from "../confidential-balance.js";
import type { BlockhashLifetime } from "../tx/confidential-setup-tx.js";
import { assembleUnshieldTransaction } from "../tx/unshield-tx.js";
import {
  UNSHIELD_AFTER_FAILED_SEND,
  UNSHIELD_OPERATION,
  UNSHIELD_UNAPPROVED_STOP,
  UNSHIELD_UNCONFIGURED_STOP,
  UNSHIELD_USAGE,
  formatBalanceMovedRefusal,
  formatInsufficientConfidentialRefusal,
  formatUnshieldAnnouncement,
  formatUnshieldHeader,
  formatUnshieldSuccess,
  parseUnshieldAmount,
} from "./unshield.js";

// TEST-ONLY cast, on the commands/apply-pending.test.ts precedent.
const TEST_SIGNATURE =
  "4EkGCTkVCJjMSFiPGkgcRDMTNjTQfsNBHYMkfjhBcbsnkQnvSNKmB4hTsXTNPWZDdRuLBFqCS8pR1aFwCFTQFbEt" as unknown as Signature;

test("unshield: parseUnshieldAmount accepts exactly one decimal positional and returns base units", () => {
  assert.equal(parseUnshieldAmount(["1.5"]), 1_500_000n);
  assert.equal(parseUnshieldAmount(["0.000001"]), 1n);
  assert.equal(parseUnshieldAmount(["281474976.710655"]), 281_474_976_710_655n);
});

test("unshield: a zero amount is a usage error naming the smallest amount, never a base-unit sentence", () => {
  for (const text of ["0", "0.0", "0.000000"]) {
    assert.throws(
      () => parseUnshieldAmount([text]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^unshield: usage — unshield <amount> --keypair <path> --rpc-url <url>\n/);
        assert.match(err.message, /the amount must be at least 0\.000001 DDC; got /);
        assert.doesNotMatch(err.message, /base unit/);
        return true;
      },
    );
  }
});

test("unshield: no positional, two positionals, and a malformed amount are usage errors carrying the amount grammar message", () => {
  assert.throws(() => parseUnshieldAmount([]), /unshield takes exactly one amount; got 0 positional arguments/);
  assert.throws(() => parseUnshieldAmount(["1", "2"]), /unshield takes exactly one amount; got 2 positional arguments/);
  assert.throws(() => parseUnshieldAmount(["1.2345678"]), /at most six decimal places/);
  assert.throws(() => parseUnshieldAmount(["abc"]), /not a valid DDC amount/);
  for (const bad of [[], ["1", "2"], ["abc"]]) {
    assert.throws(() => parseUnshieldAmount(bad), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.split("\n")[0], UNSHIELD_USAGE);
      return true;
    });
  }
});

test("unshield: the operation phrase names the one fee-paying transaction and never --broadcast", () => {
  assert.equal(UNSHIELD_OPERATION, "unshielding from your confidential balance (one signed, fee-paying transaction)");
  assert.doesNotMatch(UNSHIELD_OPERATION, /--broadcast/);
  assert.doesNotMatch(UNSHIELD_OPERATION, /five/);
});

test("unshield: the unactivated and unapproved stops both say nothing was sent, and name no flag", () => {
  assert.match(UNSHIELD_UNCONFIGURED_STOP, /^Nothing to unshield — /);
  assert.match(UNSHIELD_UNCONFIGURED_STOP, /No transaction was sent and no fee was paid\./);
  assert.match(UNSHIELD_UNCONFIGURED_STOP, /Run ddc setup-privacy to activate/);
  assert.doesNotMatch(UNSHIELD_UNCONFIGURED_STOP, /DDC setup-privacy/);
  assert.match(UNSHIELD_UNAPPROVED_STOP, /^REFUSED — this account is not approved for confidential transfers/);
  assert.match(UNSHIELD_UNAPPROVED_STOP, /Nothing was sent and no fee was paid\.$/);
  assert.doesNotMatch(UNSHIELD_UNAPPROVED_STOP, /--/);
});

test("unshield: the shared fee line's one-signature condition is costed from the assembled transaction", async () => {
  const signer = await generateKeyPairSigner();
  // Zero-filled buffers of the PINNED proof lengths: this test is about how many
  // signatures the transaction requires, not about proof content, and the
  // assembler gates the lengths. Real proofs are exercised in tx/unshield-tx.test.ts.
  const blockhash = {
    blockhash: "9m4ZX1kQ5cPrmNP6rB3rZQ3kSakDJdEQ5F4ZTMVTAHN1",
    lastValidBlockHeight: 0n,
  } as unknown as BlockhashLifetime;
  const { transaction } = await assembleUnshieldTransaction({
    signer,
    blockhash,
    mint: DDC_MINT,
    amountBaseUnits: 250_000n,
    newDecryptableAvailableBalance: new Uint8Array(DECRYPTABLE_BALANCE_BYTES),
    equalityProof: new Uint8Array(EQUALITY_PROOF_BYTES),
    rangeProof: new Uint8Array(RANGE_U64_PROOF_BYTES),
  });
  const signatures = (transaction as { signatures: Record<string, unknown> }).signatures;
  for (const [, value] of Object.entries(signatures)) assert.ok(value, "every signature slot must be filled");
  assert.deepEqual(Object.keys(signatures), [signer.address], "the transaction no longer costs exactly one signature");
  assert.equal(NETWORK_FEE_LINE, "network fee : less than 0.00002 SOL (base signature fee, paid by this wallet)");
});

test("unshield: the announcement is five lines in order, carrying the shared fee line and the cluster source, and asking nothing", () => {
  const block = formatUnshieldAnnouncement({
    amountBaseUnits: 250_000n,
    confidentialAfterBaseUnits: 750_000n,
    publicAfterBaseUnits: 1_250_000n,
    cluster: "https://api.devnet.solana.com",
    clusterSource: "flag",
  });
  const lines = block.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], formatUnshieldHeader(250_000n));
  assert.equal(lines[0], "UNSHIELD — moving 0.250000 DDC from your confidential balance into your public balance");
  assert.equal(lines[1], "● confidential after : 0.750000 DDC");
  assert.equal(lines[2], "○ public after : 1.250000 DDC");
  assert.equal(lines[3], NETWORK_FEE_LINE);
  assert.equal(lines[4], "cluster : https://api.devnet.solana.com (flag)");
  // A disclosure, not a question: the CONFIRM prompt asks, this does not.
  assert.doesNotMatch(block, /\?/);
  assert.doesNotMatch(block, /withdraw/i);
  assert.doesNotMatch(block, /rent/);
  assert.match(TYPED_CONFIRM_QUESTION, /^Type CONFIRM to send this transaction, /);
  assert.doesNotMatch(TYPED_CONFIRM_QUESTION, /five|these/);
});

test("unshield: the insufficiency refusal states both figures at fixed six places and the sent/fee clause", () => {
  const msg = formatInsufficientConfidentialRefusal({ amountBaseUnits: 700_000_000n, confidentialBaseUnits: 601_000_000n });
  assert.match(msg, /^REFUSED — 700\.000000 DDC is more than the 601\.000000 DDC your confidential balance reads\./);
  assert.match(msg, /Nothing was sent and no fee was paid\. Restate a smaller amount\.$/);
});

test("unshield: the balance-moved refusal says nothing was sent and names no rent, no cleanup and no result account", () => {
  const msg = formatBalanceMovedRefusal();
  assert.match(msg, /^REFUSED — your confidential balance changed while this command was running/);
  assert.match(msg, /Nothing was sent and no fee was paid\. Run ddc unshield again\.$/);
  assert.doesNotMatch(msg, /rent|cleanup|result account|withdraw/i);
  assert.doesNotMatch(msg, /DDC unshield/);
});

test("unshield: the abort copy says nothing was sent and no fee paid, and mentions no account", () => {
  assert.equal(
    CONFIRM_ABORTED_BEFORE_SEND,
    "ABORTED — the word CONFIRM was not typed. Nothing was sent and no fee was paid.",
  );
});

test("unshield: the success line carries the signature, the amount and both figures just read", () => {
  const msg = formatUnshieldSuccess({
    signature: TEST_SIGNATURE,
    amountBaseUnits: 250_000n,
    confidentialAfterBaseUnits: 750_000n,
    publicAfterBaseUnits: 1_250_000n,
  });
  assert.match(msg, /^UNSHIELD CONFIRMED — signature /);
  assert.match(msg, new RegExp(TEST_SIGNATURE));
  assert.match(msg, /0\.250000 DDC unshielded/);
  assert.match(msg, /now reads 0\.750000 DDC and your public balance 1\.250000 DDC\.$/);
});

test("unshield: the after-failed-send line claims atomicity and points at ddc balance before any retry, promising nothing else", () => {
  assert.match(UNSHIELD_AFTER_FAILED_SEND, /^The transaction is atomic: /);
  assert.match(UNSHIELD_AFTER_FAILED_SEND, /nothing moved between your balances/);
  assert.match(UNSHIELD_AFTER_FAILED_SEND, /run ddc balance before retrying\.$/);
  assert.doesNotMatch(UNSHIELD_AFTER_FAILED_SEND, /rent|recover|landed/i);
});
