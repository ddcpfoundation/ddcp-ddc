import { test } from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import type { AdminTxClaim } from "../tx/envelope.js";
import {
  assertNoStrayConfirmFlags,
  buildCountersignedClaim,
  checkBurnConfirmation,
  checkConfirmation,
  checkRotateSignerConfirmation,
  checkUpdateFeeConfirmation,
  countersignedOutPath,
  formatBurnCountersignDecode,
  formatCountersignDecode,
  formatRotateSignerCountersignDecode,
  formatUpdateFeeCountersignDecode,
  requireBurnConfirmFlags,
  requireRotateSignerConfirmFlags,
  requireUpdateFeeConfirmFlags,
} from "./admin-countersign.js";

// Offline: only the PURE helpers are tested here — the live command flow is
// proven by a real devnet run, not by mocking.
const DESTINATION = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
const SOURCE = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
const OTHER = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

test("checkConfirmation: exact amount + destination match passes", () => {
  const verdict = checkConfirmation(
    { amount: 1_000_000n, destination: DESTINATION },
    { amount: 1_000_000n, destination: DESTINATION },
  );
  assert.deepEqual(verdict, { ok: true });
});

test("checkConfirmation: amount mismatch refuses, naming both approved and actual", () => {
  const verdict = checkConfirmation(
    { amount: 2_000_000n, destination: DESTINATION },
    { amount: 1_000_000n, destination: DESTINATION },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /approved 1000000 base units/);
  assert.match(verdict.reason, /mints 2000000 base units/);
});

test("checkConfirmation: destination mismatch refuses, naming both approved and actual", () => {
  const verdict = checkConfirmation(
    { amount: 1_000_000n, destination: OTHER },
    { amount: 1_000_000n, destination: DESTINATION },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.ok(verdict.reason.includes(`approved 1000000 base units -> ${DESTINATION}`));
  assert.ok(verdict.reason.includes(`mints 1000000 base units -> ${OTHER}`));
});

test("stray-flag matrix: resume refuses every confirm flag; absent flags pass; mint and burn own flags pass", () => {
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "resume_issuance",
        "1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /resume_issuance has no confirm items — remove --confirm-amount\/--confirm-destination\/--confirm-source/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "resume_issuance",
        undefined,
        `${DESTINATION}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /resume_issuance has no confirm items/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "resume_issuance",
        undefined,
        undefined,
        `${SOURCE}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /resume_issuance has no confirm items/,
  );
  assert.doesNotThrow(() =>
    assertNoStrayConfirmFlags(
      "resume_issuance",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ),
  );
  assert.doesNotThrow(() =>
    assertNoStrayConfirmFlags(
      "mint_tokens",
      "1",
      `${DESTINATION}`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ),
  );
  assert.doesNotThrow(() =>
    assertNoStrayConfirmFlags(
      "burn_tokens",
      "1",
      undefined,
      `${SOURCE}`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ),
  );
});

test("stray-flag matrix: mint refuses --confirm-source; burn refuses --confirm-destination — each naming flag and instruction", () => {
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "mint_tokens",
        "1",
        undefined,
        `${SOURCE}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-source is not a mint_tokens confirm item — mint_tokens takes --confirm-amount and --confirm-destination/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "burn_tokens",
        "1",
        `${DESTINATION}`,
        `${SOURCE}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-destination is not a burn_tokens confirm item — burn_tokens takes --confirm-amount and --confirm-source/,
  );
});

test("stray-flag matrix: update_transfer_fee refuses --confirm-amount/--confirm-destination/--confirm-source, each named; its own fee flags pass", () => {
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "update_transfer_fee",
        "1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-amount is not an update_transfer_fee confirm item — update_transfer_fee takes --confirm-fee-bps, --confirm-max-fee, and --confirm-min-fee/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "update_transfer_fee",
        undefined,
        `${DESTINATION}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-destination is not an update_transfer_fee confirm item/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "update_transfer_fee",
        undefined,
        undefined,
        `${SOURCE}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-source is not an update_transfer_fee confirm item/,
  );
  assert.doesNotThrow(() =>
    assertNoStrayConfirmFlags(
      "update_transfer_fee",
      undefined,
      undefined,
      undefined,
      "250",
      "5000000",
      "1000",
      undefined,
      undefined,
    ),
  );
});

