// What every holder operation is given by its caller. The library reads no
// configuration file and no key file and prints nothing: the caller states the
// endpoint, the commitment, the mint and the currency's decimals, and passes a
// signer. A signer is anything that holds an address and can sign messages and
// transactions on request: a key file loaded by the command-line tool, or a
// wallet that never gives up its secret key.

import type {
  Address,
  Base64EncodedWireTransaction,
  Commitment,
  MessagePartialSigner,
  Signature,
  Transaction,
  TransactionPartialSigner,
} from "@solana/kit";
import type { SolanaRpc } from "../rpc.js";

/** The cluster, the commitment every read is made at, and the mint. */
export interface HolderContext {
  readonly rpc: SolanaRpc;
  readonly commitment: Commitment;
  readonly mint: Address;
}

/** A context that also names the reference program, for the reads of its records. */
export interface ProgramContext extends HolderContext {
  readonly programId: Address;
}

/** A context for the operations that move tokens, which carry the currency's decimals. */
export interface TokenContext extends HolderContext {
  /** The currency's decimals; Token-2022 checks them against the mint. */
  readonly decimals: number;
}

/**
 * The holder's signer: one signature over the standard message derives the
 * confidential-account keys, and transactions are signed for sending.
 */
export type HolderSigner = MessagePartialSigner & TransactionPartialSigner;

/**
 * Sends a fully signed transaction and resolves with its signature once the
 * network has confirmed it; rejects otherwise. The caller chooses how: the
 * tool sends and polls itself, a wallet may use its own connection.
 */
export type Submit = (
  wire: Base64EncodedWireTransaction,
  transaction: Transaction,
) => Promise<Signature>;
