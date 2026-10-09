// PURE Reserve-countersignature application.
// Offline: no network, no file I/O, and no message reconstruction — the Reserve
// key signs the transaction's EXISTING messageBytes, and kit's
// partiallySignTransaction MERGES into the existing signatures map, so the
// issuer's signature survives untouched (verified by probe and pinned in
// countersign-apply.test.ts). A key that is not one of the transaction's
// required signers is refused by kit itself with a SolanaError.
//
// Deliberately does NOT assert fully-signed (that is the command's final
// gate) and does NOT judge WHICH key reserveSigner is (the role-guard is the
// command layer's job) — this function only applies the signature.

import {
  getTransactionDecoder,
  partiallySignTransaction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";

export async function applyReserveCountersignature(
  wireBytes: Uint8Array,
  reserveSigner: KeyPairSigner,
): Promise<Transaction> {
  let transaction: Transaction;
  try {
    transaction = getTransactionDecoder().decode(wireBytes);
  } catch (err) {
    throw new Error(
      `countersign: wire bytes are not a decodable transaction: ${(err as Error).message}`,
    );
  }
  return await partiallySignTransaction([reserveSigner.keyPair], transaction);
}
