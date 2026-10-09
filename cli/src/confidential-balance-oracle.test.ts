// ORACLE (test-only) — three assertions, all over one synthetic decoded
// account. Assertion (b): this build's balance figures against upstream's own
// `decryptConfidentialTransferBalance`. Assertions (a-i) and (a-ii), against
// upstream's `getApplyConfidentialPendingBalanceInstructionFromToken`: (a-i)
// the counter it emits is the account's `pendingBalanceCreditCounter` — a
// SPECIFICATION CAPTURE of the counter trap, the wire field being named after a
// DIFFERENT field the extension also carries — and (a-ii) its ciphertext,
// decrypted, equals this build's shipped figures summed, a genuine
// two-implementation comparison because both sides ship. The byte-equality form
// of assertion (a) was DROPPED as evidence-free: that helper encrypts
// internally, so it returns different bytes on every call, and its
// non-ciphertext bytes agree by construction.
//
// BUNDLER CONFINEMENT: upstream's `/confidential` subpath requires zk-sdk
// BUNDLER-entry key objects, so this file — and ONLY this file and the
// plan-shape oracle — imports `@solana/zk-sdk/bundler`. The bundler and node
// entries are two INDEPENDENT WebAssembly instances: nothing crosses between
// them here except EXTRACTED BYTES (the secret key, the AES key, the
// ciphertexts), and our side reconstructs from bytes on the production /node
// entry exactly as the CLI does. One Node ExperimentalWarning per worker that
// loads the bundler entry is expected and is not a regression.
//
// ONE DIVERGENCE IS DELIBERATE, AND NO FIXTURE HERE REACHES IT. Upstream reads
// a pending balance by decrypting each limb alone, so a lo limb left NEGATIVE
// by a fee-bearing credit throws there while this build reads it through the
// signed path of confidential-balance.ts. Both fixtures below build their
// limbs non-negative, which is where the two implementations agree and where
// assertion (b) keeps asserting so; where upstream cannot read at all there is
// nothing to compare.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  getAddressDecoder,
  lamports,
  some,
  type MaybeAccount,
  type MaybeEncodedAccount,
} from "@solana/kit";
import {
  decodeToken,
  getApplyConfidentialPendingBalanceInstructionDataDecoder,
  getTokenEncoder,
  type Token,
} from "@solana-program/token-2022";
import {
  decryptConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
} from "@solana-program/token-2022/confidential";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/bundler";
import {
  decryptDecryptableBalance,
  decryptPendingBalance,
} from "./confidential-balance.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const WALLET = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
const ATA = address("3q84mCciN6dXksJymBVHKJqmpZYSM3BTZVysWGGK1bdm");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function decodeMaybe(encoded: MaybeEncodedAccount): MaybeAccount<Token> {
  return decodeToken(encoded);
}

test("balance oracle (b): our decrypt figures equal upstream's decryptConfidentialTransferBalance over the same account and keys", () => {
  // Keys and ciphertexts are BUILT in the bundler instance, because upstream
  // consumes the key OBJECTS; our side receives only their bytes.
  const kp = new ElGamalKeypair();
  const ae = new AeKey();
  const elgamalSecretBytes = new Uint8Array(kp.secret().toBytes());
  const aeKeyBytes = new Uint8Array(ae.toBytes());
  const elgamalPubkey = getAddressDecoder().decode(
    new Uint8Array(kp.pubkey().toBytes()),
  );
  // pending total 70,000 = lo 4,464 + (hi 1 << 16); available (AES copy) 1,500,000.
  const pendingLo = new Uint8Array(kp.pubkey().encryptU64(4_464n).toBytes());
  const pendingHi = new Uint8Array(kp.pubkey().encryptU64(1n).toBytes());
  const decryptable = new Uint8Array(ae.encrypt(1_500_000n).toBytes());

  const data = getTokenEncoder().encode({
    mint: MINT,
    owner: WALLET,
    amount: 0n,
    delegate: null,
    state: 1,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    extensions: some([
      {
        __kind: "ConfidentialTransferAccount",
        approved: true,
        elgamalPubkey,
        pendingBalanceLow: pendingLo,
        pendingBalanceHigh: pendingHi,
        availableBalance: new Uint8Array(64),
        decryptableAvailableBalance: decryptable,
        allowConfidentialCredits: true,
        allowNonConfidentialCredits: true,
        pendingBalanceCreditCounter: 2n,
        maximumPendingBalanceCreditCounter: 65536n,
        expectedPendingBalanceCreditCounter: 1n,
        actualPendingBalanceCreditCounter: 1n,
      },
    ]),
  });
  const account = decodeMaybe({
    exists: true,
    address: ATA,
    data: new Uint8Array(data),
    executable: false,
    lamports: lamports(0n),
    programAddress: TOKEN_2022,
    space: BigInt(data.length),
  });
  assert.ok(account.exists);

  const upstream = decryptConfidentialTransferBalance({
    tokenAccount: account.data,
    elgamalSecretKey: kp.secret(),
    aesKey: ae,
  });

  const ourAvailable = decryptDecryptableBalance(aeKeyBytes, decryptable);
  const ourPending = decryptPendingBalance(elgamalSecretBytes, pendingLo, pendingHi);
  assert.ok(ourAvailable.readable);
  assert.ok(ourPending.readable);

  assert.equal(ourAvailable.baseUnits, 1_500_000n);
  assert.equal(ourPending.baseUnits, 70_000n);
  assert.equal(upstream.availableBalance, ourAvailable.baseUnits);
  assert.equal(upstream.pendingBalance, ourPending.baseUnits);
  assert.equal(upstream.totalBalance, 1_570_000n);
  assert.equal(upstream.pendingBalanceCreditCounter, 2n);
  assert.equal(upstream.maximumPendingBalanceCreditCounter, 65536n);
  assert.equal(upstream.expectedPendingBalanceCreditCounter, 1n);
  assert.equal(upstream.actualPendingBalanceCreditCounter, 1n);
});

