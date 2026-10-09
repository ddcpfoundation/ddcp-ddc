// Effective-settings resolution for the CLI: CLI flags > config file >
// constants defaults. The `source` map records where each value came from
// so commands can show when they are aimed at an overridden target.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { address, type Address, type Commitment } from "@solana/kit";
import {
  COMMITMENT,
  DDC_MINT,
  DEVNET_RPC_URL,
  PROGRAM_ID,
} from "./constants.js";
import type { Role } from "./role-guard.js";

export type ConfigSource = "flag" | "file" | "default";

export interface ResolvedConfig {
  rpcUrl: string;
  commitment: Commitment;
  programId: Address;
  mint: Address;
  // Signing identity, FLAG-ONLY (never config-file, never defaulted): absent
  // flags stay undefined, so read-only commands are unaffected.
  keypair?: string;
  role?: Role;
  source: { rpcUrl: ConfigSource; mint: ConfigSource; program: ConfigSource };
}

// Recognized config-file keys (JSON object): rpc_url (naming), the
// devnet-tooling overrides mint and program, and proxy, which is read by
// proxy.ts at the entry point and by nothing here. Unknown keys are ignored.
export interface ConfigFile {
  rpc_url?: string;
  mint?: string;
  program?: string;
  proxy?: string;
}

// The config file a given argument vector names: --config <path>, else the
// default. resolveConfig computes the same path; this exists so the entry
// point can read the proxy setting before any command runs.
export function resolveConfigPath(argv: string[]): string {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" } },
    strict: false,
  });
  const flagConfig =
    typeof values["config"] === "string" ? values["config"] : undefined;
  return flagConfig ?? join(homedir(), ".ddc", "config.json");
}

export function loadConfigFile(path: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Absent file: silently fall through to defaults.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed JSON in config file ${path}: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must contain a JSON object`);
  }
  for (const key of ["rpc_url", "mint", "program", "proxy"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Config file ${path}: "${key}" must be a string`);
    }
  }
  return parsed as ConfigFile;
}

function parseAddressOrThrow(value: string, label: string): Address {
  try {
    return address(value);
  } catch {
    throw new Error(`Invalid ${label}: "${value}" is not a valid address`);
  }
}

// The Role type (role-guard.ts) is the single source of truth for the three
// role values; this list must match it exactly — `satisfies` turns any drift
// into a compile error.
const ROLE_FLAG_VALUES = [
  "issuer",
  "operator",
  "reserve",
] as const satisfies readonly Role[];

function parseRoleOrThrow(value: string): Role {
  const match = ROLE_FLAG_VALUES.find((r) => r === value);
  if (match === undefined) {
    throw new Error(
      `Invalid --role: "${value}" — must be exactly one of "issuer", "operator", "reserve"`,
    );
  }
  return match;
}

export function resolveConfig(argv: string[]): ResolvedConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      "rpc-url": { type: "string" },
      config: { type: "string" },
      mint: { type: "string" },
      program: { type: "string" },
      keypair: { type: "string" },
      role: { type: "string" },
    },
    // Future commands add their own flags; extras and positionals are
    // ignored here rather than rejected.
    strict: false,
  });

  const flagRpc =
    typeof values["rpc-url"] === "string" ? values["rpc-url"] : undefined;
  const flagMint = typeof values["mint"] === "string" ? values["mint"] : undefined;
  const flagProgram =
    typeof values["program"] === "string" ? values["program"] : undefined;
  const flagConfig =
    typeof values["config"] === "string" ? values["config"] : undefined;

  // --keypair/--role are FLAG-ONLY by deliberate safety choice: a signing
  // identity must be stated explicitly on every invocation — never silently
  // defaulted and never read from a config file.
  const flagKeypair =
    typeof values["keypair"] === "string" ? values["keypair"] : undefined;
  const flagRole =
    typeof values["role"] === "string" ? values["role"] : undefined;
  const role = flagRole !== undefined ? parseRoleOrThrow(flagRole) : undefined;

  const configPath = flagConfig ?? join(homedir(), ".ddc", "config.json");
  const file = loadConfigFile(configPath);

  const rpcUrl = flagRpc ?? file.rpc_url ?? DEVNET_RPC_URL;
  const rpcSource: ConfigSource =
    flagRpc !== undefined ? "flag" : file.rpc_url !== undefined ? "file" : "default";

  const mint =
    flagMint !== undefined
      ? parseAddressOrThrow(flagMint, "--mint")
      : file.mint !== undefined
        ? parseAddressOrThrow(file.mint, 'config "mint"')
        : DDC_MINT;
  const mintSource: ConfigSource =
    flagMint !== undefined ? "flag" : file.mint !== undefined ? "file" : "default";

  const programId =
    flagProgram !== undefined
      ? parseAddressOrThrow(flagProgram, "--program")
      : file.program !== undefined
        ? parseAddressOrThrow(file.program, 'config "program"')
        : PROGRAM_ID;
  const programSource: ConfigSource =
    flagProgram !== undefined
      ? "flag"
      : file.program !== undefined
        ? "file"
        : "default";

  return {
    rpcUrl,
    commitment: COMMITMENT,
    programId,
    mint,
    keypair: flagKeypair,
    role,
    source: { rpcUrl: rpcSource, mint: mintSource, program: programSource },
  };
}

