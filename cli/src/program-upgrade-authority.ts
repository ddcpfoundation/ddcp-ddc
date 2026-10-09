// The upgrade authority of a program under the upgradeable BPF loader, read
// from its ProgramData account. Layout of that account's first 45 bytes:
// u32 LE enum tag (3 = ProgramData), u64 LE last-deployed slot, u8 option
// tag, then the authority pubkey when the option is 1. An option of 0 means
// the program is immutable. The ProgramData address is the loader's PDA over
// the program address alone.

import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

export const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;

const PROGRAM_DATA_TAG = 3;
const PROGRAM_DATA_HEADER_LEN = 45;

export type ProgramUpgradeAuthority =
  | { readonly kind: "authority"; readonly address: Address; readonly lastDeployedSlot: bigint }
  | { readonly kind: "immutable"; readonly lastDeployedSlot: bigint };

export async function deriveProgramDataAddress(programAddress: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(programAddress)],
  });
  return address;
}

/** Pure: decodes the ProgramData header; throws by name on any other account. */
export function decodeProgramUpgradeAuthority(data: Uint8Array): ProgramUpgradeAuthority {
  if (data.length < PROGRAM_DATA_HEADER_LEN) {
    throw new Error("ProgramData account must be at least " + PROGRAM_DATA_HEADER_LEN + " bytes, got " + data.length);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = view.getUint32(0, true);
  if (tag !== PROGRAM_DATA_TAG) {
    throw new Error("ProgramData account tag must be " + PROGRAM_DATA_TAG + ", got " + tag);
  }
  const lastDeployedSlot = view.getBigUint64(4, true);
  const option = view.getUint8(12);
  if (option === 0) return { kind: "immutable", lastDeployedSlot };
  if (option !== 1) throw new Error("ProgramData authority option must be 0 or 1, got " + option);
  return { kind: "authority", address: getAddressDecoder().decode(data.subarray(13, 45)), lastDeployedSlot };
}

export function formatProgramUpgradeAuthority(value: ProgramUpgradeAuthority): string {
  return value.kind === "immutable" ? "none (program is immutable)" : value.address;
}
