// The holder library's operations, run in-process against a stand-in
// endpoint: the reference mint's frozen bytes, PDA-1, PDA-2, ProgramData, the
// version-1 format feature, and token accounts whose confidential figures are
// real ciphertexts under the keys a test wallet derives. Nothing reaches a
// cluster. `submit` is a spy: a refusal before the send is proven by its
// never being called.
//
// THE SEND-TIME CHECK, per operation: shield and apply-pending refuse when the
// pending counter or the available balance moved between prepare and send;
// unshield and confidential-transfer refuse when the available balance moved,
// and send when only a credit arrived. Removing the check from any of the four
// fails a test here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  some,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { findAssociatedTokenPda, getTokenEncoder } from "@solana-program/token-2022";
import { AeKey, ElGamalKeypair, ElGamalPubkey } from "@solana/zk-sdk/node";
import type { SolanaRpc } from "../rpc.js";
import { deriveConfidentialKeys, type DerivedConfidentialKeys } from "../confidential-keys.js";
import { deriveAttestationPda, deriveMintStatePda } from "../pda.js";
import { deriveProgramDataAddress } from "../program-upgrade-authority.js";
import { decodeMintTransferFeeConfig } from "../mint-transfer-fee.js";
import { TOKEN_2022_PROGRAM } from "../program-addresses.js";
import {
  HolderRefusal,
  activateConfidentialBalances,
  checkActivation,
  prepareApplyPending,
  prepareConfidentialTransfer,
  preparePublicTransfer,
  prepareShield,
  prepareUnshield,
  readHolderBalance,
  readMintOverview,
  sendApplyPending,
  sendConfidentialTransfer,
  sendShield,
  sendUnshield,
  type HolderRefusalReason,
  type HolderSigner,
} from "./index.js";

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const PROGRAM = address("Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp");
const TXV1 = address("txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL");
const FEATURE = address("Feature111111111111111111111111111111111111");
const BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" as Signature;
const SLOT = 900_000n;

const MINT_BYTES = Uint8Array.from(
  Buffer.from(readFileSync(new URL("../../../test-fixtures/mint-devnet.b64", import.meta.url), "utf8").trim(), "base64"),
);
const FEES = decodeMintTransferFeeConfig(MINT_BYTES);
const EPOCH = (FEES.newer.epoch > FEES.older.epoch ? FEES.newer.epoch : FEES.older.epoch) + 5n;

interface Party {
  signer: KeyPairSigner;
  keys: DerivedConfidentialKeys;
  ata: Address;
}
async function party(): Promise<Party> {
  const signer = await generateKeyPairSigner();
  const keys = await deriveConfidentialKeys({ signer });
  const [ata] = await findAssociatedTokenPda({ owner: signer.address, tokenProgram: TOKEN_2022_PROGRAM, mint: MINT });
  return { signer, keys, ata };
}
const holder = await party();
const recipient = await party();
const strangerKey = new Uint8Array(new ElGamalKeypair().pubkey().toBytes());

interface Conf {
  available: bigint;
  copy?: bigint;
  pending?: bigint;
  counter?: bigint;
  expected?: bigint;
  actual?: bigint;
  approved?: boolean;
  pubkey?: Uint8Array;
  allowConfidential?: boolean;
  allowPublic?: boolean;
}

function tokenAccount(p: Party, amount: bigint, conf?: Conf): { owner: Address; data: Uint8Array } {
  const pub = conf?.pubkey ?? p.keys.elgamalPublicKey;
  const encrypt = (n: bigint) => new Uint8Array(ElGamalPubkey.fromBytes(pub).encryptU64(n).toBytes());
  const extensions = conf
    ? some([
        {
          __kind: "ConfidentialTransferAccount" as const,
          approved: conf.approved ?? true,
          elgamalPubkey: getAddressDecoder().decode(pub),
          pendingBalanceLow: encrypt((conf.pending ?? 0n) & 0xffffn),
          pendingBalanceHigh: encrypt((conf.pending ?? 0n) >> 16n),
          availableBalance: encrypt(conf.available),
          decryptableAvailableBalance: new Uint8Array(AeKey.fromBytes(p.keys.aeKey).encrypt(conf.copy ?? conf.available).toBytes()),
          allowConfidentialCredits: conf.allowConfidential ?? true,
          allowNonConfidentialCredits: conf.allowPublic ?? true,
          pendingBalanceCreditCounter: conf.counter ?? 0n,
          maximumPendingBalanceCreditCounter: 65536n,
          expectedPendingBalanceCreditCounter: conf.expected ?? 0n,
          actualPendingBalanceCreditCounter: conf.actual ?? 0n,
        },
      ])
    : null;
  const data = new Uint8Array(
    getTokenEncoder().encode({
      mint: MINT,
      owner: p.signer.address,
      amount,
      delegate: null,
      state: 1,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
      extensions,
    }),
  );
  return { owner: TOKEN_2022_PROGRAM, data };
}

