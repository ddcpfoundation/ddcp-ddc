// The positional-argument parser both transfer commands share: exactly two
// positionals, a decimal amount then a recipient WALLET address, validated
// before --keypair is read. The command supplies its own usage line and word,
// so every message names the command the holder typed.
//
// PLACEMENT IS FLAT, beside transfer-refusals.ts, and never in a command
// file: a command file would become a library of the next command.
//
// THE OFF-CURVE REFUSAL LANDS HERE, ONCE. The reference client sends only to
// key-held wallets. An off-curve address given as a recipient is either a
// token account pasted where a wallet belongs -- every associated token
// account is program-derived and so off-curve -- or a program-controlled
// wallet this client does not serve. The check is isOffCurveAddress of the
// pinned @solana/kit; it adds no dependency.
import { address, isOffCurveAddress, type Address } from "@solana/kit";
import { parseDdcAmount } from "./amount.js";
import { formatNotAnAddressRefusal, formatNotAWalletRefusal } from "./transfer-refusals.js";

export interface TransferArgsShape {
  /** The command's usage line, prepended to every usage error. */
  usage: string;
  /** The command's word, named in the arity error. */
  command: string;
}

export function parseTransferPositionals(
  positionals: readonly string[],
  shape: TransferArgsShape,
): { netBaseUnits: bigint; recipient: Address } {
  if (positionals.length !== 2) {
    throw new Error(
      shape.usage + "\n" + shape.command + " takes exactly one amount and one recipient wallet address; got " + positionals.length + " positional arguments",
    );
  }
  const text = positionals[0] as string;
  let netBaseUnits: bigint;
  try {
    netBaseUnits = parseDdcAmount(text);
  } catch (err) {
    throw new Error(shape.usage + "\n" + (err as Error).message);
  }
  if (netBaseUnits === 0n) {
    throw new Error(shape.usage + "\nthe amount must be at least 0.000001 DDC; got " + text);
  }
  const recipientText = positionals[1] as string;
  let recipient: Address;
  try {
    recipient = address(recipientText);
  } catch {
    throw new Error(formatNotAnAddressRefusal(recipientText));
  }
  if (isOffCurveAddress(recipient)) {
    throw new Error(formatNotAWalletRefusal(recipientText));
  }
  return { netBaseUnits, recipient };
}
