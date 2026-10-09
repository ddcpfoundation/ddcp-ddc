// Offline dispatch tests: routing is by the WIRE ix1 discriminator only.
// Mint fixtures use mint's own assembleMintTokensTransaction; resume
// fixtures use the generic durable-nonce assembly. Both are exercised at
// the countersign stage with issuer-only wires (the stage semantics
// themselves are pinned in countersign-verify.test.ts / resume-verify.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Address,
  type Transaction,
} from "@solana/kit";
import { PROGRAM_ID } from "../constants.js";
import { assembleMintTokensTransaction } from "./mint-tx.js";
import { buildResumeIssuanceInstruction } from "../instructions/resume-issuance.js";
import { buildBurnTokensInstruction } from "../instructions/burn-tokens.js";
import { buildUpdateTransferFeeInstruction } from "../instructions/update-transfer-fee.js";
import { assembleDurableNonceTransaction } from "./durable-nonce-tx.js";
import type { SignerFrame } from "./admin-verify-core.js";
import {
  decodeAdminTxWire,
  type CountersignContext,
} from "./countersign-verify.js";
import { dispatchAdminVerify } from "./admin-verify-dispatch.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const SOURCE = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const PDA5 = address("EcwNe3hodPbgUr4GVZn6Rp547c7vbdxSx6jw9aQfDfXU");
const PDA3 = address("48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const OPERATOR_NONCE_ACCOUNT = address(
  "Sd4959ZK3E2hnyt9o2RHLVxe9NX4Z7Z2ZPcWjaNsnMf",
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

function wireOf(tx: Transaction): Uint8Array {
  return Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(tx), "base64"),
  );
}

async function makeMintDecoded() {
  const initiator = await generateKeyPairSigner();
  const { transaction } = await assembleMintTokensTransaction({
    mint: MINT,
    destination: DESTINATION,
    mintState: MINT_STATE,
    issuerAuthority: initiator.address,
    reserveAuthority: RESERVE,
    token2022Program: TOKEN_2022,
    amount: 1_000_000n,
    nonceAccount: NONCE_ACCOUNT,
    nonceAuthority: initiator.address,
    nonceValue: NONCE_VALUE,
    initiatorSigner: initiator,
  });
  return { initiator, decoded: decodeAdminTxWire(wireOf(transaction)) };
}

async function makeResumeDecoded() {
  const initiator = await generateKeyPairSigner();
  const { transaction } = await assembleDurableNonceTransaction(
    buildResumeIssuanceInstruction({
      mint: MINT,
      mintState: MINT_STATE,
      issuerAuthority: initiator.address,
      reserveAuthority: RESERVE,
    }),
    {
      nonceAccount: NONCE_ACCOUNT,
      nonceAuthority: initiator.address,
      nonceValue: NONCE_VALUE,
    },
    initiator,
  );
  return { initiator, decoded: decodeAdminTxWire(wireOf(transaction)) };
}

async function makeBurnDecoded() {
  const initiator = await generateKeyPairSigner();
  const { transaction } = await assembleDurableNonceTransaction(
    buildBurnTokensInstruction({
      mint: MINT,
      source: SOURCE,
      mintState: MINT_STATE,
      redemptionAuthority: PDA5,
      issuerAuthority: initiator.address,
      reserveAuthority: RESERVE,
      token2022Program: TOKEN_2022,
      amount: 250_000n,
    }),
    {
      nonceAccount: NONCE_ACCOUNT,
      nonceAuthority: initiator.address,
      nonceValue: NONCE_VALUE,
    },
    initiator,
  );
  return { initiator, decoded: decodeAdminTxWire(wireOf(transaction)) };
}

async function makeUpdateFeeDecoded() {
  const operator = await generateKeyPairSigner(); // initiator
  const issuer = await generateKeyPairSigner(); // countersigner
  const { transaction } = await assembleDurableNonceTransaction(
    buildUpdateTransferFeeInstruction({
      mint: MINT,
      feeAuthority: PDA3,
      mintState: MINT_STATE,
      issuerAuthority: issuer.address,
      operatorAuthority: operator.address,
      token2022Program: TOKEN_2022,
      newFeeBasisPoints: 250,
      newMaximumFee: 5_000_000n,
      newMinimumFee: 1_000n,
    }),
    {
      nonceAccount: OPERATOR_NONCE_ACCOUNT,
      nonceAuthority: operator.address,
      nonceValue: NONCE_VALUE,
    },
    operator,
  );
  const operatorFrame: SignerFrame = {
    initiator: operator.address,
    initiatorLabel: "Operator",
    countersigner: issuer.address,
    countersignerLabel: "issuer",
    nonceAccount: OPERATOR_NONCE_ACCOUNT,
  };
  return {
    operator,
    issuer,
    operatorFrame,
    decoded: decodeAdminTxWire(wireOf(transaction)),
  };
}

