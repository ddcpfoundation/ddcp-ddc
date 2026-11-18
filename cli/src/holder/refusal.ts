// The reasons a holder operation stops without sending, as data. The library
// carries no text: a caller turns each reason into its own words, as the
// command-line tool does with the sentences it has always printed. Every
// reason that can occur before a send means nothing was sent.

import type { Address, Signature } from "@solana/kit";
import type { TransactionFormatState } from "../transaction-format.js";

export type HolderRefusalReason =
  /** An account the operation reads does not exist on the cluster. */
  | { kind: "account-not-found"; account: "mint-state" | "mint" | "program-data" | "reserve-statement"; address: Address }
  /** The mint lacks an extension every mint of the reference carries. */
  | { kind: "mint-extension-missing"; extension: "any" | "ConfidentialTransferMint" | "ConfidentialTransferFeeConfig" }
  /** The version-1 transaction format is not active on the cluster. */
  | { kind: "transaction-format-inactive"; state: Exclude<TransactionFormatState, { kind: "active" }> }
  /** The key stored on the account is not the key this signer derives. */
  | { kind: "key-mismatch"; onChainKey: Address; derivedKey: Address }
  /** A figure does not decrypt with the derived key. */
  | { kind: "figure-unreadable"; figure: "confidential" | "pending" }
  /** The balance copy differs from the encrypted balance by more than can be read. */
  | { kind: "copy-unreadable" }
  /** The balance copy is short; spending refuses until apply-pending corrects it. */
  | { kind: "copy-short"; missingBaseUnits: bigint }
  /** The account is configured but not approved for confidential transfers. */
  | { kind: "account-unapproved" }
  /** The pending credit counter is at its cap. */
  | { kind: "pending-at-cap"; count: bigint; cap: bigint }
  /** Credits are pending; shield refuses until they are applied. */
  | { kind: "pending-present"; credits: bigint }
  /** The public balance is short of the amount (shield). */
  | { kind: "insufficient-public-for-shield"; amountBaseUnits: bigint; publicBaseUnits: bigint }
  /** The public balance is short of the gross (public transfer). */
  | { kind: "insufficient-public-for-transfer"; netBaseUnits: bigint; grossBaseUnits: bigint; publicBaseUnits: bigint }
  /** The confidential balance is short of the amount (unshield). */
  | { kind: "insufficient-confidential-for-unshield"; amountBaseUnits: bigint; confidentialBaseUnits: bigint }
  /** The confidential balance is short of the gross (confidential transfer). */
  | { kind: "insufficient-confidential-for-transfer"; netBaseUnits: bigint; grossBaseUnits: bigint; confidentialBaseUnits: bigint }
  /** The account's extension disappeared between two reads. */
  | { kind: "extension-vanished"; tokenAccount: Address }
  /** The pending credit counter moved between the read and the send. */
  | { kind: "counter-moved"; atRead: bigint; atSend: bigint }
  /** The encrypted available balance changed between the read and the send. */
  | { kind: "available-moved" }
  /** The token account derived for the transaction differs from the one read. */
  | { kind: "token-account-differs"; read: Address; assembled: Address }
  /** The fee schedule changes within the headroom before the epoch boundary. */
  | { kind: "schedule-headroom"; slotsRemaining: bigint }
  /** The fee schedule in force changed between the quote and the send. */
  | { kind: "schedule-moved" }
  /** The fee is below the program's minimum fee. */
  | { kind: "below-minimum-fee"; feeBaseUnits: bigint; minimumFeeBaseUnits: bigint }
  /** The recipient is not a wallet address (it is off the curve, such as a program-derived address). */
  | { kind: "recipient-not-a-wallet"; recipient: Address }
  /** The recipient is the sender. */
  | { kind: "self-transfer"; recipient: Address }
  /** The recipient's account is not activated for confidential credits. */
  | { kind: "recipient-not-activated"; recipient: Address }
  /** The recipient's account cannot receive a confidential credit now. */
  | { kind: "recipient-cannot-receive"; recipient: Address; why: "unapproved" | "credits-disabled" | "pending-full" }
  /** The recipient's account refuses public credits. */
  | { kind: "recipient-refuses-public"; recipient: Address }
  /** After a confirmed send, the account no longer reports its extension. */
  | { kind: "extension-gone-after-send"; signature: Signature; tokenAccount: Address }
  /** After a confirmed activation, the account does not read back as configured. */
  | { kind: "activation-read-back-failed"; signature: Signature; tokenAccount: Address; stateKind: "absent" | "unconfigured" }
  /** After a confirmed activation, the stored key is not the derived key. */
  | { kind: "activation-read-back-mismatch"; signature: Signature; onChainKey: Address; derivedKey: Address };

/** Thrown by a holder operation that stops; `reason` says why, as data. */
export class HolderRefusal extends Error {
  constructor(readonly reason: HolderRefusalReason) {
    super(`holder operation refused: ${reason.kind}`);
    this.name = "HolderRefusal";
  }
}