/** Keep the available-balance ciphertext of `from` in `to`: the same balance, re-read with other fields changed. */
function withAvailableOf(to: { owner: Address; data: Uint8Array }, from: { data: Uint8Array }) {
  const at = (data: Uint8Array) => {
    let o = 166;
    while (o + 4 <= data.length) {
      const type = (data[o] as number) | ((data[o + 1] as number) << 8);
      const length = (data[o + 2] as number) | ((data[o + 3] as number) << 8);
      if (type === 5) return o + 4 + 1 + 32 + 64 + 64;
      o += 4 + length;
    }
    throw new Error("no ConfidentialTransferAccount");
  };
  const data = new Uint8Array(to.data);
  data.set(from.data.subarray(at(from.data), at(from.data) + 64), at(data));
  return { owner: to.owner, data };
}

function mintState(minimumFee = 0n): Uint8Array {
  const d = new Uint8Array(178);
  d.set(createHash("sha256").update("account:MintState").digest().subarray(0, 8), 0);
  d.set(getAddressEncoder().encode(holder.signer.address), 9);
  d.set(getAddressEncoder().encode(recipient.signer.address), 41);
  d.set(getAddressEncoder().encode(PROGRAM), 73);
  const v = new DataView(d.buffer);
  v.setBigUint64(105, minimumFee, true);
  v.setUint16(113, 100, true);
  v.setBigUint64(115, 1_000_000n, true);
  d[177] = 254;
  return d;
}

type World = Map<string, { owner: Address; data: Uint8Array }>;

async function baseWorld(): Promise<World> {
  const w: World = new Map();
  const [pda1] = await deriveMintStatePda(PROGRAM, MINT);
  const [pda2] = await deriveAttestationPda(PROGRAM, MINT);
  const programData = await deriveProgramDataAddress(PROGRAM);
  const reserve = new Uint8Array(185);
  reserve.set(createHash("sha256").update("account:AttestationRecord").digest().subarray(0, 8), 0);
  const pd = new Uint8Array(45);
  new DataView(pd.buffer).setUint32(0, 3, true);
  const feature = new Uint8Array(9);
  feature[0] = 1;
  w.set(MINT, { owner: TOKEN_2022_PROGRAM, data: MINT_BYTES });
  w.set(pda1, { owner: PROGRAM, data: mintState() });
  w.set(pda2, { owner: PROGRAM, data: reserve });
  w.set(programData, { owner: address("BPFLoaderUpgradeab1e11111111111111111111111"), data: pd });
  w.set(TXV1, { owner: FEATURE, data: feature });
  return w;
}

function standIn(world: World): SolanaRpc {
  const send = <T>(value: T) => ({ send: async () => value });
  return {
    getAccountInfo: (a: Address) => {
      const acc = world.get(a);
      return send({
        context: { slot: SLOT },
        value: acc
          ? { data: [Buffer.from(acc.data).toString("base64"), "base64"], executable: false, lamports: 2_039_280n, owner: acc.owner, rentEpoch: 0n, space: BigInt(acc.data.length) }
          : null,
      });
    },
    getLatestBlockhash: () => send({ context: { slot: SLOT }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 2000n } }),
    getEpochInfo: () => send({ absoluteSlot: SLOT, blockHeight: SLOT, epoch: EPOCH, slotIndex: 100n, slotsInEpoch: 432_000n, transactionCount: 1n }),
    getSlot: () => send(SLOT),
    getMinimumBalanceForRentExemption: () => send(2_157_600n),
  } as unknown as SolanaRpc;
}

async function setup(accounts: (w: World) => void) {
  const world = await baseWorld();
  accounts(world);
  const rpc = standIn(world);
  const ctx = { rpc, commitment: "confirmed" as const, mint: MINT, programId: PROGRAM, decimals: 6 };
  const sent: Base64EncodedWireTransaction[] = [];
  const submit = (after?: (w: World) => void) => async (wire: Base64EncodedWireTransaction) => {
    sent.push(wire);
    after?.(world);
    return SIGNATURE;
  };
  return { world, ctx, sent, submit };
}

