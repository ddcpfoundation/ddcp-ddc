// Entry-ordering regression tests.
//
// CONVENTION EXCEPTION, DELIBERATE: every other test in this suite exercises
// small pure helpers and never calls a command's run* entry function — see the
// header of admin-publish-reserve-statement.test.ts. These DO call the entry
// functions, because the property under test is the ORDER of the checks at the
// top of those functions. That order exists nowhere else and is invisible to a
// helper-level test.
//
// These tests stay offline: with the shape check first, a wrongly-shaped
// invocation is refused before createRpc is ever reached. If a future change
// puts network work ahead of the shape check, these tests fail loudly rather
// than silently going online.
//
// Each test asserts BOTH halves of the property: the usage message IS what
// surfaces, and the signing-identity error is NOT.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdminCancel } from "./admin-cancel.js";
import { runAdminCountersign } from "./admin-countersign.js";
import { runAdminPublishReserveStatement } from "./admin-publish-reserve-statement.js";
import { runAdminSerialize } from "./admin-serialize.js";
import { runApplyPending } from "./apply-pending.js";
import { runBalance } from "./balance.js";
import { runShield } from "./shield.js";
import { runUnshield, UNSHIELD_OPERATION } from "./unshield.js";
import { runConfidentialTransfer, CONFIDENTIAL_TRANSFER_OPERATION } from "./confidential-transfer.js";
import { runPublicTransfer, PUBLIC_TRANSFER_OPERATION } from "./public-transfer.js";
import { CONSENT_FLAG, CONSENT_VALUE, runSetupPrivacy } from "./setup-privacy.js";

// A --config path that never exists: forces the absent-file branch of
// resolveConfig, so a real ~/.ddc/config.json cannot influence the result.
const MISSING_CONFIG = join(
  tmpdir(),
  "ddc-entry-ordering-no-such-config-file.json",
);

function expectUsageNotIdentity(usage: RegExp): (err: unknown) => boolean {
  return (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, usage);
    assert.doesNotMatch(err.message, /--keypair is required/);
    assert.doesNotMatch(err.message, /--role is required/);
    return true;
  };
}

test("entry ordering: admin cancel with no nonce selector shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runAdminCancel([
        "admin",
        "cancel",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(/usage — admin cancel <issuer\|operator>/),
  );
});

test("entry ordering: admin countersign with no envelope path shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runAdminCountersign([
        "admin",
        "countersign",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(/usage — admin countersign <envelope-path>/),
  );
});

test("entry ordering: admin publish-reserve-statement with no arguments shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runAdminPublishReserveStatement([
        "admin",
        "publish-reserve-statement",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(
      /usage — admin publish-reserve-statement <amount-base-units> <uri>/,
    ),
  );
});

test("entry ordering: admin serialize mint with no arguments shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runAdminSerialize([
        "admin",
        "serialize",
        "mint",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(
      /usage — admin serialize mint <amount-base-units> <destination>/,
    ),
  );
});

// setup-privacy: the first USER command. Three refusals that
// must be reachable before --keypair is ever read: the usage error on a bad
// consent value, the no-keyboard refusal (the keyboard is injected), and the
// silently-defaulted-cluster refusal, which must name this command and never
// --broadcast.
test("entry ordering: setup-privacy with a bad --consent value shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runSetupPrivacy([
        "setup-privacy",
        "--consent",
        "on",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(/usage — setup-privacy --keypair <path>/),
  );
});

