// Offline unit tests for the I-4 admin pause PURE surface only, per
// convention: the live broadcast path is proven by a real devnet run, never
// mocked. runAdminPause is NOT called here (it does live getAccountInfo).
// The role-guard tests exercise assertRoleAuthority — the exact function
// runAdminPause calls before signing — against the real devnet PDA-1
// snapshot, covering the any-1-of-3 acceptance and both rejection axes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { address } from "@solana/kit";
import { decodeMintState } from "../mint-state.js";
import { assertRoleAuthority } from "../role-guard.js";
import { formatPauseInspection } from "./admin-pause.js";

// Real devnet PDA-1 snapshot (same fixture as role-guard.test.ts /
// mint-state.test.ts): issuer is the post-rotation v2 key.
const fixtureUrl = new URL(
  "../../test-fixtures/pda1-mintstate-devnet.b64",
  import.meta.url,
);
const state = decodeMintState(
  Uint8Array.from(
    Buffer.from(readFileSync(fixtureUrl, "utf8").trim(), "base64"),
  ),
);

const MINT = address("9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa");
const MINT_STATE = address("GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
const V2_ISSUER = address("3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb");
const NON_AUTHORITY = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

test("pause role-guard: operator authority with stated role operator passes (any-1-of-3)", () => {
  assert.doesNotThrow(() => assertRoleAuthority("operator", state.operator, state));
});

test("pause role-guard: reserve authority with stated role reserve passes (any-1-of-3)", () => {
  assert.doesNotThrow(() => assertRoleAuthority("reserve", state.reserve, state));
});

test("pause role-guard: a non-authority address stated as issuer is refused, naming role, got key, and expected key", () => {
  assert.throws(
    () => assertRoleAuthority("issuer", NON_AUTHORITY, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("issuer"), "message must name the role");
      assert.ok(
        err.message.includes(NON_AUTHORITY),
        "message must name the key it got",
      );
      assert.ok(
        err.message.includes(V2_ISSUER),
        "message must name the key it expected",
      );
      return true;
    },
  );
});

test("pause role-guard: right key, wrong role — operator authority stated as issuer is refused, naming role, got key, and expected key", () => {
  assert.throws(
    () => assertRoleAuthority("issuer", state.operator, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("issuer"), "message must name the role");
      assert.ok(
        err.message.includes(state.operator),
        "message must name the key it got",
      );
      assert.ok(
        err.message.includes(V2_ISSUER),
        "message must name the key it expected",
      );
      return true;
    },
  );
});

test("pause inspection (not currently paused): mint, PDA-1, current=false, role/authority guard line, and the WILL SET line all appear; idempotent note ABSENT", () => {
  const out = formatPauseInspection({
    mint: MINT,
    mintStatePda: MINT_STATE,
    currentPauseActive: false,
    role: "issuer",
    authority: V2_ISSUER,
  });
  assert.ok(out.includes(`mint           : ${MINT}`));
  assert.ok(out.includes(`PDA-1          : ${MINT_STATE}`));
  assert.ok(out.includes("issuance paused (current): false (PDA-1 pause_active)"));
  assert.ok(
    out.includes(
      `role/authority : issuer / ${V2_ISSUER} (matched live PDA-1 — role-guard enforced)`,
    ),
  );
  assert.ok(
    out.includes(
      "WILL SET pause_active = true — blocks I-2 mint only; burns (I-3), user transfers, and resume (I-5) are UNAFFECTED.",
    ),
  );
  assert.ok(
    !out.includes("note: issuance is already paused — this send is an idempotent no-op."),
    "idempotent note must be ABSENT when not currently paused",
  );
});

test("pause inspection (already paused): same block PLUS the idempotent no-op note — informational only, never a refusal", () => {
  const out = formatPauseInspection({
    mint: MINT,
    mintStatePda: MINT_STATE,
    currentPauseActive: true,
    role: "reserve",
    authority: state.reserve,
  });
  assert.ok(out.includes(`mint           : ${MINT}`));
  assert.ok(out.includes(`PDA-1          : ${MINT_STATE}`));
  assert.ok(out.includes("issuance paused (current): true (PDA-1 pause_active)"));
  assert.ok(
    out.includes(
      `role/authority : reserve / ${state.reserve} (matched live PDA-1 — role-guard enforced)`,
    ),
  );
  assert.ok(
    out.includes(
      "WILL SET pause_active = true — blocks I-2 mint only; burns (I-3), user transfers, and resume (I-5) are UNAFFECTED.",
    ),
  );
  assert.ok(
    out.includes("note: issuance is already paused — this send is an idempotent no-op."),
    "idempotent note must be PRESENT when already paused",
  );
});