async function refusal(promise: Promise<unknown>): Promise<HolderRefusalReason> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HolderRefusal, `expected a HolderRefusal, got ${String(err)}`);
    return err.reason;
  }
  assert.fail("expected a refusal, the operation completed");
}

function ready<T extends { kind: string }>(p: T): Extract<T, { kind: "ready" }> {
  assert.equal(p.kind, "ready");
  return p as Extract<T, { kind: "ready" }>;
}

test("holder shield: refuses at send when the counter moved or the available balance moved; nothing is submitted", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n, { available: 2_000_000n })));
  const plan = ready(await prepareShield(s.ctx, { signer: holder.signer, amountBaseUnits: 1_000_000n }));
  s.world.set(holder.ata, tokenAccount(holder, 5_000_000n, { available: 2_000_000n, pending: 7n, counter: 1n }));
  assert.deepEqual(await refusal(sendShield(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "counter-moved", atRead: 0n, atSend: 1n });
  s.world.set(holder.ata, tokenAccount(holder, 4_800_000n, { available: 2_200_000n, expected: 1n, actual: 1n }));
  assert.deepEqual(await refusal(sendShield(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "available-moved" });
  s.world.delete(holder.ata);
  assert.deepEqual(await refusal(sendShield(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "extension-vanished", tokenAccount: holder.ata });
  assert.equal(s.sent.length, 0);
});

test("holder shield: an unchanged account is sent once, the announcement hook runs after the check, and the copy reads back", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n, { available: 2_000_000n, copy: 1_800_000n })));
  const plan = ready(await prepareShield(s.ctx, { signer: holder.signer, amountBaseUnits: 1_000_000n }));
  assert.equal(plan.correctionBaseUnits, 200_000n);
  assert.equal(plan.confidentialAfterBaseUnits, 3_000_000n);
  const order: string[] = [];
  const result = await sendShield(s.ctx, plan, {
    signer: holder.signer,
    afterCheck: () => order.push("announce"),
    submit: s.submit((w) => {
      order.push("submit");
      w.set(holder.ata, tokenAccount(holder, 4_000_000n, { available: 3_000_000n, expected: 1n, actual: 1n }));
    }),
  });
  assert.deepEqual(order, ["announce", "submit"]);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(result, { signature: SIGNATURE, readBack: { kind: "consistent" } });
});

test("holder shield: the checks before the key run in order (cap, pending, public) and none asks for a signature", async () => {
  let signatures = 0;
  const counting: HolderSigner = {
    address: holder.signer.address,
    signMessages: async (m) => {
      signatures += 1;
      return holder.signer.signMessages(m);
    },
    signTransactions: (t) => holder.signer.signTransactions(t),
  };
  const at = async (conf: Conf, amount: bigint, publicUnits = 5_000_000n) => {
    const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, publicUnits, conf)));
    return refusal(prepareShield(s.ctx, { signer: counting, amountBaseUnits: amount }));
  };
  assert.deepEqual(await at({ available: 0n, pending: 1n, counter: 65536n }, 9_000_000n), { kind: "pending-at-cap", count: 65536n, cap: 65536n });
  assert.deepEqual(await at({ available: 0n, pending: 1n, counter: 1n }, 9_000_000n), { kind: "pending-present", credits: 1n });
  assert.deepEqual(await at({ available: 0n }, 9_000_000n), { kind: "insufficient-public-for-shield", amountBaseUnits: 9_000_000n, publicBaseUnits: 5_000_000n });
  assert.equal(signatures, 0);
  const mismatch = await at({ available: 0n, pubkey: strangerKey }, 1n);
  assert.equal(mismatch.kind, "key-mismatch");
  assert.equal(signatures, 1);
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n)));
  assert.equal((await prepareShield(s.ctx, { signer: holder.signer, amountBaseUnits: 1n })).kind, "not-activated");
});

