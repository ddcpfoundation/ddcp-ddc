import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_ID, DDC_MINT } from "./constants.js";
import {
  deriveFeeAuthorityPda,
  deriveMintStatePda,
  deriveRedemptionAuthorityPda,
} from "./pda.js";

test("deriveMintStatePda derives the on-chain devnet PDA-1", async () => {
  const [pda, bump] = await deriveMintStatePda(PROGRAM_ID, DDC_MINT);
  assert.equal(pda, "GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B");
  assert.equal(bump, 255);
});

test("deriveRedemptionAuthorityPda derives the known devnet PDA-5", async () => {
  const [pda, bump] = await deriveRedemptionAuthorityPda(
    PROGRAM_ID,
    DDC_MINT,
  );
  assert.equal(pda, "EcwNe3hodPbgUr4GVZn6Rp547c7vbdxSx6jw9aQfDfXU");
  assert.equal(bump, 255);
});

test("deriveFeeAuthorityPda derives the known devnet PDA-3", async () => {
  const [pda, bump] = await deriveFeeAuthorityPda(PROGRAM_ID, DDC_MINT);
  assert.equal(pda, "48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu");
  assert.equal(bump, 255);
});
