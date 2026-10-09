// "ddc-admin-tx-v1" admin-transaction file envelope. Serialize/parse only. The
// claim block is a human-readable convenience for the operator and is NEVER
// trusted on parse: the countersigner re-derives everything from the
// transaction bytes.

import { getBase64EncodedWireTransaction, type Transaction } from "@solana/kit";

export const ADMIN_TX_ENVELOPE_KIND = "ddc-admin-tx-v1";

export interface AdminTxClaim {
  amountDisplay: string;
  /** Raw base units as a decimal string (bigint is not JSON-representable). */
  amount: string;
  destination: string;
  nonceAccount: string;
  feePayer: string;
  initiatorRole: string;
  signedBy: readonly string[];
  awaitingSignature: string;
}

export interface ParsedAdminTxEnvelope {
  transactionBytes: Uint8Array;
  claim: AdminTxClaim;
}

export function serializeAdminTxEnvelope(
  partiallySignedTx: Transaction,
  claim: AdminTxClaim,
  instruction: string = "mint_tokens",
): string {
  return JSON.stringify(
    {
      kind: ADMIN_TX_ENVELOPE_KIND,
      instruction,
      transaction: getBase64EncodedWireTransaction(partiallySignedTx),
      claim,
    },
    null,
    2,
  );
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `admin-tx envelope ${where} "${field}" is missing or not a non-empty string`,
    );
  }
  return value;
}

export function parseAdminTxEnvelope(
  jsonString: string,
): ParsedAdminTxEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(
      `admin-tx envelope is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("admin-tx envelope must be a JSON object");
  }
  const env = parsed as Record<string, unknown>;

  if (env["kind"] !== ADMIN_TX_ENVELOPE_KIND) {
    throw new Error(
      `admin-tx envelope kind mismatch: expected "${ADMIN_TX_ENVELOPE_KIND}", got ${JSON.stringify(env["kind"])}`,
    );
  }
  requireString(env, "instruction", "field");
  const transactionB64 = requireString(env, "transaction", "field");
  const transactionBytes = Uint8Array.from(
    Buffer.from(transactionB64, "base64"),
  );
  if (transactionBytes.length === 0) {
    throw new Error('admin-tx envelope "transaction" decodes to zero bytes');
  }

  const rawClaim = env["claim"];
  if (
    typeof rawClaim !== "object" ||
    rawClaim === null ||
    Array.isArray(rawClaim)
  ) {
    throw new Error('admin-tx envelope "claim" is missing or not an object');
  }
  const c = rawClaim as Record<string, unknown>;

  const rawSignedBy = c["signedBy"];
  if (!Array.isArray(rawSignedBy)) {
    throw new Error(
      'admin-tx envelope claim field "signedBy" is missing or not an array',
    );
  }
  const signedBy = rawSignedBy.map((entry): string => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        'admin-tx envelope claim field "signedBy" must contain only non-empty strings',
      );
    }
    return entry;
  });

  const claim: AdminTxClaim = {
    amountDisplay: requireString(c, "amountDisplay", "claim field"),
    amount: requireString(c, "amount", "claim field"),
    destination: requireString(c, "destination", "claim field"),
    nonceAccount: requireString(c, "nonceAccount", "claim field"),
    feePayer: requireString(c, "feePayer", "claim field"),
    initiatorRole: requireString(c, "initiatorRole", "claim field"),
    signedBy,
    awaitingSignature: requireString(c, "awaitingSignature", "claim field"),
  };
  return { transactionBytes, claim };
}
