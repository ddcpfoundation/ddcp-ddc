#!/usr/bin/env node
// DDC CLI. Two admin shapes: the serialize / countersign / submit
// lifecycle over a durable nonce (five two-party instructions), and the no-envelope
// commands — issuance-pause, publish-reserve-statement, cancel, state. User commands:
// setup-privacy, balance, apply-pending, shield, unshield, confidential-transfer,
// public-transfer.
//
// DISPATCH IS A PURE RESOLVER: `resolveCommand` maps the argument vector to
// a command shape or to the unrecognized word, and is pinned in
// index.test.ts without spawning the binary. Bare `ddc` is a request for
// help (banner and list, exit 0); an unrecognized first word, or `admin`
// followed by an unrecognized second word, or `admin` alone, refuses BY
// NAME, then prints the banner and list, exit 2. The refusal names the
// command, never the currency or the binary.

import { runState } from "./commands/state.js";
import { runAdminSerialize } from "./commands/admin-serialize.js";
import { runAdminCountersign } from "./commands/admin-countersign.js";
import { runAdminSubmit } from "./commands/admin-submit.js";
import { runAdminPause } from "./commands/admin-pause.js";
import { runAdminPublishReserveStatement } from "./commands/admin-publish-reserve-statement.js";
import { runAdminCancel } from "./commands/admin-cancel.js";
import { runSetupPrivacy } from "./commands/setup-privacy.js";
import { runBalance } from "./commands/balance.js";
import { runApplyPending } from "./commands/apply-pending.js";
import { runShield } from "./commands/shield.js";
import { runUnshield } from "./commands/unshield.js";
import { runConfidentialTransfer } from "./commands/confidential-transfer.js";
import { runPublicTransfer } from "./commands/public-transfer.js";
import { PROXY_CHILD_MARKER, decideProxy, relaunchThroughProxy } from "./proxy.js";
import { formatNetworkFailure, readTransportFailure } from "./network-failure.js";
import { formatSendFailure, readSendFailure } from "./send-failure.js";
import { broadcastRecord } from "./tx/broadcast.js";
import { formatUnrecognizedFailure, type CommandOutcome } from "./exit-status.js";

export const VERSION = "0.1.0";

export function banner(): string {
  return `ddc ${VERSION}`;
}

export const COMMAND_LIST =
  "commands: state, setup-privacy, balance, apply-pending, shield, unshield, confidential-transfer, public-transfer, admin serialize mint|burn|resume|update-fee|rotate, admin countersign, admin submit, admin issuance-pause, admin publish-reserve-statement, admin cancel issuer|operator";

export const USER_COMMANDS = ["state", "setup-privacy", "balance", "apply-pending", "shield", "unshield", "confidential-transfer", "public-transfer"] as const;
export const ADMIN_SUBCOMMANDS = ["serialize", "countersign", "submit", "issuance-pause", "publish-reserve-statement", "cancel"] as const;

export type ResolvedCommand =
  | { kind: "help" }
  | { kind: "user"; name: (typeof USER_COMMANDS)[number] }
  | { kind: "admin"; name: (typeof ADMIN_SUBCOMMANDS)[number] }
  | { kind: "unknown"; word: string }
  | { kind: "unknown-admin"; word: string }
  | { kind: "admin-missing" };

/** Pure: the argument vector after the binary name, to the shape main dispatches on. */
export function resolveCommand(args: readonly string[]): ResolvedCommand {
  const first = args[0];
  if (first === undefined) return { kind: "help" };
  if (first === "admin") {
    const second = args[1];
    if (second === undefined) return { kind: "admin-missing" };
    const admin = ADMIN_SUBCOMMANDS.find((n) => n === second);
    return admin === undefined ? { kind: "unknown-admin", word: second } : { kind: "admin", name: admin };
  }
  const user = USER_COMMANDS.find((n) => n === first);
  return user === undefined ? { kind: "unknown", word: first } : { kind: "user", name: user };
}

/** Pure: the one refusal line printed before the banner on the three exit-2 shapes. */
export function formatUnknownCommand(resolved: ResolvedCommand): string | undefined {
  switch (resolved.kind) {
    case "unknown":
      return `unknown command "${resolved.word}"`;
    case "unknown-admin":
      return `unknown admin command "${resolved.word}"`;
    case "admin-missing":
      return `admin needs a subcommand: ${ADMIN_SUBCOMMANDS.join(", ")}`;
    default:
      return undefined;
  }
}

