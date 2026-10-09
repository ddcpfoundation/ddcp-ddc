// PURE role guard for admin signing (signing tiers). No network, no filesystem,
// no kit runtime calls: the command layer owns the live PDA-1 fetch; this
// module only compares.

import type { Address } from "@solana/kit";
import type { MintState } from "./mint-state.js";

export type Role = "issuer" | "operator" | "reserve";

/**
 * Assert that `signerAddress` is the on-chain authority for the STATED `role`
 * in the given MintState — catches both wrong-key and right-key-wrong-role.
 *
 * FRESHNESS IS NOT THIS GUARD'S JOB. This is a pure function: it performs no
 * fetch and cannot verify that the MintState it was handed reflects the chain
 * now — an I-8 rotation may have landed since the read. The caller MUST pass
 * a MintState decoded from a PDA-1 read performed live, immediately before
 * signing; in the two-party flow, BOTH the initiator and the countersigner
 * re-read PDA-1 before adding their signature.
 *
 * Returns nothing on success. Throws an Error on mismatch whose message names
 * the stated role, the key it got, and the on-chain authority it expected.
 */
export function assertRoleAuthority(
  role: Role,
  signerAddress: Address,
  state: MintState,
): void {
  // EXHAUSTIVE, not a fallthrough: every role is tested BY NAME. The final
  // branch is unreachable while Role has exactly three members. The `never`
  // assignment makes a fourth member a COMPILE error, and the throw makes it
  // a loud runtime failure — never a silent comparison against the Reserve
  // authority.
  let expected: Address;
  if (role === "issuer") {
    expected = state.issuer;
  } else if (role === "operator") {
    expected = state.operator;
  } else if (role === "reserve") {
    expected = state.reserve;
  } else {
    const unreachable: never = role;
    throw new Error(
      `role guard refused: unknown role "${String(unreachable)}" — the role set is exactly "issuer", "operator", "reserve"`,
    );
  }
  if (signerAddress !== expected) {
    throw new Error(
      `role guard refused: stated role "${role}" — got key ${signerAddress}, ` +
        `expected the on-chain ${role} authority ${expected}`,
    );
  }
}
