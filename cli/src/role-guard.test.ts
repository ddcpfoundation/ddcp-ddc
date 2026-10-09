import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Address } from "@solana/kit";
import { decodeMintState } from "./mint-state.js";
import { assertRoleAuthority, type Role } from "./role-guard.js";

// Real devnet PDA-1 snapshot (same fixture as mint-state.test.ts): issuer is
// the post-rotation v2 key.
const fixtureUrl = new URL(
  "../test-fixtures/pda1-mintstate-devnet.b64",
  import.meta.url,
);
const state = decodeMintState(
  Uint8Array.from(
    Buffer.from(readFileSync(fixtureUrl, "utf8").trim(), "base64"),
  ),
);

const V2_ISSUER = "3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb" as Address;
const RETIRED_ISSUER =
  "HfDDJCMN4GKGVs7WmazzYMv1Q7cJgpp8a91BwXGQ355b" as Address;
const OPERATOR = "CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe" as Address;

test("v2 issuer key with stated role issuer passes", () => {
  assert.doesNotThrow(() => assertRoleAuthority("issuer", V2_ISSUER, state));
});

test("retired issuer key with stated role issuer is refused, naming role, got key, and expected key", () => {
  assert.throws(
    () => assertRoleAuthority("issuer", RETIRED_ISSUER, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("issuer"), "message must name the role");
      assert.ok(
        err.message.includes(RETIRED_ISSUER),
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

test("right key, wrong role: issuer key stated as operator is refused, naming role, got key, and expected key", () => {
  assert.throws(
    () => assertRoleAuthority("operator", V2_ISSUER, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("operator"), "message must name the role");
      assert.ok(
        err.message.includes(V2_ISSUER),
        "message must name the key it got",
      );
      assert.ok(
        err.message.includes(OPERATOR),
        "message must name the key it expected",
      );
      return true;
    },
  );
});

test("operator key with stated role operator passes", () => {
  assert.doesNotThrow(() => assertRoleAuthority("operator", state.operator, state));
});

test("reserve key with stated role reserve passes", () => {
  assert.doesNotThrow(() => assertRoleAuthority("reserve", state.reserve, state));
});

// The `never` branch of assertRoleAuthority is UNREACHABLE from any typed
// caller — that is its entire purpose. The double cast below defeats the type
// system DELIBERATELY, and is the only way to exercise the runtime throw. `as
// unknown as Role` is required: TypeScript refuses a direct assertion between
// two types with no overlap. No live path can produce this value today —
// parseRoleOrThrow blocks every route in — so this pins behavior for a future
// in which a fourth role is added, never a comparison against the reserve
// authority by elimination.
test("an unknown role is refused BY NAME, never compared against the reserve authority", () => {
  assert.throws(
    () => assertRoleAuthority("treasurer" as unknown as Role, V2_ISSUER, state),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("treasurer"),
        "message must name the bad value",
      );
      assert.ok(err.message.includes("issuer"), "message must name the role set");
      assert.ok(err.message.includes("operator"), "message must name the role set");
      assert.ok(err.message.includes("reserve"), "message must name the role set");
      return true;
    },
  );
});
