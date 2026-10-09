// PURE decoder for the authority set of a Token-2022 mint, read by `state`
// beside the program's record: the base mint's mint and Freeze Authorities,
// every extension present, the Confidential Transfer settings and authority,
// the Confidential Transfer fee authority and the withheld-fee ElGamal public
// key, and the metadata pointer and on-mint token metadata with their
// authorities. Bytes in, typed values out, named throws; a sibling of
// mint-transfer-fee.ts, which keeps the fee schedule.
//
// Layout (Token-2022): base mint 82 bytes -- mint_authority COption (u32 tag
// at 0, key at 4), supply u64 at 36, decimals at 44, is_initialized at 45,
// freeze_authority COption (u32 tag at 46, key at 50) -- padded to 165,
// account_type at 165, TLV entries from 166 as (u16 LE type, u16 LE length,
// value). An optional key inside an extension is 32 bytes, all zero for none.

import { getAddressDecoder, getU16Decoder, getU32Decoder, type Address } from "@solana/kit";

const BASE_MINT_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;
const ACCOUNT_TYPE_MINT = 1;

/** Token-2022's ExtensionType numbering, in declaration order. */
export const EXTENSION_NAMES: readonly string[] = [
  "Uninitialized", "TransferFeeConfig", "TransferFeeAmount", "MintCloseAuthority",
  "ConfidentialTransferMint", "ConfidentialTransferAccount", "DefaultAccountState",
  "ImmutableOwner", "MemoTransfer", "NonTransferable", "InterestBearingConfig",
  "CpiGuard", "PermanentDelegate", "NonTransferableAccount", "TransferHook",
  "TransferHookAccount", "ConfidentialTransferFeeConfig", "ConfidentialTransferFeeAmount",
  "MetadataPointer", "TokenMetadata", "GroupPointer", "TokenGroup", "GroupMemberPointer",
  "TokenGroupMember", "ConfidentialMintBurn", "ScaledUiAmount", "Pausable",
  "PausableAccount", "PermissionedBurn",
];

const CONFIDENTIAL_TRANSFER_MINT = 4;
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16;
const METADATA_POINTER = 18;
const TOKEN_METADATA = 19;

export interface MintAuthorities {
  readonly mintAuthority: Address | null;
  readonly freezeAuthority: Address | null;
  readonly extensions: readonly number[];
  readonly confidentialTransfer:
    | { readonly authority: Address | null; readonly autoApprove: boolean; readonly auditorKey: string | null }
    | null;
  readonly confidentialTransferFeeAuthority: Address | null | undefined;
  /** The withheld-fee ElGamal public key, base64; undefined without the extension. */
  readonly withheldFeeKey: string | undefined;
  readonly metadataPointer: { readonly authority: Address | null; readonly metadataAddress: Address | null } | null;
  readonly tokenMetadata:
    | { readonly updateAuthority: Address | null; readonly name: string; readonly symbol: string; readonly uri: string }
    | null;
}

export function extensionName(type: number): string {
  return EXTENSION_NAMES[type] ?? `type ${type}`;
}

function key(bytes: Uint8Array): Address {
  return getAddressDecoder().decode(bytes);
}

function optionalKey(bytes: Uint8Array): Address | null {
  return bytes.every((b) => b === 0) ? null : key(bytes);
}

function cOptionKey(bytes: Uint8Array, at: number): Address | null {
  const tag = getU32Decoder().decode(bytes.subarray(at, at + 4));
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(`mint COption tag at offset ${at} is ${tag}, neither 0 nor 1`);
  return key(bytes.subarray(at + 4, at + 36));
}

function requireLength(name: string, value: Uint8Array, min: number): void {
  if (value.length < min) {
    throw new Error(`mint ${name} extension is ${value.length} bytes, shorter than the ${min} it must hold`);
  }
}

function borshString(value: Uint8Array, at: number, field: string): { text: string; next: number } {
  if (at + 4 > value.length) throw new Error(`token metadata ${field} length overruns the extension`);
  const len = getU32Decoder().decode(value.subarray(at, at + 4));
  const end = at + 4 + len;
  if (end > value.length) throw new Error(`token metadata ${field} overruns the extension (${end} > ${value.length})`);
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(at + 4, end)), next: end };
}