test("stray-flag matrix: mint, burn, and resume each refuse the fee flags, naming the flag and instruction", () => {
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "mint_tokens",
        "1",
        `${DESTINATION}`,
        undefined,
        "250",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-fee-bps is not a confirm item for mint_tokens — the fee flags belong to update_transfer_fee/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "burn_tokens",
        "1",
        undefined,
        `${SOURCE}`,
        undefined,
        "5000000",
        undefined,
        undefined,
        undefined,
      ),
    /--confirm-max-fee is not a confirm item for burn_tokens/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "resume_issuance",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "1000",
        undefined,
        undefined,
      ),
    /--confirm-min-fee is not a confirm item for resume_issuance/,
  );
});

test("requireBurnConfirmFlags: missing either flag refused; bad amount refused; bad address refused; good pair parses", () => {
  assert.throws(
    () => requireBurnConfirmFlags(undefined, `${SOURCE}`),
    /must confirm the amount and source you approve, via --confirm-amount <base-units> --confirm-source <address>/,
  );
  assert.throws(
    () => requireBurnConfirmFlags("250000", undefined),
    /must confirm the amount and source/,
  );
  assert.throws(
    () => requireBurnConfirmFlags("1.5", `${SOURCE}`),
    /--confirm-amount must be a non-negative integer/,
  );
  assert.throws(
    () => requireBurnConfirmFlags("250000", "not-an-address"),
    /--confirm-source "not-an-address" is not a valid address/,
  );
  const parsed = requireBurnConfirmFlags("250000", `${SOURCE}`);
  assert.equal(parsed.amount, 250_000n);
  assert.equal(parsed.source, SOURCE);
});

test("checkBurnConfirmation: exact amount + source match passes", () => {
  const verdict = checkBurnConfirmation(
    { amount: 250_000n, source: SOURCE },
    { amount: 250_000n, source: SOURCE },
  );
  assert.deepEqual(verdict, { ok: true });
});

test("checkBurnConfirmation: amount mismatch refuses, naming both approved and actual", () => {
  const verdict = checkBurnConfirmation(
    { amount: 2_000_000n, source: SOURCE },
    { amount: 250_000n, source: SOURCE },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /approved burning 250000 base units/);
  assert.match(verdict.reason, /burns 2000000 base units/);
});

