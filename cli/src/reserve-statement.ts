// PURE decoder for the program's reserve statement record (PDA-2,
// `AttestationRecord` on chain), read by `state` beside the program's record.
// Bytes in, typed values out, named throws.
//
// Layout, 185 bytes:
//   [0:8]     account discriminator = SHA-256("account:AttestationRecord")[0:8]
//   [8:16]    attested_reserve_amount (u64 LE): the reserve's value in the
//             currency's unit of account, in base units (6 dp)
//   [16:24]   attestation_timestamp (i64 LE): the cluster clock when the
//             statement was published, not when the reserve was measured
//   [24:56]   attestor_pubkey: the key that published it; all zero until the
//             first statement
//   [56:184]  attestation_uri: the instruction's bytes, zero-padded to 128.
//             The record keeps no length, so trailing zero bytes of a URI
//             cannot be told from the padding; they are dropped.
//   [184]     bump
// The program creates the record at genesis with every field zero but the
// bump, and the reserve key overwrites it with each statement.

import { createHash } from "node:crypto";
import { getAddressDecoder, type Address } from "@solana/kit";

const RESERVE_STATEMENT_LEN = 185;
const URI_START = 56;
const URI_END = 184;
// The JavaScript Date range, in seconds either side of 1970.
const MAX_DATE_SECONDS = 8_640_000_000_000n;

const EXPECTED_DISCRIMINATOR: Buffer = createHash("sha256")
  .update("account:AttestationRecord")
  .digest()
  .subarray(0, 8);

export interface ReserveStatement {
  /** Base units (6 dp) of the currency's unit of account. */
  readonly amount: bigint;
  /** Unix seconds from the cluster clock at publication; 0 before the first. */
  readonly publishedAt: bigint;
  /** The publishing key, or null while no statement has been published. */
  readonly publisher: Address | null;
  /** The URI bytes with the zero padding removed. */
  readonly uriBytes: Uint8Array;
  readonly bump: number;
}

export function decodeReserveStatement(data: Uint8Array): ReserveStatement {
  if (data.length !== RESERVE_STATEMENT_LEN) {
    throw new Error(
      `reserve statement account data must be exactly ${RESERVE_STATEMENT_LEN} bytes, got ${data.length}`,
    );
  }
  const discriminator = Buffer.from(data.subarray(0, 8));
  if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
    throw new Error(
      `reserve statement discriminator mismatch: expected ${EXPECTED_DISCRIMINATOR.toString("hex")}, got ${discriminator.toString("hex")}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const publisherBytes = data.subarray(24, 56);
  let uriEnd = URI_END;
  while (uriEnd > URI_START && data[uriEnd - 1] === 0) uriEnd--;
  return {
    amount: view.getBigUint64(8, true),
    publishedAt: view.getBigInt64(16, true),
    publisher: publisherBytes.every((b) => b === 0) ? null : getAddressDecoder().decode(publisherBytes),
    uriBytes: data.slice(URI_START, uriEnd),
    bump: view.getUint8(184),
  };
}

/** The URI as printed: quoted text when it is UTF-8, otherwise its bytes in hex. */
export function formatReserveStatementUri(uriBytes: Uint8Array): string {
  try {
    return JSON.stringify(new TextDecoder("utf-8", { fatal: true }).decode(uriBytes));
  } catch {
    return `not UTF-8, ${uriBytes.length} bytes, hex ${Buffer.from(uriBytes).toString("hex")}`;
  }
}

/**
 * The lines `state` prints for the reserve statement. `reserve` is the
 * reserve key in the program's record now; a statement published before a
 * rotation of that key names the earlier key.
 */
export function formatReserveStatementLines(
  s: ReserveStatement,
  expect: { readonly pda: Address; readonly reserve: Address },
): string[] {
  const lines = [`reserveStmt    : ${expect.pda} (PDA-2, bump ${s.bump})`];
  if (s.publisher === null) {
    lines.push("reserveStmtBy  : none published");
    return lines;
  }
  const inRange = s.publishedAt >= -MAX_DATE_SECONDS && s.publishedAt <= MAX_DATE_SECONDS;
  const at = inRange
    ? new Date(Number(s.publishedAt) * 1000).toISOString().replace(".000Z", "Z")
    : `${s.publishedAt} unix seconds, outside the calendar range`;
  lines.push(
    `reserveStmtBy  : ${s.publisher}` +
      (s.publisher === expect.reserve ? " (the reserve key in PDA-1)" : " (NOT the reserve key in PDA-1 now)"),
  );
  lines.push(`reserveStmtAt  : ${at} (cluster clock at publication; the time of measurement is in the document)`);
  lines.push(`reserveAmount  : ${s.amount} base units (6 dp, the reserve's value in the currency's unit of account)`);
  lines.push(`reserveStmtUri : ${formatReserveStatementUri(s.uriBytes)}`);
  return lines;
}
