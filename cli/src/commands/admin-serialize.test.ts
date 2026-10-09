import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getU16Decoder,
  getU64Decoder,
} from "@solana/kit";
import { assembleMintTokensTransaction } from "../tx/mint-tx.js";
import { assembleDurableNonceTransaction } from "../tx/durable-nonce-tx.js";
import { buildBurnTokensInstruction } from "../instructions/burn-tokens.js";
import { buildUpdateTransferFeeInstruction } from "../instructions/update-transfer-fee.js";
import { parseAdminTxEnvelope, serializeAdminTxEnvelope } from "../tx/envelope.js";
import { assertRoleAuthority } from "../role-guard.js";
import type { MintState } from "../mint-state.js";
import {
  baseUnitsToDdc,
  buildBurnClaim,
  buildUpdateFeeClaim,
  formatBurnSerializeDecode,
  formatSerializeDecode,
  formatUpdateFeeSerializeDecode,
} from "./admin-serialize.js";

// Offline: only the PURE formatters and helpers are tested here — the live
// command flow is proven by a real devnet run, not by mocking.
const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const DESTINATION = address("FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY");
const SOURCE = address("4EzV5Gj3j2UhvdNv9mmY9477mMdUsubRdb1Gu465gYeK");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const PDA5 = address("EcwNe3hodPbgUr4GVZn6Rp547c7vbdxSx6jw9aQfDfXU");
const PDA3 = address("48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu");
const RESERVE = address("Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NONCE_ACCOUNT = address("Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE");
const OPERATOR_NONCE = address("Sd4959ZK3E2hnyt9o2RHLVxe9NX4Z7Z2ZPcWjaNsnMf");
const NONCE_VALUE = "EzQUSBM46pwYjy49fMVa7hVn2k3nBhbNUSmW1h9a4qeq";

async function makeUpdateFeeAssembled() {
  const operator = await generateKeyPairSigner(); // initiator
  const issuer = await generateKeyPairSigner(); // countersigner
  const assembled = await assembleDurableNonceTransaction(
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
      nonceAccount: OPERATOR_NONCE,
      nonceAuthority: operator.address,
      nonceValue: NONCE_VALUE,
    },
    operator,
  );
  return { operator, issuer, assembled };
}

test("baseUnitsToDdc formats 1000000, 1, and 600000000 at 6 dp", () => {
  assert.equal(baseUnitsToDdc(1_000_000n), "1.000000");
  assert.equal(baseUnitsToDdc(1n), "0.000001");
  assert.equal(baseUnitsToDdc(600_000_000n), "600.000000");
});