/** Pure: the authority set of a Token-2022 mint account's data. */
export function decodeMintAuthorities(mintBytes: Uint8Array): MintAuthorities {
  if (mintBytes.length < BASE_MINT_LEN) {
    throw new Error(`mint account data is ${mintBytes.length} bytes, shorter than the ${BASE_MINT_LEN}-byte base mint`);
  }
  const mintAuthority = cOptionKey(mintBytes, 0);
  const freezeAuthority = cOptionKey(mintBytes, 46);
  const extensions: number[] = [];
  let confidentialTransfer: MintAuthorities["confidentialTransfer"] = null;
  let confidentialTransferFeeAuthority: Address | null | undefined = undefined;
  let withheldFeeKey: string | undefined = undefined;
  let metadataPointer: MintAuthorities["metadataPointer"] = null;
  let tokenMetadata: MintAuthorities["tokenMetadata"] = null;

  if (mintBytes.length > TLV_START) {
    if (mintBytes[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
      throw new Error(`account type byte at ${ACCOUNT_TYPE_OFFSET} is ${mintBytes[ACCOUNT_TYPE_OFFSET]}, not a mint (${ACCOUNT_TYPE_MINT})`);
    }
    let offset = TLV_START;
    while (offset + 4 <= mintBytes.length) {
      const type = getU16Decoder().decode(mintBytes.subarray(offset, offset + 2));
      if (type === 0) break; // Uninitialized: the end of the TLV region.
      const len = getU16Decoder().decode(mintBytes.subarray(offset + 2, offset + 4));
      const start = offset + 4;
      const end = start + len;
      if (end > mintBytes.length) {
        throw new Error(`mint TLV entry type ${type} at offset ${offset} overruns the account data (${end} > ${mintBytes.length})`);
      }
      const value = mintBytes.subarray(start, end);
      extensions.push(type);
      if (type === CONFIDENTIAL_TRANSFER_MINT) {
        requireLength("ConfidentialTransferMint", value, 65);
        const auditor = value.subarray(33, 65);
        confidentialTransfer = {
          authority: optionalKey(value.subarray(0, 32)),
          autoApprove: value[32] !== 0,
          auditorKey: auditor.every((b) => b === 0) ? null : Buffer.from(auditor).toString("base64"),
        };
      } else if (type === CONFIDENTIAL_TRANSFER_FEE_CONFIG) {
        requireLength("ConfidentialTransferFeeConfig", value, 64);
        confidentialTransferFeeAuthority = optionalKey(value.subarray(0, 32));
        withheldFeeKey = Buffer.from(value.subarray(32, 64)).toString("base64");
      } else if (type === METADATA_POINTER) {
        requireLength("MetadataPointer", value, 64);
        metadataPointer = {
          authority: optionalKey(value.subarray(0, 32)),
          metadataAddress: optionalKey(value.subarray(32, 64)),
        };
      } else if (type === TOKEN_METADATA) {
        requireLength("TokenMetadata", value, 64);
        const name = borshString(value, 64, "name");
        const symbol = borshString(value, name.next, "symbol");
        const uri = borshString(value, symbol.next, "uri");
        tokenMetadata = {
          updateAuthority: optionalKey(value.subarray(0, 32)),
          name: name.text,
          symbol: symbol.text,
          uri: uri.text,
        };
      }
      offset = end;
    }
  }
  return {
    mintAuthority,
    freezeAuthority,
    extensions,
    confidentialTransfer,
    confidentialTransferFeeAuthority,
    withheldFeeKey,
    metadataPointer,
    tokenMetadata,
  };
}

/** Pure: the `state` lines for the mint's authority set, labels padded as `state` pads them. */
export function formatMintAuthorityLines(
  m: MintAuthorities,
  expect: { readonly mint: Address; readonly mintStatePda: Address },
): string[] {
  const none = "none";
  const lines: string[] = [];
  lines.push(
    `mintAuthority  : ${m.mintAuthority ?? none}` +
      (m.mintAuthority === expect.mintStatePda ? " (the program's PDA-1)" : " (NOT the program's PDA-1)"),
  );
  lines.push(`freezeAuth     : ${m.freezeAuthority ?? `${none} (no account can be frozen)`}`);
  lines.push(`extensions     : ${m.extensions.map(extensionName).join(", ")} (${m.extensions.length})`);
  const ct = m.confidentialTransfer;
  if (ct === null) {
    lines.push("ctAuthority    : no ConfidentialTransferMint extension");
  } else {
    lines.push(
      `ctAuthority    : ${ct.authority ?? none}` +
        (ct.authority === null
          ? " (automatic approval and the auditor key below are permanent)"
          : " (can change automatic approval and the auditor key below)"),
    );
    lines.push(`ctAutoApprove  : ${ct.autoApprove}`);
    lines.push(`ctAuditorKey   : ${ct.auditorKey ?? none}`);
  }
  lines.push(
    `ctFeeAuthority : ${
      m.confidentialTransferFeeAuthority === undefined
        ? "no ConfidentialTransferFeeConfig extension"
        : (m.confidentialTransferFeeAuthority ?? none)
    }`,
  );
  lines.push(
    m.withheldFeeKey === undefined
      ? "withheldFeeKey : no ConfidentialTransferFeeConfig extension"
      : `withheldFeeKey : ${m.withheldFeeKey} (ElGamal public key fixed at genesis; its secret decrypts the fee of each confidential transfer)`,
  );
  const mp = m.metadataPointer;
  lines.push(
    mp === null
      ? "mdPointerAuth  : no MetadataPointer extension"
      : `mdPointerAuth  : ${mp.authority ?? none} (metadata at ${mp.metadataAddress ?? none}` +
          (mp.metadataAddress === expect.mint ? ", the mint itself)" : ")"),
  );
  const tm = m.tokenMetadata;
  if (tm === null) {
    lines.push("mdUpdateAuth   : no TokenMetadata extension");
  } else {
    lines.push(`mdUpdateAuth   : ${tm.updateAuthority ?? `${none} (metadata is permanent)`}`);
    lines.push(`metadata       : name ${JSON.stringify(tm.name)}, symbol ${JSON.stringify(tm.symbol)}, uri ${JSON.stringify(tm.uri)}`);
  }
  return lines;
}
