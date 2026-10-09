// The distinct co-signer check (I-8), run by the client before anything is
// signed. The program requires the issuer, operator and reserve keys to be
// three distinct keys as they would stand after a rotation, and refuses a
// rotation that gives one role another role's current key
// (CoSignersNotDistinct 6012, program/src/validation.rs). A rotation naming
// such a key fails on-chain, so the CLI refuses it before the operator signs
// it at serialize and before the reserve countersigns it, rather than leaving
// the program as the only check. The program stays the control; this check
// only spares an operator a signature on a transaction that cannot succeed.
//
// Pure: the caller passes the live PDA-1 read.

import type { Address } from "@solana/kit";

const EM_DASH = String.fromCharCode(0x2014);

const ROLE_NAMES = ["Issuer", "Operator", "Reserve"] as const;

export interface CoSignerRotation {
  readonly role: number;
  readonly newSigner: Address;
  readonly issuer: Address;
  readonly operator: Address;
  readonly reserve: Address;
}

/**
 * Pure: undefined when the three keys after the rotation are distinct, or when
 * the role is outside 0..2 (the program's InvalidRole check owns that bound);
 * otherwise the refusal sentence, naming the roles that share a key.
 */
export function decideDistinctCoSigners(input: CoSignerRotation): string | undefined {
  if (!Number.isInteger(input.role) || input.role < 0 || input.role > 2) return undefined;
  const after: Address[] = [input.issuer, input.operator, input.reserve];
  after[input.role] = input.newSigner;
  const rule =
    "The program requires the Issuer, Operator and Reserve keys to be three distinct keys after a rotation, so this transaction could never succeed. " +
    "Nothing was signed and nothing was sent. ";
  for (let other = 0; other < 3; other += 1) {
    if (other !== input.role && after[other] === input.newSigner) {
      return (
        "REFUSED " + EM_DASH + " the new signer " + input.newSigner + " for role " + input.role + " (" +
        ROLE_NAMES[input.role] + ") is the current " + ROLE_NAMES[other] + " key. " + rule +
        "Name a key that no other role holds."
      );
    }
  }
  // The new key is unique, but the two roles left untouched may already share
  // one key; the program judges all three, so the client does too.
  const [x, y] = [0, 1, 2].filter((r) => r !== input.role) as [number, number];
  if (after[x] === after[y]) {
    return (
      "REFUSED " + EM_DASH + " the " + ROLE_NAMES[x] + " and " + ROLE_NAMES[y] + " keys are already one key, " +
      after[x] + ", and this rotation of role " + input.role + " (" + ROLE_NAMES[input.role] + ") leaves them so. " + rule +
      "Rotate one of those two roles to a key no other role holds."
    );
  }
  return undefined;
}