test("formatSerializeDecode renders amounts, both instructions, signature status, and the six labeled accounts in order", async () => {
  const initiator = await generateKeyPairSigner();
  const assembled = await assembleMintTokensTransaction({
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
  const out = formatSerializeDecode({
    rpcUrl: "https://api.devnet.solana.com",
    mint: MINT,
    programId: address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp"),
    sources: { rpcUrl: "default", mint: "default", program: "default" },
    mintStatePda: MINT_STATE,
    role: "issuer",
    signerAddress: initiator.address,
    onChainIssuer: initiator.address,
    reserveAuthority: RESERVE,
    nonceAccount: NONCE_ACCOUNT,
    nonceValue: NONCE_VALUE,
    assembled,
    outPath: "./admin-tx-mint-test.json",
  });

  // Amount derived from the assembled bytes, shown both ways.
  assert.ok(out.includes("amount 1000000 base units"));
  assert.ok(out.includes("= 1.000000 DDC"));
  // Both instruction summaries.
  assert.ok(out.includes(`ix0 AdvanceNonceAccount: nonce account ${NONCE_ACCOUNT}`));
  assert.ok(out.includes("ix1 mint_tokens (discriminator 3b8418f67a2708f3)"));
  assert.ok(out.includes(`destination ${DESTINATION}`));
  // Signature status: issuer FILLED, reserve AWAITING.
  assert.match(out, new RegExp(`signature issuer ${initiator.address}: FILLED`));
  assert.match(out, new RegExp(`signature reserve ${RESERVE}: AWAITING`));
  // The six I-2 accounts, labeled, in order, with roles.
  assert.ok(out.includes(`  account 0 mint: ${MINT} (writable)`));
  assert.ok(out.includes(`  account 1 destination: ${DESTINATION} (writable)`));
  assert.ok(out.includes(`  account 2 PDA-1 MintState: ${MINT_STATE} (readonly)`));
  assert.ok(
    out.includes(
      `  account 3 issuer_authority: ${initiator.address} (readonly-signer)`,
    ),
  );
  assert.ok(out.includes(`  account 4 reserve_authority: ${RESERVE} (readonly-signer)`));
  assert.ok(
    out.includes(`  account 5 token_2022_program: ${TOKEN_2022} (readonly)`),
  );
  // Fee payer and envelope path.
  assert.ok(out.includes(`fee payer      : ${initiator.address}`));
  assert.ok(out.includes("envelope file  : ./admin-tx-mint-test.json"));
});

test("formatBurnSerializeDecode renders amount/source from the bytes and the seven labeled accounts in order", async () => {
  const initiator = await generateKeyPairSigner();
  const assembled = await assembleDurableNonceTransaction(
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
  const out = formatBurnSerializeDecode({
    rpcUrl: "https://api.devnet.solana.com",
    mint: MINT,
    programId: address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp"),
    sources: { rpcUrl: "default", mint: "default", program: "default" },
    mintStatePda: MINT_STATE,
    redemptionAuthorityPda: PDA5,
    role: "issuer",
    signerAddress: initiator.address,
    onChainIssuer: initiator.address,
    reserveAuthority: RESERVE,
    nonceAccount: NONCE_ACCOUNT,
    nonceValue: NONCE_VALUE,
    assembled,
    outPath: "./admin-tx-burn-test.json",
  });

  // Amount and source derived from the assembled bytes, shown both ways.
  assert.ok(out.includes("amount 250000 base units"));
  assert.ok(out.includes("= 0.250000 DDC"));
  assert.ok(out.includes(`from source ${SOURCE}`));
  // Both instruction summaries; PDA-5 display line.
  assert.ok(out.includes(`ix0 AdvanceNonceAccount: nonce account ${NONCE_ACCOUNT}`));
  assert.ok(out.includes("ix1 burn_tokens (discriminator 4c0f33fee5d77942)"));
  assert.ok(out.includes(`PDA-5 redeem   : ${PDA5}`));
  // Signature status: issuer FILLED, reserve AWAITING.
  assert.match(out, new RegExp(`signature issuer ${initiator.address}: FILLED`));
  assert.match(out, new RegExp(`signature reserve ${RESERVE}: AWAITING`));
  // The seven I-3 accounts, labeled, in order, with roles.
  assert.ok(out.includes(`  account 0 mint: ${MINT} (writable)`));
  assert.ok(out.includes(`  account 1 source: ${SOURCE} (writable)`));
  assert.ok(out.includes(`  account 2 PDA-1 MintState: ${MINT_STATE} (readonly)`));
  assert.ok(out.includes(`  account 3 PDA-5: ${PDA5} (readonly)`));
  assert.ok(
    out.includes(
      `  account 4 issuer_authority: ${initiator.address} (readonly-signer)`,
    ),
  );
  assert.ok(out.includes(`  account 5 reserve_authority: ${RESERVE} (readonly-signer)`));
  assert.ok(
    out.includes(`  account 6 token_2022_program: ${TOKEN_2022} (readonly)`),
  );
  // Fee payer and envelope path.
  assert.ok(out.includes(`fee payer      : ${initiator.address}`));
  assert.ok(out.includes("envelope file  : ./admin-tx-burn-test.json"));
});

test("buildBurnClaim: destination field carries the SOURCE (Decision 2), with the burn label and reserve awaited", () => {
  const claim = buildBurnClaim(250_000n, SOURCE, DESTINATION);
  assert.equal(claim.destination, SOURCE);
  assert.equal(claim.amountDisplay, `burn 0.250000 DDC from ${SOURCE}`);
  assert.equal(claim.amount, "250000");
  assert.equal(claim.feePayer, DESTINATION);
  assert.deepEqual(claim.signedBy, [DESTINATION]);
  assert.equal(claim.initiatorRole, "issuer");
  assert.equal(claim.awaitingSignature, "reserve");
});

test("update-fee assembly: Operator-initiated over the OPERATOR nonce — ix0 nonce account/authority, 26-byte ix1 decoding to the triple, operator fee payer", async () => {
  const { operator, assembled } = await makeUpdateFeeAssembled();
  const [ix0, ix1] = assembled.message.instructions;
  if (ix0 === undefined || ix1 === undefined) {
    assert.fail("assembled message must have both instructions");
  }
  // ix0 AdvanceNonceAccount over the OPERATOR nonce, operator as nonce authority.
  assert.equal(ix0.accounts?.[0]?.address, OPERATOR_NONCE);
  assert.equal(ix0.accounts?.[2]?.address, operator.address);
  // ix1: 26-byte data decoding back to the input fee triple.
  const ix1Data = ix1.data ?? new Uint8Array(0);
  assert.equal(ix1Data.length, 26);
  assert.equal(getU16Decoder().decode(ix1Data.subarray(8, 10)), 250);
  assert.equal(getU64Decoder().decode(ix1Data.subarray(10, 18)), 5_000_000n);
  assert.equal(getU64Decoder().decode(ix1Data.subarray(18, 26)), 1_000n);
  assert.equal(ix1.accounts?.length, 6);
  // Fee payer is the Operator initiator.
  assert.equal(assembled.message.feePayer.address, operator.address);
});

test("formatUpdateFeeSerializeDecode renders the fee triple from the bytes and the six labeled accounts in order", async () => {
  const { operator, issuer, assembled } = await makeUpdateFeeAssembled();
  const out = formatUpdateFeeSerializeDecode({
    rpcUrl: "https://api.devnet.solana.com",
    mint: MINT,
    programId: address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp"),
    sources: { rpcUrl: "default", mint: "default", program: "default" },
    mintStatePda: MINT_STATE,
    feeAuthorityPda: PDA3,
    role: "operator",
    signerAddress: operator.address,
    onChainOperator: operator.address,
    issuerAuthority: issuer.address,
    nonceAccount: OPERATOR_NONCE,
    nonceValue: NONCE_VALUE,
    assembled,
    outPath: "./admin-tx-update-fee-test.json",
  });

  // Fee triple derived from the assembled bytes, shown both ways.
  assert.ok(out.includes("fee 250 bps"));
  assert.ok(out.includes("maximum 5000000 base units = 5.000000 DDC"));
  assert.ok(out.includes("minimum 1000 base units = 0.001000 DDC"));
  // Both instruction summaries; PDA-3 display line.
  assert.ok(out.includes(`ix0 AdvanceNonceAccount: nonce account ${OPERATOR_NONCE}`));
  assert.ok(
    out.includes("ix1 update_transfer_fee (discriminator 876a394d5df7d29e)"),
  );
  assert.ok(out.includes(`PDA-3 fee_auth : ${PDA3}`));
  // Signature status: operator FILLED, issuer AWAITING.
  assert.match(out, new RegExp(`signature operator ${operator.address}: FILLED`));
  assert.match(out, new RegExp(`signature issuer ${issuer.address}: AWAITING`));
  // The six I-6 accounts, labeled, in order, with roles.
  assert.ok(out.includes(`  account 0 mint: ${MINT} (writable)`));
  assert.ok(out.includes(`  account 1 PDA-3 fee_authority: ${PDA3} (readonly)`));
  assert.ok(out.includes(`  account 2 PDA-1 MintState: ${MINT_STATE} (writable)`));
  assert.ok(
    out.includes(
      `  account 3 issuer_authority: ${issuer.address} (readonly-signer)`,
    ),
  );
  assert.ok(
    out.includes(
      `  account 4 operator_authority: ${operator.address} (readonly-signer)`,
    ),
  );
  assert.ok(
    out.includes(`  account 5 token_2022_program: ${TOKEN_2022} (readonly)`),
  );
  // Fee payer and envelope path.
  assert.ok(out.includes(`fee payer      : ${operator.address}`));
  assert.ok(out.includes("envelope file  : ./admin-tx-update-fee-test.json"));
});

test("update-fee envelope round-trips through parseAdminTxEnvelope with instruction update_transfer_fee", async () => {
  const { operator, assembled } = await makeUpdateFeeAssembled();
  const serialized = serializeAdminTxEnvelope(
    assembled.transaction,
    buildUpdateFeeClaim(250, 5_000_000n, 1_000n, operator.address),
    "update_transfer_fee",
  );
  const envelope = JSON.parse(serialized) as { instruction: string };
  assert.equal(envelope.instruction, "update_transfer_fee");
  const parsed = parseAdminTxEnvelope(serialized);
  const wire = Uint8Array.from(
    Buffer.from(getBase64EncodedWireTransaction(assembled.transaction), "base64"),
  );
  assert.deepEqual(parsed.transactionBytes, wire);
  assert.equal(parsed.claim.initiatorRole, "operator");
  assert.equal(parsed.claim.awaitingSignature, "issuer");
  assert.equal(parsed.claim.nonceAccount, OPERATOR_NONCE);
  assert.equal(parsed.claim.feePayer, operator.address);
  assert.deepEqual(parsed.claim.signedBy, [operator.address]);
  assert.equal(claimHasTriple(parsed.claim.amountDisplay), true);
});

function claimHasTriple(amountDisplay: string): boolean {
  return (
    amountDisplay.includes("250 bps") &&
    amountDisplay.includes("5.000000 DDC") &&
    amountDisplay.includes("0.001000 DDC")
  );
}

test("update-fee role guard: a non-operator signer is refused before signing (assertRoleAuthority operator)", async () => {
  const notOperator = await generateKeyPairSigner();
  const state: MintState = {
    pauseActive: false,
    issuer: DESTINATION,
    operator: SOURCE,
    reserve: RESERVE,
    minimumFee: 0n,
    feeCeilingBasisPoints: 100,
    feeCeilingBaseUnits: 1_000_000n,
    bump: 255,
  };
  assert.throws(
    () => assertRoleAuthority("operator", notOperator.address, state),
    (err: Error) =>
      err.message.includes('stated role "operator"') &&
      err.message.includes(notOperator.address) &&
      err.message.includes(SOURCE),
  );
});