test("checkBurnConfirmation: source mismatch refuses, naming both approved and actual (pairs with the 3b-1 structural-pass pin)", () => {
  const verdict = checkBurnConfirmation(
    { amount: 250_000n, source: OTHER },
    { amount: 250_000n, source: SOURCE },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.ok(verdict.reason.includes(`approved burning 250000 base units from ${SOURCE}`));
  assert.ok(verdict.reason.includes(`burns 250000 base units from ${OTHER}`));
});

test("formatBurnCountersignDecode: renders amount both ways, source, the CONFIRM MATCH line, matched authorities, and the output path", () => {
  const out = formatBurnCountersignDecode({
    amount: 250_000n,
    source: SOURCE,
    liveIssuer: ISSUER,
    liveReserve: RESERVE,
    nonceValue: NONCE_VALUE,
    outPath: "./admin-tx-burn-first-countersigned.json",
  });
  assert.ok(out.includes("250000 base units"));
  assert.ok(out.includes("= 0.250000 DDC"));
  assert.ok(out.includes(`source         : ${SOURCE}`));
  assert.ok(out.includes("CONFIRM MATCH"));
  assert.ok(out.includes(`burn 250000 base units from ${SOURCE}`));
  assert.ok(out.includes(`live issuer    : ${ISSUER} (matched`));
  assert.ok(out.includes(`live reserve : ${RESERVE} (matched`));
  assert.ok(out.includes(NONCE_VALUE));
  assert.ok(out.includes("./admin-tx-burn-first-countersigned.json"));
});

test("countersignedOutPath: .json suffix replaced; non-.json appended; directories preserved", () => {
  assert.equal(
    countersignedOutPath("admin-tx-mint-first.json"),
    "admin-tx-mint-first-countersigned.json",
  );
  assert.equal(countersignedOutPath("x"), "x-countersigned.json");
  assert.equal(countersignedOutPath("d/y.json"), "d/y-countersigned.json");
});

test("buildCountersignedClaim: signedBy gains the reserve address, awaiting becomes none, everything else preserved", () => {
  const original: AdminTxClaim = {
    amountDisplay: "1.000000 DDC",
    amount: "1000000",
    destination: DESTINATION,
    nonceAccount: "Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE",
    feePayer: ISSUER,
    initiatorRole: "issuer",
    signedBy: [ISSUER],
    awaitingSignature: "reserve",
  };
  const updated = buildCountersignedClaim(original, RESERVE);
  assert.deepEqual(updated.signedBy, [ISSUER, RESERVE]);
  assert.equal(updated.awaitingSignature, "none");
  assert.equal(updated.amountDisplay, original.amountDisplay);
  assert.equal(updated.amount, original.amount);
  assert.equal(updated.destination, original.destination);
  assert.equal(updated.nonceAccount, original.nonceAccount);
  assert.equal(updated.feePayer, original.feePayer);
  assert.equal(updated.initiatorRole, original.initiatorRole);
  // The original claim object is not mutated.
  assert.deepEqual(original.signedBy, [ISSUER]);
  assert.equal(original.awaitingSignature, "reserve");
});

test("formatCountersignDecode: renders amount both ways, the CONFIRM MATCH line, matched authorities, and the output path", () => {
  const out = formatCountersignDecode({
    amount: 1_000_000n,
    destination: DESTINATION,
    liveIssuer: ISSUER,
    liveReserve: RESERVE,
    nonceValue: NONCE_VALUE,
    outPath: "./admin-tx-mint-first-countersigned.json",
  });
  assert.ok(out.includes("1000000 base units"));
  assert.ok(out.includes("= 1.000000 DDC"));
  assert.ok(out.includes("CONFIRM MATCH"));
  assert.ok(out.includes(`destination    : ${DESTINATION}`));
  assert.ok(out.includes(`live issuer    : ${ISSUER} (matched`));
  assert.ok(out.includes(`live reserve : ${RESERVE} (matched`));
  assert.ok(out.includes(NONCE_VALUE));
  assert.ok(out.includes("./admin-tx-mint-first-countersigned.json"));
});

test("requireUpdateFeeConfirmFlags: all three required; bad bps/max/min refused; good triple parses", () => {
  assert.throws(
    () => requireUpdateFeeConfirmFlags(undefined, "5000000", "1000"),
    /must confirm the full fee triple you approve, via --confirm-fee-bps <bps> --confirm-max-fee <base-units> --confirm-min-fee <base-units>/,
  );
  assert.throws(
    () => requireUpdateFeeConfirmFlags("250", undefined, "1000"),
    /must confirm the full fee triple/,
  );
  assert.throws(
    () => requireUpdateFeeConfirmFlags("250", "5000000", undefined),
    /must confirm the full fee triple/,
  );
  assert.throws(
    () => requireUpdateFeeConfirmFlags("1.5", "5000000", "1000"),
    /--confirm-fee-bps must be a non-negative integer/,
  );
  assert.throws(
    () => requireUpdateFeeConfirmFlags("65536", "5000000", "1000"),
    /--confirm-fee-bps must fit u16 \(0\.\.65535\), got 65536/,
  );
  assert.throws(
    () => requireUpdateFeeConfirmFlags("250", "-1", "1000"),
    /--confirm-max-fee must be a non-negative integer/,
  );
  assert.throws(
    () => requireUpdateFeeConfirmFlags("250", "5000000", "x"),
    /--confirm-min-fee must be a non-negative integer/,
  );
  const parsed = requireUpdateFeeConfirmFlags("250", "5000000", "1000");
  assert.equal(parsed.newFeeBasisPoints, 250);
  assert.equal(parsed.newMaximumFee, 5_000_000n);
  assert.equal(parsed.newMinimumFee, 1_000n);
});

test("checkUpdateFeeConfirmation: exact triple match passes", () => {
  const verdict = checkUpdateFeeConfirmation(
    { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
    { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
  );
  assert.deepEqual(verdict, { ok: true });
});

test("checkUpdateFeeConfirmation: bps mismatch refuses, naming both approved and actual", () => {
  const verdict = checkUpdateFeeConfirmation(
    { newFeeBasisPoints: 300, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
    { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /approved fee 250 bps/);
  assert.match(verdict.reason, /sets fee 300 bps/);
});

test("checkUpdateFeeConfirmation: max mismatch refuses, naming both approved and actual", () => {
  const verdict = checkUpdateFeeConfirmation(
    { newFeeBasisPoints: 250, newMaximumFee: 9_000_000n, newMinimumFee: 1_000n },
    { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /approved fee 250 bps \/ max 5000000/);
  assert.match(verdict.reason, /sets fee 250 bps \/ max 9000000/);
});

test("checkUpdateFeeConfirmation: min mismatch refuses, naming both approved and actual", () => {
  const verdict = checkUpdateFeeConfirmation(
    { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 2_000n },
    { newFeeBasisPoints: 250, newMaximumFee: 5_000_000n, newMinimumFee: 1_000n },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /min 1000 base units/);
  assert.match(verdict.reason, /min 2000 base units/);
});

test("formatUpdateFeeCountersignDecode: renders the fee triple both ways, the CONFIRM MATCH line, operator/issuer labels, and the output path", () => {
  const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
  const out = formatUpdateFeeCountersignDecode({
    newFeeBasisPoints: 250,
    newMaximumFee: 5_000_000n,
    newMinimumFee: 1_000n,
    liveOperator: OPERATOR,
    liveIssuer: ISSUER,
    nonceValue: NONCE_VALUE,
    outPath: "./admin-tx-update-fee-first-countersigned.json",
  });
  assert.ok(out.includes("250 bps"));
  assert.ok(out.includes("maximum 5000000 base units = 5.000000 DDC"));
  assert.ok(out.includes("minimum 1000 base units = 0.001000 DDC"));
  assert.ok(out.includes("CONFIRM MATCH"));
  assert.ok(out.includes(`live operator  : ${OPERATOR} (matched: fee payer + operator slot)`));
  assert.ok(out.includes(`live issuer    : ${ISSUER} (countersigner`));
  assert.ok(out.includes(NONCE_VALUE));
  assert.ok(out.includes("./admin-tx-update-fee-first-countersigned.json"));
});

test("requireRotateSignerConfirmFlags: both flags mandatory (fail-closed footgun guard); bad role/address refused; good pair parses", () => {
  assert.throws(
    () => requireRotateSignerConfirmFlags(undefined, `${OTHER}`),
    /must confirm the rotation you approve, via --confirm-target-role <target-role> --confirm-new-signer <address>/,
  );
  assert.throws(
    () => requireRotateSignerConfirmFlags("2", undefined),
    /must confirm the rotation/,
  );
  assert.throws(
    () => requireRotateSignerConfirmFlags(undefined, undefined),
    /must confirm the rotation/,
  );
  assert.throws(
    () => requireRotateSignerConfirmFlags("-1", `${OTHER}`),
    /--confirm-target-role must be a non-negative integer/,
  );
  assert.throws(
    () => requireRotateSignerConfirmFlags("256", `${OTHER}`),
    /--confirm-target-role must fit u8 \(0\.\.255\), got 256/,
  );
  assert.throws(
    () => requireRotateSignerConfirmFlags("2", "not-an-address"),
    /--confirm-new-signer "not-an-address" is not a valid address/,
  );
  const parsed = requireRotateSignerConfirmFlags("2", `${OTHER}`);
  assert.equal(parsed.role, 2);
  assert.equal(parsed.newPubkey, OTHER);
});

test("checkRotateSignerConfirmation: exact role + new-signer match passes", () => {
  const verdict = checkRotateSignerConfirmation(
    { role: 0, newPubkey: OTHER },
    { role: 0, newPubkey: OTHER },
  );
  assert.deepEqual(verdict, { ok: true });
});

test("checkRotateSignerConfirmation: role mismatch refuses, naming both approved and actual", () => {
  const verdict = checkRotateSignerConfirmation(
    { role: 1, newPubkey: OTHER },
    { role: 0, newPubkey: OTHER },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /approved rotating role 0/);
  assert.match(verdict.reason, /rotates role 1/);
});

test("checkRotateSignerConfirmation: new-signer mismatch refuses, naming both approved and actual", () => {
  const verdict = checkRotateSignerConfirmation(
    { role: 0, newPubkey: DESTINATION },
    { role: 0, newPubkey: OTHER },
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.ok(verdict.reason.includes(`approved rotating role 0 -> ${OTHER}`));
  assert.ok(verdict.reason.includes(`rotates role 0 -> ${DESTINATION}`));
});

test("stray-flag matrix: rotate_signer refuses all six non-rotate flags, each named; its own flags pass; every other instruction refuses the rotate flags", () => {
  const nonRotate: Array<
    [string | undefined, string | undefined, string | undefined, string | undefined, string | undefined, string | undefined, RegExp]
  > = [
    ["1", undefined, undefined, undefined, undefined, undefined, /--confirm-amount is not a rotate_signer confirm item — rotate_signer takes --confirm-target-role and --confirm-new-signer/],
    [undefined, `${DESTINATION}`, undefined, undefined, undefined, undefined, /--confirm-destination is not a rotate_signer confirm item/],
    [undefined, undefined, `${SOURCE}`, undefined, undefined, undefined, /--confirm-source is not a rotate_signer confirm item/],
    [undefined, undefined, undefined, "250", undefined, undefined, /--confirm-fee-bps is not a rotate_signer confirm item/],
    [undefined, undefined, undefined, undefined, "5000000", undefined, /--confirm-max-fee is not a rotate_signer confirm item/],
    [undefined, undefined, undefined, undefined, undefined, "1000", /--confirm-min-fee is not a rotate_signer confirm item/],
  ];
  for (const [amt, dest, src, bps, max, min, re] of nonRotate) {
    assert.throws(
      () =>
        assertNoStrayConfirmFlags(
          "rotate_signer",
          amt,
          dest,
          src,
          bps,
          max,
          min,
          undefined,
          undefined,
        ),
      re,
    );
  }
  assert.doesNotThrow(() =>
    assertNoStrayConfirmFlags(
      "rotate_signer",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "2",
      `${OTHER}`,
    ),
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "mint_tokens",
        "1",
        `${DESTINATION}`,
        undefined,
        undefined,
        undefined,
        undefined,
        "2",
        undefined,
      ),
    /--confirm-target-role is not a confirm item for mint_tokens — the rotate flags belong to rotate_signer/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "burn_tokens",
        "1",
        undefined,
        `${SOURCE}`,
        undefined,
        undefined,
        undefined,
        undefined,
        `${OTHER}`,
      ),
    /--confirm-new-signer is not a confirm item for burn_tokens/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "update_transfer_fee",
        undefined,
        undefined,
        undefined,
        "250",
        "5000000",
        "1000",
        "2",
        undefined,
      ),
    /--confirm-target-role is not a confirm item for update_transfer_fee/,
  );
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "resume_issuance",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        `${OTHER}`,
      ),
    /--confirm-new-signer is not a confirm item for resume_issuance/,
  );
});

test("stray-flag matrix: an instruction outside the union reaches the never-typed default and throws naming it", () => {
  assert.throws(
    () =>
      assertNoStrayConfirmFlags(
        "publish_attestation" as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    /unhandled instruction "publish_attestation" in the stray-confirm matrix/,
  );
});

test("formatRotateSignerCountersignDecode: renders the rotation, the CONFIRM MATCH line, operator/reserve labels, and the output path", () => {
  const OPERATOR = address("CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe");
  const out = formatRotateSignerCountersignDecode({
    role: 0,
    newPubkey: OTHER,
    liveOperator: OPERATOR,
    liveReserve: RESERVE,
    nonceValue: NONCE_VALUE,
    outPath: "./admin-tx-rotate-first-countersigned.json",
  });
  assert.ok(out.includes(`target-role 0 (Issuer) -> new signer ${OTHER}`));
  assert.ok(out.includes("CONFIRM MATCH"));
  assert.ok(out.includes(`rotate role 0 -> ${OTHER}`));
  assert.ok(
    out.includes(`live operator  : ${OPERATOR} (matched: fee payer + operator slot)`),
  );
  assert.ok(out.includes(`live reserve : ${RESERVE} (countersigner`));
  assert.ok(out.includes(NONCE_VALUE));
  assert.ok(out.includes("./admin-tx-rotate-first-countersigned.json"));
});