function ctxFor(
  liveIssuer: Address,
  overrides: Partial<CountersignContext> = {},
): CountersignContext {
  return {
    liveIssuer,
    liveReserve: RESERVE,
    liveNonceValue: NONCE_VALUE,
    issuerNonceAccount: NONCE_ACCOUNT,
    mint: MINT,
    mintStatePda: MINT_STATE,
    token2022Program: TOKEN_2022,
    programId: PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM,
    ...overrides,
  };
}

test("dispatch: a mint wire routes to the mint verdict with amount and destination", async () => {
  const { initiator, decoded } = await makeMintDecoded();
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(initiator.address),
    "countersign",
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("verdict must be ok");
  assert.equal(verdict.instruction, "mint_tokens");
  if (verdict.instruction !== "mint_tokens") assert.fail("must be mint");
  assert.equal(verdict.amount, 1_000_000n);
  assert.equal(verdict.destination, DESTINATION);
});

test("dispatch: a resume wire routes to the resume verdict with no confirm items", async () => {
  const { initiator, decoded } = await makeResumeDecoded();
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(initiator.address),
    "countersign",
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("verdict must be ok");
  assert.equal(verdict.instruction, "resume_issuance");
  assert.equal("amount" in verdict, false);
  assert.equal("destination" in verdict, false);
});

test("dispatch: a burn wire routes to the burn verdict with amount and source", async () => {
  const { initiator, decoded } = await makeBurnDecoded();
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(initiator.address),
    "countersign",
    PDA5,
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("verdict must be ok");
  assert.equal(verdict.instruction, "burn_tokens");
  if (verdict.instruction !== "burn_tokens") assert.fail("must be burn");
  assert.equal(verdict.amount, 250_000n);
  assert.equal(verdict.source, SOURCE);
});

test("dispatch: a burn wire without the live-derived PDA-5 is refused fail-closed", async () => {
  const { initiator, decoded } = await makeBurnDecoded();
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(initiator.address),
    "countersign",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /PDA-5/);
});

test("dispatch: an update-fee wire without updateFeeDeps is refused fail-closed naming the missing deps", async () => {
  const { issuer, decoded } = await makeUpdateFeeDecoded();
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(issuer.address),
    "countersign",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /PDA-3/);
  assert.match(verdict.reason, /updateFeeDeps/);
});

test("dispatch: an update-fee wire with updateFeeDeps routes to update_transfer_fee with the extracted triple", async () => {
  const { issuer, operatorFrame, decoded } = await makeUpdateFeeDecoded();
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(issuer.address),
    "countersign",
    undefined,
    { feeAuthority: PDA3, operatorFrame },
  );
  assert.equal(verdict.ok, true);
  if (!verdict.ok) assert.fail("verdict must be ok");
  assert.equal(verdict.instruction, "update_transfer_fee");
  if (verdict.instruction !== "update_transfer_fee") {
    assert.fail("must be update_transfer_fee");
  }
  assert.equal(verdict.newFeeBasisPoints, 250);
  assert.equal(verdict.newMaximumFee, 5_000_000n);
  assert.equal(verdict.newMinimumFee, 1_000n);
});

test("dispatch: an unknown ix1 discriminator is refused naming the hex", async () => {
  const { initiator, decoded } = await makeMintDecoded();
  const ix1 = decoded.instructions[1];
  if (ix1 === undefined) assert.fail("decoded tx has no instruction 1");
  ix1.data[0] = (ix1.data[0] ?? 0) ^ 0xff;
  const verdict = dispatchAdminVerify(
    decoded,
    ctxFor(initiator.address),
    "countersign",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.match(verdict.reason, /unrecognized admin instruction discriminator/);
});

test("dispatch: a tx with no instruction 1 is refused", async () => {
  const { initiator, decoded } = await makeMintDecoded();
  const ix0 = decoded.instructions[0];
  if (ix0 === undefined) assert.fail("decoded tx has no instruction 0");
  const tampered = { ...decoded, instructions: [ix0] };
  const verdict = dispatchAdminVerify(
    tampered,
    ctxFor(initiator.address),
    "countersign",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) assert.fail("must refuse");
  assert.equal(verdict.reason, "admin tx has no instruction 1");
});
