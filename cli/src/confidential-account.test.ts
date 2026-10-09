// Tests for confidential-account reading. The readActivationState test and
// its account-building fixtures MOVED here unchanged from
// setup-privacy.test.ts when this module took over the activation read; the
// readConfidentialTransferAccount test is new with the twelve-field reader.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  lamports,
  some,
  type MaybeAccount,
  type MaybeEncodedAccount,
} from "@solana/kit";
import {
  decodeToken,
  getDecryptableBalanceEncoder,
  getEncryptedBalanceEncoder,
  getTokenEncoder,
  type Token,
} from "@solana-program/token-2022";
import {
  readActivationState,
  readConfidentialTransferAccount,
} from "./confidential-account.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const WALLET = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
const ATA = address("3q84mCciN6dXksJymBVHKJqmpZYSM3BTZVysWGGK1bdm");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const AN_ELGAMAL_PUBKEY = address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp");

/** Routes to decodeToken's maybe-account overload; a literal would narrow to the exists:true member. */
function decodeMaybe(encoded: MaybeEncodedAccount): MaybeAccount<Token> {
  return decodeToken(encoded);
}

/** A decoded token account built from the generated encoder, or an absent one. */
function tokenAccount(
  extensions: Parameters<ReturnType<typeof getTokenEncoder>["encode"]>[0]["extensions"] | "absent",
): MaybeAccount<Token> {
  if (extensions === "absent") {
    return decodeMaybe({ exists: false, address: ATA });
  }
  const data = getTokenEncoder().encode({
    mint: MINT,
    owner: WALLET,
    amount: 0n,
    delegate: null,
    state: 1,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    extensions,
  });
  return decodeMaybe({
    exists: true,
    address: ATA,
    data: new Uint8Array(data),
    executable: false,
    lamports: lamports(0n),
    programAddress: TOKEN_2022,
    space: BigInt(data.length),
  });
}

/** The extension-5 payload used by both tests below. */
function configuredExtension() {
  const zeroEncrypted = new Uint8Array(getEncryptedBalanceEncoder().fixedSize);
  const zeroDecryptable = new Uint8Array(getDecryptableBalanceEncoder().fixedSize);
  return {
    __kind: "ConfidentialTransferAccount",
    approved: true,
    elgamalPubkey: AN_ELGAMAL_PUBKEY,
    pendingBalanceLow: zeroEncrypted,
    pendingBalanceHigh: zeroEncrypted,
    availableBalance: zeroEncrypted,
    decryptableAvailableBalance: zeroDecryptable,
    allowConfidentialCredits: true,
    allowNonConfidentialCredits: true,
    pendingBalanceCreditCounter: 0n,
    maximumPendingBalanceCreditCounter: 65536n,
    expectedPendingBalanceCreditCounter: 0n,
    actualPendingBalanceCreditCounter: 0n,
  } as const;
}

test("readActivationState: absent, unconfigured (no extensions), and configured (extension 5 with its key)", () => {
  assert.deepEqual(readActivationState(tokenAccount("absent")), { kind: "absent" });
  assert.deepEqual(readActivationState(tokenAccount(null)), { kind: "unconfigured" });
  const configured = tokenAccount(some([configuredExtension()]));
  assert.deepEqual(readActivationState(configured), {
    kind: "configured",
    elgamalPubkey: AN_ELGAMAL_PUBKEY,
    approved: true,
  });
});

test("readConfidentialTransferAccount: undefined for absent and unconfigured; the full twelve-field member for configured", () => {
  assert.equal(readConfidentialTransferAccount(tokenAccount("absent")), undefined);
  assert.equal(readConfidentialTransferAccount(tokenAccount(null)), undefined);
  const member = readConfidentialTransferAccount(tokenAccount(some([configuredExtension()])));
  assert.ok(member !== undefined);
  assert.equal(member.__kind, "ConfidentialTransferAccount");
  assert.equal(member.approved, true);
  assert.equal(member.elgamalPubkey, AN_ELGAMAL_PUBKEY);
  assert.equal(member.pendingBalanceLow.length, 64);
  assert.equal(member.pendingBalanceHigh.length, 64);
  assert.equal(member.availableBalance.length, 64);
  assert.equal(member.decryptableAvailableBalance.length, 36);
  assert.equal(member.allowConfidentialCredits, true);
  assert.equal(member.allowNonConfidentialCredits, true);
  assert.equal(member.pendingBalanceCreditCounter, 0n);
  assert.equal(member.maximumPendingBalanceCreditCounter, 65536n);
  assert.equal(member.expectedPendingBalanceCreditCounter, 0n);
  assert.equal(member.actualPendingBalanceCreditCounter, 0n);
});
