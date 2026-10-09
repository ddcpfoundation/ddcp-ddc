// PURE Token-2022 mint TransferFeeConfig decoder. Reads the
// NEWER transfer fee (bps + maximum) from the mint account's TLV region.
// Mirrors mint-state.ts's shape: pure bytes in, typed values out, named
// throws. Token-2022 layout: base mint (82) padded to 165, account_type at
// 165, TLV entries from 166 as (u16 LE type, u16 LE len, value). The
// TransferFeeConfig (type 1) value is 108 bytes: config_authority 32 ++
// withdraw_withheld_authority 32 ++ withheld_amount u64 ++
// older_transfer_fee 18 ++ newer_transfer_fee 18 (epoch u64, maximum_fee
// u64, basis_points u16) — newer starts at value+90.

// A SECOND decoder, decodeMintTransferFeeConfig, reads BOTH schedules with
// their epochs into the TransferFeeConfig shape that tx/transfer-fee-split.ts
// splits under (older at value+72, newer at value+90, 18 bytes each). The two
// decoders share one TLV walk, findTransferFeeConfigValue; the first keeps
// its outputs and its four refusals exactly (the I-6 path is untouched).
import { getAddressDecoder, getU16Decoder, getU64Decoder, type Address } from "@solana/kit";
import type {
  TransferFeeConfig,
  TransferFeeSchedule,
} from "./tx/transfer-fee-split.js";

const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;
const TRANSFER_FEE_CONFIG_TYPE = 1;
// Exact length of a TransferFeeConfig value: 32 + 32 + 8 + 18 + 18. The
// two-schedule decoder gates it by EQUALITY, a known size never by bound.
const TRANSFER_FEE_CONFIG_LEN = 108;
// Offset of older_transfer_fee within the TransferFeeConfig value:
// 32 (config authority) + 32 (withdraw authority) + 8 (withheld).
const OLDER_TRANSFER_FEE_OFFSET = 72;
// Offset of newer_transfer_fee within the TransferFeeConfig value:
// 32 (config authority) + 32 (withdraw authority) + 8 (withheld) + 18 (older).
const NEWER_TRANSFER_FEE_OFFSET = 90;

export interface MintTransferFee {
  basisPoints: number;
  maximumFee: bigint;
}

/** Where the type-1 TLV value starts, and the length its header declares. */
interface TransferFeeConfigValue {
  valueStart: number;
  entryLen: number;
}

// The TLV walk both decoders share. Throws by name on data ending at or
// before the TLV start, on an entry that overruns the data, and when no
// type-1 entry exists. It does NOT judge the value length; each decoder
// applies its own length rule on what it reads.
function findTransferFeeConfigValue(
  mintBytes: Uint8Array,
): TransferFeeConfigValue {
  if (mintBytes.length <= TLV_START) {
    throw new Error(
      `mint account data must extend past the account-type byte at ${ACCOUNT_TYPE_OFFSET} (got ${mintBytes.length} bytes) — not a Token-2022 mint with extensions`,
    );
  }
  let offset = TLV_START;
  while (offset + 4 <= mintBytes.length) {
    const entryType = getU16Decoder().decode(
      mintBytes.subarray(offset, offset + 2),
    );
    if (entryType === 0) break; // Uninitialized — end of the TLV region.
    const entryLen = getU16Decoder().decode(
      mintBytes.subarray(offset + 2, offset + 4),
    );
    const valueStart = offset + 4;
    const valueEnd = valueStart + entryLen;
    if (valueEnd > mintBytes.length) {
      throw new Error(
        `mint TLV entry type ${entryType} at offset ${offset} overruns the account data (${valueEnd} > ${mintBytes.length})`,
      );
    }
    if (entryType === TRANSFER_FEE_CONFIG_TYPE) {
      return { valueStart, entryLen };
    }
    offset = valueEnd;
  }
  throw new Error(
    "mint account has no TransferFeeConfig extension (TLV type 1) — cannot decode the transfer fee",
  );
}

export function decodeMintTransferFee(mintBytes: Uint8Array): MintTransferFee {
  const { valueStart, entryLen } = findTransferFeeConfigValue(mintBytes);
  if (NEWER_TRANSFER_FEE_OFFSET + 18 > entryLen) {
    throw new Error(
      `TransferFeeConfig value too short for newer_transfer_fee: need ${NEWER_TRANSFER_FEE_OFFSET + 18} bytes, got ${entryLen}`,
    );
  }
  const newerStart = valueStart + NEWER_TRANSFER_FEE_OFFSET;
  // newer_transfer_fee: epoch u64 (skipped) ++ maximum_fee u64 ++ bps u16.
  const maximumFee = getU64Decoder().decode(
    mintBytes.subarray(newerStart + 8, newerStart + 16),
  );
  const basisPoints = getU16Decoder().decode(
    mintBytes.subarray(newerStart + 16, newerStart + 18),
  );
  return { basisPoints, maximumFee };
}

// One 18-byte TransferFee struct: epoch u64 ++ maximum_fee u64 ++ bps u16.
function decodeTransferFeeSchedule(
  mintBytes: Uint8Array,
  start: number,
): TransferFeeSchedule {
  const epoch = getU64Decoder().decode(mintBytes.subarray(start, start + 8));
  const maximumFee = getU64Decoder().decode(
    mintBytes.subarray(start + 8, start + 16),
  );
  const basisPoints = getU16Decoder().decode(
    mintBytes.subarray(start + 16, start + 18),
  );
  return { epoch, maximumFee, basisPoints };
}

/**
 * Both schedules with their epochs, in the shape 'decideScheduleHeadroom'
 * takes. The value length is gated by equality at 108: a Token-2022
 * TransferFeeConfig is exactly that size, and anything else is refused by
 * name rather than read partially.
 */
/** The two authorities of the TransferFeeConfig extension, at value offsets 0 and 32. */
export interface MintTransferFeeAuthorities {
  feeConfigAuthority: Address;
  withdrawWithheldAuthority: Address;
}

export function decodeMintTransferFeeAuthorities(
  mintBytes: Uint8Array,
): MintTransferFeeAuthorities {
  const { valueStart, entryLen } = findTransferFeeConfigValue(mintBytes);
  if (entryLen !== TRANSFER_FEE_CONFIG_LEN) {
    throw new Error(
      `TransferFeeConfig value must be exactly ${TRANSFER_FEE_CONFIG_LEN} bytes, got ${entryLen}`,
    );
  }
  const decoder = getAddressDecoder();
  return {
    feeConfigAuthority: decoder.decode(mintBytes.subarray(valueStart, valueStart + 32)),
    withdrawWithheldAuthority: decoder.decode(mintBytes.subarray(valueStart + 32, valueStart + 64)),
  };
}

export function decodeMintTransferFeeConfig(
  mintBytes: Uint8Array,
): TransferFeeConfig {
  const { valueStart, entryLen } = findTransferFeeConfigValue(mintBytes);
  if (entryLen !== TRANSFER_FEE_CONFIG_LEN) {
    throw new Error(
      `TransferFeeConfig value must be exactly ${TRANSFER_FEE_CONFIG_LEN} bytes, got ${entryLen}`,
    );
  }
  return {
    older: decodeTransferFeeSchedule(
      mintBytes,
      valueStart + OLDER_TRANSFER_FEE_OFFSET,
    ),
    newer: decodeTransferFeeSchedule(
      mintBytes,
      valueStart + NEWER_TRANSFER_FEE_OFFSET,
    ),
  };
}