test("entry ordering: setup-privacy with no keyboard and no consent flag refuses naming the flag, before the identity error", async () => {
  await assert.rejects(
    () =>
      runSetupPrivacy(["setup-privacy", "--config", MISSING_CONFIG], {
        isKeyboard: () => false,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(CONSENT_FLAG));
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

test("entry ordering: setup-privacy with consent stated refuses a silently defaulted cluster naming setup-privacy, not --broadcast, before the identity error", async () => {
  await assert.rejects(
    () =>
      runSetupPrivacy(
        ["setup-privacy", "--consent", CONSENT_VALUE, "--config", MISSING_CONFIG],
        { isKeyboard: () => false },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^setup-privacy requires an explicitly stated cluster/);
      assert.doesNotMatch(err.message, /--broadcast/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

// balance: shape before identity — the wallet-address
// positional is validated before --keypair is read — and --role is refused
// by name for a user command.
test("entry ordering: balance with an invalid wallet-address positional shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runBalance([
        "balance",
        "not-an-address",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(/usage — balance \[wallet-address\]/),
  );
});

test("entry ordering: balance with --role refuses naming the role flag, not the keypair error", async () => {
  await assert.rejects(
    () =>
      runBalance([
        "balance",
        "--role",
        "issuer",
        "--config",
        MISSING_CONFIG,
      ]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--role does not apply to this command/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

// apply-pending: shape first — this command accepts NO positional
// at all — then the cluster refusal, which names the OPERATION and never
// --broadcast, and only then the identity checks. The third
// test states its cluster so the role refusal is the one that surfaces; without
// it the cluster refusal fires first, which is itself the ordering being pinned.
test("entry ordering: apply-pending with a positional argument shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runApplyPending([
        "apply-pending",
        "Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(/usage — apply-pending --keypair <path>/),
  );
});

test("entry ordering: apply-pending with a silently defaulted cluster refuses naming the operation, not --broadcast, before the identity error", async () => {
  await assert.rejects(
    () => runApplyPending(["apply-pending", "--config", MISSING_CONFIG]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /^applying pending credits \(a signed, fee-paying transaction\) requires an explicitly stated cluster/,
      );
      assert.doesNotMatch(err.message, /--broadcast/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

test("entry ordering: apply-pending with a stated cluster and --role refuses naming the role flag, not the keypair error", async () => {
  await assert.rejects(
    () =>
      runApplyPending([
        "apply-pending",
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--role",
        "issuer",
        "--config",
        MISSING_CONFIG,
      ]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--role does not apply to this command/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

// shield: shape first — a malformed or zero amount shows
// usage, not identity — then the cluster refusal naming the OPERATION and never
// --broadcast, and only then the identity checks, on the apply-pending pattern.
test("entry ordering: shield with a bad amount shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runShield([
        "shield",
        "0",
        "--config",
        MISSING_CONFIG,
      ]),
    expectUsageNotIdentity(/usage — shield <amount>/),
  );
});

test("entry ordering: shield with a silently defaulted cluster refuses naming the operation, not --broadcast, before the identity error", async () => {
  await assert.rejects(
    () => runShield(["shield", "1.5", "--config", MISSING_CONFIG]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /^shielding into your confidential balance \(a signed, fee-paying transaction\) requires an explicitly stated cluster/,
      );
      assert.doesNotMatch(err.message, /--broadcast/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

test("entry ordering: shield with a stated cluster and --role refuses naming the role flag, not the keypair error", async () => {
  await assert.rejects(
    () =>
      runShield([
        "shield",
        "1.5",
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--role",
        "issuer",
        "--config",
        MISSING_CONFIG,
      ]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--role does not apply to this command/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

// unshield: the shield order. Shape first, then the
// target block and the cluster refusal naming the OPERATION and never --broadcast,
// then identity. Its typed-CONFIRM prompt sits far past identity, so no offline
// refusal precedes the cluster check. Each test injects a prompt that throws, so a
// reordering that reached the prompt fails here instead of reading standard input.
const promptMustNotBeReached = async (): Promise<boolean> => {
  throw new Error("the CONFIRM prompt was reached before an entry refusal");
};

test("entry ordering: unshield with a zero amount shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runUnshield(["unshield", "0", "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    expectUsageNotIdentity(/usage — unshield <amount>/),
  );
});

test("entry ordering: unshield with a silently defaulted cluster refuses naming the operation, not --broadcast, before the identity error", async () => {
  await assert.rejects(
    () =>
      runUnshield(["unshield", "1.5", "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.startsWith(`${UNSHIELD_OPERATION} requires an explicitly stated cluster`),
        err.message,
      );
      assert.doesNotMatch(err.message, /--broadcast/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

test("entry ordering: unshield with a stated cluster and --role refuses naming the role flag, not the keypair error", async () => {
  await assert.rejects(
    () =>
      runUnshield(
        [
          "unshield",
          "1.5",
          "--rpc-url",
          "https://api.devnet.solana.com",
          "--role",
          "issuer",
          "--config",
          MISSING_CONFIG,
        ],
        { promptConfirm: promptMustNotBeReached },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--role does not apply to this command/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

// confidential-transfer: the unshield order with one more
// shape refusal. The amount and the recipient are validated before --keypair
// is read, so a bad amount shows usage and an unparseable recipient refuses
// by name, neither reaching identity; then the cluster refusal naming the
// OPERATION and never --broadcast; then identity. The prompt stub throws.
const TRANSFER_RECIPIENT = "Hjvkst46pFJtMnw8APk58i3z2rMmMekLiNQLC93S7rax";
test("entry ordering: confidential-transfer with a zero amount shows usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runConfidentialTransfer(["confidential-transfer", "0", TRANSFER_RECIPIENT, "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    expectUsageNotIdentity(/usage . confidential-transfer <amount> <recipient-wallet>/),
  );
});
test("entry ordering: confidential-transfer with a recipient that is not an address refuses by name, not the identity error", async () => {
  await assert.rejects(
    () =>
      runConfidentialTransfer(["confidential-transfer", "1.5", "not-an-address", "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /not-an-address is not a Solana wallet address\. Nothing was sent and no fee was paid\.$/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      assert.doesNotMatch(err.message, /usage/);
      return true;
    },
  );
});
test("entry ordering: confidential-transfer with a silently defaulted cluster refuses naming the operation, not --broadcast, before the identity error", async () => {
  await assert.rejects(
    () =>
      runConfidentialTransfer(["confidential-transfer", "1.5", TRANSFER_RECIPIENT, "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.startsWith(CONFIDENTIAL_TRANSFER_OPERATION + " requires an explicitly stated cluster"),
        err.message,
      );
      assert.doesNotMatch(err.message, /--broadcast/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});
test("entry ordering: confidential-transfer with a stated cluster and --role refuses naming the role flag, not the keypair error", async () => {
  await assert.rejects(
    () =>
      runConfidentialTransfer(
        [
          "confidential-transfer",
          "1.5",
          TRANSFER_RECIPIENT,
          "--rpc-url",
          "https://api.devnet.solana.com",
          "--role",
          "issuer",
          "--config",
          MISSING_CONFIG,
        ],
        { promptConfirm: promptMustNotBeReached },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--role does not apply to this command/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});

// public-transfer: the confidential-transfer order exactly.
// The off-curve refusal is a SHAPE refusal in both commands,
// reached before the cluster guard and before identity. The off-curve address
// is the devnet PDA-1 of record, program-derived by construction.
const OFF_CURVE_RECIPIENT = "4z8svPXAiChauUJDFcB9DPL4srZpL78TGn8FGSLym1D8";
test("entry ordering: public-transfer with a zero amount shows its own usage, not the identity error", async () => {
  await assert.rejects(
    () =>
      runPublicTransfer(["public-transfer", "0", TRANSFER_RECIPIENT, "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    expectUsageNotIdentity(/usage . public-transfer <amount> <recipient-wallet>/),
  );
});
test("entry ordering: both transfer commands refuse an off-curve recipient by name before the cluster guard and before identity", async () => {
  const runs = [
    () => runPublicTransfer(["public-transfer", "1.5", OFF_CURVE_RECIPIENT, "--config", MISSING_CONFIG], { promptConfirm: promptMustNotBeReached }),
    () => runConfidentialTransfer(["confidential-transfer", "1.5", OFF_CURVE_RECIPIENT, "--config", MISSING_CONFIG], { promptConfirm: promptMustNotBeReached }),
  ];
  for (const run of runs) {
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /4z8svPXAiChauUJDFcB9DPL4srZpL78TGn8FGSLym1D8 is not a wallet address\. /);
      assert.match(err.message, /Ask the recipient for their correct wallet address\.$/);
      assert.doesNotMatch(err.message, /requires an explicitly stated cluster/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    });
  }
});
test("entry ordering: public-transfer with a silently defaulted cluster refuses naming the operation, not --broadcast, before the identity error", async () => {
  await assert.rejects(
    () =>
      runPublicTransfer(["public-transfer", "1.5", TRANSFER_RECIPIENT, "--config", MISSING_CONFIG], {
        promptConfirm: promptMustNotBeReached,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith(PUBLIC_TRANSFER_OPERATION + " requires an explicitly stated cluster"), err.message);
      assert.doesNotMatch(err.message, /--broadcast/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});
test("entry ordering: public-transfer with a stated cluster and --role refuses naming the role flag, not the keypair error", async () => {
  await assert.rejects(
    () =>
      runPublicTransfer(
        ["public-transfer", "1.5", TRANSFER_RECIPIENT, "--rpc-url", "https://api.devnet.solana.com", "--role", "issuer", "--config", MISSING_CONFIG],
        { promptConfirm: promptMustNotBeReached },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--role does not apply to this command/);
      assert.doesNotMatch(err.message, /--keypair is required/);
      return true;
    },
  );
});