test("holder apply-pending: refuses at send when the counter moved or the available balance moved; nothing is submitted", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 2_000_000n, pending: 1_500_000n, counter: 2n })));
  const plan = ready(await prepareApplyPending(s.ctx, { signer: holder.signer }));
  assert.equal(plan.confidentialAfterBaseUnits, 3_500_000n);
  s.world.set(holder.ata, tokenAccount(holder, 0n, { available: 2_000_000n, pending: 1_600_000n, counter: 3n }));
  assert.deepEqual(await refusal(sendApplyPending(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "counter-moved", atRead: 2n, atSend: 3n });
  s.world.set(holder.ata, tokenAccount(holder, 0n, { available: 2_300_000n, pending: 1_500_000n, counter: 2n }));
  assert.deepEqual(await refusal(sendApplyPending(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "available-moved" });
  assert.equal(s.sent.length, 0);
});

test("holder apply-pending: stops with nothing to apply or not activated; corrects a short copy with nothing pending; reports a short copy read back", async () => {
  const none = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 2_000_000n })));
  assert.equal((await prepareApplyPending(none.ctx, { signer: holder.signer })).kind, "nothing-to-apply");
  const off = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n)));
  assert.equal((await prepareApplyPending(off.ctx, { signer: holder.signer })).kind, "not-activated");
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 2_000_000n, copy: 1_800_000n, expected: 1n, actual: 1n })));
  const plan = ready(await prepareApplyPending(s.ctx, { signer: holder.signer }));
  assert.equal(plan.credits, 0n);
  assert.equal(plan.correctionBaseUnits, 200_000n);
  const result = await sendApplyPending(s.ctx, plan, {
    signer: holder.signer,
    submit: s.submit((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 2_100_000n, copy: 2_000_000n, expected: 1n, actual: 1n }))),
  });
  assert.deepEqual(result.readBack, { kind: "mismatch", expected: 1n, actual: 1n, check: { kind: "short", missingBaseUnits: 100_000n } });
});

test("holder unshield: refuses at send when the available balance moved, and sends when only a credit arrived", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 2_000_000n })));
  const plan = ready(await prepareUnshield(s.ctx, { signer: holder.signer, amountBaseUnits: 1_000_000n }));
  const original = s.world.get(holder.ata) as { owner: Address; data: Uint8Array };
  s.world.set(holder.ata, tokenAccount(holder, 0n, { available: 2_500_000n }));
  assert.deepEqual(await refusal(sendUnshield(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "available-moved" });
  assert.equal(s.sent.length, 0);
  s.world.set(holder.ata, withAvailableOf(tokenAccount(holder, 0n, { available: 0n, pending: 5n, counter: 1n }), original));
  const result = await sendUnshield(s.ctx, plan, {
    signer: holder.signer,
    submit: s.submit((w) => w.set(holder.ata, tokenAccount(holder, 1_000_000n, { available: 1_000_000n, pending: 5n, counter: 1n }))),
  });
  assert.equal(s.sent.length, 1);
  assert.deepEqual(result, { signature: SIGNATURE, confidentialAfterBaseUnits: 1_000_000n, publicAfterBaseUnits: 1_000_000n });
});

test("holder unshield: refuses an inactive format, an unapproved account, a short copy and an amount above the balance", async () => {
  const off = await setup((w) => {
    w.delete(TXV1);
    w.set(holder.ata, tokenAccount(holder, 0n, { available: 2_000_000n }));
  });
  assert.deepEqual(await refusal(prepareUnshield(off.ctx, { signer: holder.signer, amountBaseUnits: 1n })), { kind: "transaction-format-inactive", state: { kind: "absent" } });
  const at = async (conf: Conf, amount: bigint) => {
    const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n, conf)));
    return refusal(prepareUnshield(s.ctx, { signer: holder.signer, amountBaseUnits: amount }));
  };
  assert.deepEqual(await at({ available: 2_000_000n, approved: false }, 1n), { kind: "account-unapproved" });
  assert.deepEqual(await at({ available: 2_000_000n, copy: 1_500_000n }, 1n), { kind: "copy-short", missingBaseUnits: 500_000n });
  assert.deepEqual(await at({ available: 2_000_000n }, 3_000_000n), { kind: "insufficient-confidential-for-unshield", amountBaseUnits: 3_000_000n, confidentialBaseUnits: 2_000_000n });
});