/**
 * The signing plumbing's consumption contract: a command that signs calls
 * this to obtain the operator's explicitly stated identity; read-only
 * commands never call it. Consumed by the admin signing commands, which
 * pair it with a live PDA-1 read and the role guard.
 */
export function requireSigningIdentity(config: ResolvedConfig): {
  keypairPath: string;
  role: Role;
} {
  if (config.keypair === undefined) {
    throw new Error(
      "--keypair is required for signing: state the keypair file path explicitly",
    );
  }
  if (config.role === undefined) {
    throw new Error(
      '--role is required for signing: state one of "issuer", "operator", "reserve" explicitly',
    );
  }
  return { keypairPath: config.keypair, role: config.role };
}

/**
 * The USER-command consumption contract: a wallet holder states ONE secret —
 * the keypair file — and no role. `--role` names which of the three on-chain
 * admin authorities a signer claims to be, and a wallet holder is none of
 * them, so the flag is refused BY NAME rather than silently ignored: a
 * person who typed it must know which characters to remove. Consumed by
 * every user command that signs or derives: setup-privacy, balance,
 * apply-pending, shield, unshield, confidential-transfer and
 * public-transfer.
 *
 * KNOWN GAP: an INVALID role value (e.g. `--role wallet`) never reaches
 * here. parseRoleOrThrow inside resolveConfig rejects it first, with the
 * admin message naming issuer/operator/reserve. Closing that would mean changing
 * resolveConfig, which all five admin signing commands call first; accepted
 * as a wording cost rather than a change to shared code.
 */
export function requireWalletIdentity(config: ResolvedConfig): {
  keypairPath: string;
} {
  if (config.role !== undefined) {
    throw new Error(
      '--role does not apply to this command: it names one of the three on-chain admin authorities ("issuer", "operator", "reserve"), and a wallet holder is none of them. Remove --role and state --keypair only.',
    );
  }
  if (config.keypair === undefined) {
    throw new Error(
      "--keypair is required for signing: state the keypair file path explicitly",
    );
  }
  return { keypairPath: config.keypair };
}

/**
 * The target-disclosure block: resolved cluster, mint and program, each
 * annotated with where the value came from. Printed at the head of the
 * inspection output of every command that signs or broadcasts, so the
 * operator's last checkpoint before approving names the target. Wording is
 * identical to the block commands/state.ts prints inline.
 */
export function formatTargetBlock(config: ResolvedConfig): string {
  return [
    `TARGET cluster : ${config.rpcUrl} (${config.source.rpcUrl})`,
    `TARGET mint    : ${config.mint} (${config.source.mint})`,
    `TARGET program : ${config.programId} (${config.source.program})`,
  ].join("\n");
}

/**
 * Cluster guard: refuse to send when the cluster was never stated and the
 * devnet default silently applied. Called AFTER the target block has printed,
 * so the operator sees what they were about to do before being refused.
 * Admin callers run it on the --broadcast path only. A user command that
 * sends WITHOUT --broadcast (setup-privacy) runs it before its
 * consent prompt, and names in `action` what requires the stated cluster so
 * the refusal never mentions a flag the command does not have. The default
 * keeps the admin wording: the six admin callers are untouched. INSPECT-mode
 * and read-only invocations are unaffected and keep working on the default.
 */
export function requireStatedCluster(
  config: ResolvedConfig,
  action: string = "--broadcast",
): void {
  if (config.source.rpcUrl === "default") {
    throw new Error(
      `${action} requires an explicitly stated cluster: the target must not be a silent default. ` +
        `Pass --rpc-url <url>, or set "rpc_url" in ${join(homedir(), ".ddc", "config.json")} (or a file named with --config).`,
    );
  }
}