/** A command that resolves to EXIT_NOT_DONE stopped short of its purpose (exit-status.ts). */
function settle(outcome: CommandOutcome): void {
  if (outcome !== undefined) process.exitCode = outcome;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resolved = resolveCommand(args);
  // PROXY GATE. Every command that can reach the network passes through it
  // BEFORE it runs; help and the unknown-word refusals never touch the network
  // and are left alone. The switch that makes Node use a proxy is read at
  // process start only, so a configured proxy means ONE re-launch of this
  // entry with the switch set; the child lands here again, finds its
  // environment exact, and proceeds.
  if (resolved.kind === "user" || resolved.kind === "admin") {
    const decision = decideProxy(args, process.env);
    if (decision.kind === "refuse") {
      console.error(decision.message);
      process.exitCode = 2;
      return;
    }
    if (decision.kind === "relaunch") {
      console.log(decision.disclosure);
      const entry = process.argv[1];
      if (entry === undefined) {
        console.error("REFUSED: the entry path is not known to this process, so it cannot be re-launched through the proxy. Nothing was sent.");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await relaunchThroughProxy(
        [...process.execArgv, entry, ...args],
        decision.env,
      );
      return;
    }
  }
  if (resolved.kind === "user") {
    switch (resolved.name) {
      case "state":
        await runState(args);
        return;
      case "setup-privacy":
        settle(await runSetupPrivacy(args));
        return;
      case "balance":
        await runBalance(args);
        return;
      case "apply-pending":
        await runApplyPending(args);
        return;
      case "shield":
        settle(await runShield(args));
        return;
      case "unshield":
        settle(await runUnshield(args));
        return;
      case "confidential-transfer":
        settle(await runConfidentialTransfer(args));
        return;
      case "public-transfer":
        settle(await runPublicTransfer(args));
        return;
      default: {
        // Exhaustive: a USER_COMMANDS member with no case above is a compile error here.
        const unhandled: never = resolved;
        throw new Error(`user command without a dispatch case: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  if (resolved.kind === "admin") {
    switch (resolved.name) {
      case "serialize":
        await runAdminSerialize(args);
        return;
      case "countersign":
        await runAdminCountersign(args);
        return;
      case "submit":
        await runAdminSubmit(args);
        return;
      case "issuance-pause":
        await runAdminPause(args);
        return;
      case "publish-reserve-statement":
        settle(await runAdminPublishReserveStatement(args));
        return;
      case "cancel":
        await runAdminCancel(args);
        return;
      default: {
        // Exhaustive: an ADMIN_SUBCOMMANDS member with no case above is a compile error here.
        const unhandled: never = resolved;
        throw new Error(`admin command without a dispatch case: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  const refusal = formatUnknownCommand(resolved);
  if (refusal !== undefined) {
    console.log(refusal);
    process.exitCode = 2;
  }
  console.log(banner());
  console.log(COMMAND_LIST);
}

// ENTRY GUARD. Run main only when this module is the process entry point,
// never when imported (e.g. by a test). The guard is `import.meta.main`,
// which Node sets from the module graph: it holds through the `bin` symlink
// and any symlinked path component, where the former string comparison
// `process.argv[1] === fileURLToPath(import.meta.url)` was false because Node
// realpaths the entry point and leaves argv[1] as typed, so the binary exited
// 0 printing nothing. On a Node without `import.meta.main` (before 24.2) the
// value is undefined: refuse LOUDLY, exit 2, rather than silently never run.
// index-entry.test.ts spawns the built entry through a symlink and pins all
// three shapes.
const entryMain: boolean | undefined = (import.meta as { main?: boolean }).main;
if (entryMain === undefined) {
  console.error("ddc: this Node provides no import.meta.main; Node 24.2 or later is required");
  process.exit(2);
}
if (entryMain) {
  try {
    await main();
  } catch (err) {
    // NETWORK FAILURE (network-failure.ts) and SEND FAILURE (send-failure.ts):
    // a transport failure, a preflight refusal, an on-chain failure or an
    // exhausted confirmation poll prints a sentence naming cause, risk and
    // action instead of a stack. Every other error is a refusal a command
    // threw: its sentence is printed alone, never a stack or a source line,
    // and the exit status is 1 (exit-status.ts).
    const failure = readTransportFailure(err);
    if (failure !== undefined) {
      console.error(formatNetworkFailure(failure, process.env[PROXY_CHILD_MARKER], broadcastRecord));
      process.exitCode = 1;
    } else {
      const send = readSendFailure(err);
      console.error(send === undefined ? formatUnrecognizedFailure(err) : formatSendFailure(send));
      process.exitCode = 1;
    }
  }
}