test("holder confidential-transfer: refuses at send when the available balance moved, and sends when only a credit arrived", async () => {
  const s = await setup((w) => {
    w.set(holder.ata, tokenAccount(holder, 0n, { available: 5_000_000n }));
    w.set(recipient.ata, tokenAccount(recipient, 0n, { available: 0n }));
  });
  const plan = ready(await prepareConfidentialTransfer(s.ctx, { signer: holder.signer, recipient: recipient.signer.address, netBaseUnits: 1_000_000n }));
  const original = s.world.get(holder.ata) as { owner: Address; data: Uint8Array };
  s.world.set(holder.ata, tokenAccount(holder, 0n, { available: 4_000_000n }));
  assert.deepEqual(await refusal(sendConfidentialTransfer(s.ctx, plan, { signer: holder.signer, submit: s.submit() })), { kind: "available-moved" });
  assert.equal(s.sent.length, 0);
  s.world.set(holder.ata, withAvailableOf(tokenAccount(holder, 0n, { available: 0n, pending: 9n, counter: 1n }), original));
  const result = await sendConfidentialTransfer(s.ctx, plan, {
    signer: holder.signer,
    submit: s.submit((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 4_000_000n, pending: 9n, counter: 1n }))),
  });
  assert.equal(s.sent.length, 1);
  assert.deepEqual(result, { signature: SIGNATURE, confidentialAfterBaseUnits: 4_000_000n });
});

test("holder confidential-transfer: refuses the sender as recipient, a non-wallet, an unactivated or closed recipient, and a fee below the minimum", async () => {
  const s = await setup((w) => {
    w.set(holder.ata, tokenAccount(holder, 0n, { available: 5_000_000n }));
    w.set(recipient.ata, tokenAccount(recipient, 0n));
  });
  const send = (to: Address) => prepareConfidentialTransfer(s.ctx, { signer: holder.signer, recipient: to, netBaseUnits: 1_000_000n });
  assert.deepEqual(await refusal(send(holder.signer.address)), { kind: "self-transfer", recipient: holder.signer.address });
  const [pda1] = await deriveMintStatePda(PROGRAM, MINT);
  assert.deepEqual(await refusal(send(pda1)), { kind: "recipient-not-a-wallet", recipient: pda1 });
  assert.deepEqual(await refusal(send(recipient.signer.address)), { kind: "recipient-not-activated", recipient: recipient.signer.address });
  s.world.set(recipient.ata, tokenAccount(recipient, 0n, { available: 0n, allowConfidential: false }));
  assert.deepEqual(await refusal(send(recipient.signer.address)), { kind: "recipient-cannot-receive", recipient: recipient.signer.address, why: "credits-disabled" });
  s.world.set(pda1, { owner: PROGRAM, data: mintState(1n) });
  assert.deepEqual(await refusal(send(recipient.signer.address)), { kind: "below-minimum-fee", feeBaseUnits: 0n, minimumFeeBaseUnits: 1n });
});

test("holder public-transfer: refuses the sender, a short public balance and a recipient refusing public credits; creates the account only when absent", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n)));
  const send = (to: Address, net: bigint) => preparePublicTransfer(s.ctx, { signer: holder.signer, recipient: to, netBaseUnits: net });
  assert.deepEqual(await refusal(send(holder.signer.address, 1n)), { kind: "self-transfer", recipient: holder.signer.address });
  assert.deepEqual(await refusal(send(recipient.signer.address, 9_000_000n)), {
    kind: "insufficient-public-for-transfer",
    netBaseUnits: 9_000_000n,
    grossBaseUnits: 9_000_000n,
    publicBaseUnits: 5_000_000n,
  });
  const absent = await send(recipient.signer.address, 1_000_000n);
  assert.equal(absent.createRecipientAccount, true);
  assert.equal(absent.rentLamports, 2_157_600n);
  s.world.set(recipient.ata, tokenAccount(recipient, 0n));
  const present = await send(recipient.signer.address, 1_000_000n);
  assert.equal(present.createRecipientAccount, false);
  assert.equal(present.rentLamports, undefined);
  s.world.set(recipient.ata, tokenAccount(recipient, 0n, { available: 0n, allowPublic: false }));
  assert.deepEqual(await refusal(send(recipient.signer.address, 1_000_000n)), { kind: "recipient-refuses-public", recipient: recipient.signer.address });
});