/**
 * One synthetic configured account and upstream's emitted apply instruction
 * over it, built fresh per calling test: keys in the bundler instance because
 * the helper consumes key OBJECTS; only extracted bytes cross to /node, where
 * the shipped decrypt helpers reconstruct exactly as the CLI does. The
 * fixture's two counter fields deliberately DIFFER — pending 2, expected 1 —
 * so assertion (a-i) can discriminate which one upstream sends.
 */
function buildApplyEmission() {
  const kp = new ElGamalKeypair();
  const ae = new AeKey();
  const elgamalSecretBytes = new Uint8Array(kp.secret().toBytes());
  const aeKeyBytes = new Uint8Array(ae.toBytes());
  const elgamalPubkey = getAddressDecoder().decode(
    new Uint8Array(kp.pubkey().toBytes()),
  );
  const pendingLo = new Uint8Array(kp.pubkey().encryptU64(4_464n).toBytes());
  const pendingHi = new Uint8Array(kp.pubkey().encryptU64(1n).toBytes());
  const decryptable = new Uint8Array(ae.encrypt(1_500_000n).toBytes());
  const data = getTokenEncoder().encode({
    mint: MINT,
    owner: WALLET,
    amount: 0n,
    delegate: null,
    state: 1,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    extensions: some([
      {
        __kind: "ConfidentialTransferAccount",
        approved: true,
        elgamalPubkey,
        pendingBalanceLow: pendingLo,
        pendingBalanceHigh: pendingHi,
        availableBalance: new Uint8Array(64),
        decryptableAvailableBalance: decryptable,
        allowConfidentialCredits: true,
        allowNonConfidentialCredits: true,
        pendingBalanceCreditCounter: 2n,
        maximumPendingBalanceCreditCounter: 65536n,
        expectedPendingBalanceCreditCounter: 1n,
        actualPendingBalanceCreditCounter: 1n,
      },
    ]),
  });
  const account = decodeMaybe({
    exists: true,
    address: ATA,
    data: new Uint8Array(data),
    executable: false,
    lamports: lamports(0n),
    programAddress: TOKEN_2022,
    space: BigInt(data.length),
  });
  if (!account.exists) {
    throw new Error("the synthetic account must decode as existing");
  }
  const instruction = getApplyConfidentialPendingBalanceInstructionFromToken({
    token: ATA,
    tokenAccount: account.data,
    authority: WALLET,
    elgamalSecretKey: kp.secret(),
    aesKey: ae,
  });
  if (instruction.data === undefined) {
    throw new Error("upstream's helper emitted an instruction with no data");
  }
  const decoded = getApplyConfidentialPendingBalanceInstructionDataDecoder().decode(
    instruction.data,
  );
  return { decoded, aeKeyBytes, elgamalSecretBytes, pendingLo, pendingHi, decryptable };
}

test("apply oracle (a-i): upstream's FromToken helper emits the account's pendingBalanceCreditCounter, not the expected field the wire name is taken from", () => {
  const { decoded } = buildApplyEmission();
  // The two discriminators are the PROGRAM-source pins 27 and 8, asserted so a
  // wrong or drifted emission cannot be misread as an apply instruction whose
  // counter field then decodes from garbage.
  assert.equal(decoded.discriminator, 27);
  assert.equal(decoded.confidentialTransferDiscriminator, 8);
  // The fixture's expected field is 1n; equality with 2n is what discriminates.
  // If this fails at an upstream version bump, upstream changed WHICH counter
  // it sends — a finding to escalate, never a number
  // to update.
  assert.equal(decoded.expectedPendingBalanceCreditCounter, 2n);
});

test("apply oracle (a-ii): upstream's emitted ciphertext, decrypted, equals this build's shipped available-plus-pending over the same account", () => {
  const { decoded, aeKeyBytes, elgamalSecretBytes, pendingLo, pendingHi, decryptable } =
    buildApplyEmission();
  const upstreamCopy = decryptDecryptableBalance(
    aeKeyBytes,
    new Uint8Array(decoded.newDecryptableAvailableBalance),
  );
  const ourAvailable = decryptDecryptableBalance(aeKeyBytes, decryptable);
  const ourPending = decryptPendingBalance(elgamalSecretBytes, pendingLo, pendingHi);
  assert.ok(upstreamCopy.readable);
  assert.ok(ourAvailable.readable);
  assert.ok(ourPending.readable);
  assert.equal(upstreamCopy.baseUnits, ourAvailable.baseUnits + ourPending.baseUnits);
  // The literal figure pins the agreement to a known value, so a coordinated
  // wrong-on-both-sides result cannot pass as agreement.
  assert.equal(upstreamCopy.baseUnits, 1_570_000n);
});
