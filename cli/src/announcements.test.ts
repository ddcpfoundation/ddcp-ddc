// Pins the one line the announcements module holds. The sentence is fixed
// verbatim; commands/apply-pending.test.ts asserts it again through the
// apply announcement, and commands/shield.test.ts through the shield
// announcement, so a change fails by name here and by position there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORK_FEE_LINE } from "./announcements.js";

test("NETWORK_FEE_LINE: the fixed fee sentence verbatim, with its two conditions in the text", () => {
  assert.equal(
    NETWORK_FEE_LINE,
    "network fee : less than 0.00002 SOL (base signature fee, paid by this wallet)",
  );
  assert.match(NETWORK_FEE_LINE, /less than/);
  assert.match(NETWORK_FEE_LINE, /paid by this wallet/);
});