test("holder balance: another holder's account asks for no signature; a key mismatch is data, not a refusal; a short copy is reported", async () => {
  let signatures = 0;
  const counting: HolderSigner = {
    address: holder.signer.address,
    signMessages: async (m) => {
      signatures += 1;
      return holder.signer.signMessages(m);
    },
    signTransactions: (t) => holder.signer.signTransactions(t),
  };
  const s = await setup((w) => {
    w.set(recipient.ata, tokenAccount(recipient, 4_000_000n, { available: 1n }));
    w.set(holder.ata, tokenAccount(holder, 1_000_000n, { available: 9_000_000n, copy: 8_800_000n, pending: 2_500_000n, counter: 2n }));
  });
  const foreign = await readHolderBalance(s.ctx, { owner: recipient.signer.address, signer: counting });
  assert.equal(foreign.kind, "foreign");
  assert.equal(signatures, 0);
  const mine = await readHolderBalance(s.ctx, { owner: holder.signer.address, signer: counting });
  assert.equal(signatures, 1);
  assert.ok(mine.kind === "decrypted");
  assert.deepEqual(mine.confidential, { readable: true, baseUnits: 8_800_000n });
  assert.deepEqual(mine.pending, { readable: true, baseUnits: 2_500_000n });
  assert.deepEqual(mine.copyCheck, { kind: "short", missingBaseUnits: 200_000n });
  s.world.set(holder.ata, tokenAccount(holder, 1_000_000n, { available: 1n, pubkey: strangerKey }));
  const other = await readHolderBalance(s.ctx, { owner: holder.signer.address, signer: counting });
  assert.equal(other.kind, "key-mismatch");
});

test("holder setup-privacy: an activated account reports whether its key matches; a read-back under another key is refused after the read-back hook", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 0n, { available: 0n })));
  const check = await checkActivation(s.ctx, holder.signer);
  assert.ok(check.kind === "already-activated" && check.matches);
  const fresh = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n)));
  const before = await checkActivation(fresh.ctx, holder.signer);
  assert.ok(before.kind === "not-activated");
  const order: string[] = [];
  const reason = await refusal(
    activateConfidentialBalances(fresh.ctx, {
      signer: holder.signer,
      tokenAccount: before.tokenAccount,
      submit: fresh.submit((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n, { available: 0n, pubkey: strangerKey }))),
      onReadBack: () => order.push("read-back"),
    }),
  );
  assert.deepEqual(order, ["read-back"]);
  assert.equal(reason.kind, "activation-read-back-mismatch");
  assert.equal(fresh.sent.length, 1);
});

test("holder state: each record the read needs is refused by name when absent", async () => {
  const [pda1] = await deriveMintStatePda(PROGRAM, MINT);
  const [pda2] = await deriveAttestationPda(PROGRAM, MINT);
  const programData = await deriveProgramDataAddress(PROGRAM);
  const full = await setup(() => {});
  const overview = await readMintOverview(full.ctx);
  assert.equal(overview.mintState.minimumFee, 0n);
  assert.equal(overview.epoch, EPOCH);
  for (const [account, at] of [["mint-state", pda1], ["mint", MINT], ["program-data", programData], ["reserve-statement", pda2]] as const) {
    const s = await setup((w) => w.delete(at));
    assert.deepEqual(await refusal(readMintOverview(s.ctx)), { kind: "account-not-found", account, address: at });
  }
});

test("holder signer: a wallet-style signer, not a key file, derives the same keys and signs a shield", async () => {
  // Two functions over a key the wrapper never exposes: the shape a wallet adapter presents.
  const wallet: HolderSigner = {
    address: holder.signer.address,
    signMessages: (messages) => holder.signer.signMessages(messages),
    signTransactions: (transactions) => holder.signer.signTransactions(transactions),
  };
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n, { available: 2_000_000n })));
  const plan = ready(await prepareShield(s.ctx, { signer: wallet, amountBaseUnits: 1_000_000n }));
  assert.deepEqual(plan.keys, holder.keys);
  await sendShield(s.ctx, plan, {
    signer: wallet,
    submit: s.submit((w) => w.set(holder.ata, tokenAccount(holder, 4_000_000n, { available: 3_000_000n, expected: 1n, actual: 1n }))),
  });
  assert.equal(s.sent.length, 1);
});

test("holder read-back: an account that loses its extension after a confirmed send is refused with the signature", async () => {
  const s = await setup((w) => w.set(holder.ata, tokenAccount(holder, 5_000_000n, { available: 2_000_000n })));
  const plan = ready(await prepareShield(s.ctx, { signer: holder.signer, amountBaseUnits: 1_000_000n }));
  const reason = await refusal(sendShield(s.ctx, plan, { signer: holder.signer, submit: s.submit((w) => w.delete(holder.ata)) }));
  assert.deepEqual(reason, { kind: "extension-gone-after-send", signature: SIGNATURE, tokenAccount: holder.ata });
  assert.equal(s.sent.length, 1);
});
