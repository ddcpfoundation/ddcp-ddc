// Offline tests for the pure pieces of `ddc setup-privacy`.
// Per the suite convention, nothing here calls the run* entry function; its
// entry ordering and its two pre-identity refusals are in
// entry-ordering.test.ts. The devnet run proves the send path.
// The readActivationState test and its account fixtures moved to
// confidential-account.test.ts when that module took over the activation read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import {
  CONSENT_VALUE,
  formatConsentBlock,
  parseConsentFlag,
} from "./setup-privacy.js";

const WALLET = address("Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax");
const ATA = address("3q84mCciN6dXksJymBVHKJqmpZYSM3BTZVysWGGK1bdm");

test("parseConsentFlag: absent is not consent; the exact value is; a bare flag and any other value are the usage error naming the value", () => {
  assert.equal(parseConsentFlag(undefined), false);
  assert.equal(parseConsentFlag(CONSENT_VALUE), true);
  assert.throws(() => parseConsentFlag(true), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /usage — setup-privacy/);
    assert.match(err.message, /got no value/);
    return true;
  });
  assert.throws(() => parseConsentFlag("on"), /got "on"/);
  assert.throws(() => parseConsentFlag("yes"), /got "yes"/);
});

test("formatConsentBlock: carries the two consent grounds and the four instructions, and never claims the key is unrecoverable", () => {
  const block = formatConsentBlock({
    cluster: "https://example.invalid/rpc",
    wallet: WALLET,
    tokenAccount: ATA,
    state: { kind: "absent" },
  });
  assert.match(block, /NO separate backup/);
  assert.match(block, /not casually reversible/);
  assert.match(block, /viewing/);
  assert.match(block, /1\. CreateAssociatedTokenIdempotent/);
  assert.match(block, /2\. Reallocate for extension types 5 and 17/);
  assert.match(block, /3\. ConfigureAccount \(pending-credit cap 65536, proof at \+1\)/);
  assert.match(block, /4\. VerifyPubkeyValidity/);
  assert.match(block, new RegExp(ATA));
  assert.match(block, /does not exist yet/);
  assert.doesNotMatch(block, /unrecoverable|cannot be recovered|no recovery/);
  const existing = formatConsentBlock({
    cluster: "https://example.invalid/rpc",
    wallet: WALLET,
    tokenAccount: ATA,
    state: { kind: "unconfigured" },
  });
  assert.match(existing, /exists, Confidential Balances not yet activated/);
});
