#!/usr/bin/env python3
"""Dry construction of the devnet I-1 v3 'initialize_mint' transaction -- INSPECTION ONLY.

The devnet genesis of the reference (conforming) mint. It carries the I-1
layout of the deployed program: the Confidential Transfer mint
authority as a borsh Option, set to none, so that the absence of an auditor
key and automatic approval of new confidential accounts cannot be changed by
any authority of this mint; and the two genesis-settled
fee ceilings, set to the reference mint's ceilings of 100 basis points and
1,000,000 base units. The transfer-fee schedule itself is initialized at
zero by the handler. The token metadata is the placeholder name 'ddc',
symbol 'DDC' and an empty URI, since set through the metadata update
authority to the token-metadata document.

The authorities below are those set at genesis. Every one of them except
the withheld-fee ElGamal key has since been replaced; the README lists the
current holders.

Builds the instruction (account metas + discriminator + borsh args) entirely
offline and prints it with a field-by-field decode. Makes NO network calls and
NEVER signs or sends anything: there is deliberately no RPC client, no keypair
loading, and no transaction assembly in this file.

Serialization order is the 'InitializeMintArgs' declaration order in
program/src/instruction.rs (borsh serializes fields in declaration order) --
that file is the source of truth. The Option encoding is checked at import
against the vectors of the program's own test
'initialize_mint_ct_authority_option_wire_bytes'. Discriminator, Anchor-style:
SHA-256("global:initialize_mint")[0..8], cross-checked below against the
constant in instruction.rs. PDA derivation reimplements
Pubkey::find_program_address (SHA-256 + ed25519 off-curve check) so the
script stays dependency-free; verify against
'solana find-program-derived-address' before relying on the addresses.
"""

import hashlib

# --- base58 (Bitcoin alphabet, as Solana uses) -------------------------------

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode_32(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + _B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    pad = 0
    for c in s:
        if c == "1":
            pad += 1
        else:
            break
    out = b"\x00" * pad + body
    assert len(out) == 32, f"{s!r} decodes to {len(out)} bytes, want 32"
    return out


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    pad = 0
    for byte in b:
        if byte == 0:
            pad += 1
        else:
            break
    return "1" * pad + s


# --- ed25519 on-curve check + find_program_address ---------------------------

_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def _is_on_curve(b32: bytes) -> bool:
    """RFC 8032 point-decompression success/failure."""
    y_int = int.from_bytes(b32, "little")
    sign = y_int >> 255
    y = y_int & ((1 << 255) - 1)
    if y >= _P:
        return False
    y2 = y * y % _P
    x2 = (y2 - 1) * pow(_D * y2 + 1, _P - 2, _P) % _P
    if x2 == 0:
        return sign == 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * pow(2, (_P - 1) // 4, _P) % _P
    if (x * x - x2) % _P != 0:
        return False
    return True


def find_program_address(seeds, program_id: bytes):
    for bump in range(255, -1, -1):
        h = hashlib.sha256(
            b"".join(seeds) + bytes([bump]) + program_id + b"ProgramDerivedAddress"
        ).digest()
        if not _is_on_curve(h):
            return h, bump
    raise RuntimeError("no viable bump")


# --- ristretto255 decode (RFC 9496 section 4.3.1), the withheld-key gate -----
#
# An ElGamal public key is a compressed ristretto255 point. The handler and
# Token-2022 accept any 32 bytes; this is the only place the value is checked.
# Proven against @noble/curves 1.9.7 on 2,205 vectors before it was dictated.

_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _is_negative(x: int) -> bool:
    return (x % _P) & 1 == 1


def _ct_abs(x: int) -> int:
    x %= _P
    return (_P - x) % _P if _is_negative(x) else x


def _sqrt_ratio_m1(u: int, v: int):
    v3 = pow(v, 3, _P)
    v7 = pow(v, 7, _P)
    r = (u * v3 % _P) * pow(u * v7 % _P, (_P - 5) // 8, _P) % _P
    check = v * r * r % _P
    correct = check == u % _P
    flipped = check == (-u) % _P
    flipped_i = check == (-u * _SQRT_M1) % _P
    if flipped or flipped_i:
        r = r * _SQRT_M1 % _P
    return (correct or flipped), _ct_abs(r)


def is_ristretto_point(b32: bytes) -> bool:
    """True iff b32 is a canonical ristretto255 encoding (a valid ElGamal pubkey)."""
    if len(b32) != 32:
        return False
    s = int.from_bytes(b32, "little")
    if s >= _P or _is_negative(s):
        return False
    ss = s * s % _P
    u1 = (1 - ss) % _P
    u2 = (1 + ss) % _P
    u2_sqr = u2 * u2 % _P
    v = (-(_D * u1 * u1) - u2_sqr) % _P
    was_square, invsqrt = _sqrt_ratio_m1(1, v * u2_sqr % _P)
    den_x = invsqrt * u2 % _P
    den_y = invsqrt * den_x % _P * v % _P
    x = _ct_abs(2 * s * den_x)
    y = u1 * den_y % _P
    t = x * y % _P
    if (not was_square) or _is_negative(t) or y == 0:
        return False
    return True


# --- devnet values, v3 reference genesis ----------------------------------------

PROGRAM_ID = "Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SYSTEM_PROGRAM = "11111111111111111111111111111111"

MINT = "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa"  # the mint's own address key; it signed only the genesis
PAYER = "FErEa5sWPZAPBet2HgHwvLZjrTnHzS7Ftd73YHGFGjLY"  # pays rent and fees; holds no authority

ARGS = {
    # The three co-signers at genesis; since replaced.
    "issuer_authority": "3sTjPPuSXSbPc5QKXj2gvu6b51pvMy2EUJxc45VtJ4kb",
    "operator_authority": "CKJDfZ5VBVTNaY4XUuqDn8umDujHKEBWNE3qosQeVzqe",
    "reserve_authority": "Dg9YEh2Tb9qzdmutxCi36LyRx98WGLFanZPRmHdfBPez",
    # Conforming value: none. Encoded as the single tag byte 0x00.
    "confidential_transfer_mint_authority": None,
    # Held by the issuer at genesis; since replaced.
    "confidential_transfer_fee_authority": "8dUrmv8uu9aG1NZVt7AHNnAediUL26BjEfsZMeSovLwN",
    # The public half of the withheld-fee ElGamal key, a ristretto255 point; its secret is held by the issuer.
    # hex 76f1d3e0095d95d6e86bfa3ca344592c2a34f4c2d7c765253b03d364570d0a43
    "withdraw_withheld_authority_elgamal_pubkey": "91JyxCBjK1NqZzY8ZtzXYHh6uwBoh7gsSXJS6R3PsgSn",
    # Held by the issuer at genesis; since replaced.
    "withdraw_withheld_authority": "5WrMC2ipjA37cx9E2DFXRxDU5BX1ERPXSSFeZJwLvKwd",
    # Placeholder metadata. The empty URI is replaced later
    # through the metadata update authority.
    "name": "ddc",
    "symbol": "DDC",
    "uri": "",
    # Held by the issuer at genesis; since replaced.
    "metadata_pointer_authority": "AZvcdvxNyAjvYLaXFbUGv412vvUbWrq7vFux5AHPvBF3",
    # The reference mint's ceilings; never raised after genesis.
    "fee_ceiling_basis_points": 100,
    "fee_ceiling_base_units": 1_000_000,
}
# Held by the issuer at genesis; since replaced.
METADATA_UPDATE_AUTHORITY = "8ejzuK8YjjDTLq6b1ZKf3kve1XvYmb1CYsbaF9wUvvqV"  # account #7

# InitializeMintArgs declaration order (program/src/instruction.rs).
FIELD_ORDER = [
    ("issuer_authority", "pubkey"),
    ("operator_authority", "pubkey"),
    ("reserve_authority", "pubkey"),
    ("confidential_transfer_mint_authority", "option_pubkey"),
    ("confidential_transfer_fee_authority", "pubkey"),
    ("withdraw_withheld_authority_elgamal_pubkey", "bytes32"),
    ("withdraw_withheld_authority", "pubkey"),
    ("name", "string"),
    ("symbol", "string"),
    ("uri", "string"),
    ("metadata_pointer_authority", "pubkey"),
    ("fee_ceiling_basis_points", "u16"),
    ("fee_ceiling_base_units", "u64"),
]


def _encode(field_order, args) -> bytes:
    out = bytearray()
    for field, kind in field_order:
        v = args[field]
        if kind == "pubkey":
            out += v if isinstance(v, bytes) else b58decode_32(v)
        elif kind == "bytes32":
            out += v if isinstance(v, bytes) else b58decode_32(v)
        elif kind == "option_pubkey":
            if v is None:
                out += b"\x00"
            else:
                out += b"\x01" + (v if isinstance(v, bytes) else b58decode_32(v))
        elif kind == "string":
            enc = v.encode("utf-8")
            out += len(enc).to_bytes(4, "little") + enc
        elif kind == "u16":
            out += v.to_bytes(2, "little")
        elif kind == "u64":
            out += v.to_bytes(8, "little")
        else:
            raise AssertionError(f"unknown kind {kind}")
    return bytes(out)


def serialize_args() -> bytes:
    return _encode(FIELD_ORDER, ARGS)


# --- import-time gates ---------------------------------------------------------

# The withheld ElGamal key must decode as a ristretto255 point.
# Paired: the first genesis value must NOT decode, or the gate checks nothing.
FIRST_GENESIS_ELGAMAL_VALUE = "GjR5NKtYH84pSvqDUuGjKWbbjJ5rhjHkYEkpSXGyS3j4"  # an Ed25519 pubkey
_ELGAMAL_BYTES = b58decode_32(ARGS["withdraw_withheld_authority_elgamal_pubkey"])
assert is_ristretto_point(_ELGAMAL_BYTES), (
    "REFUSED: withdraw_withheld_authority_elgamal_pubkey is not a ristretto255 point"
)
assert _ELGAMAL_BYTES.hex() == (
    "76f1d3e0095d95d6e86bfa3ca344592c2a34f4c2d7c765253b03d364570d0a43"
), "withheld ElGamal pubkey bytes drifted from the value of record"
assert not is_ristretto_point(b58decode_32(FIRST_GENESIS_ELGAMAL_VALUE)), (
    "gate self-test failed: the first genesis value must not decode"
)

# The Option encoding, checked against the vectors of the program's test
# initialize_mint_ct_authority_option_wire_bytes (program/src/instruction.rs).
_VEC = {
    "issuer_authority": bytes([1]) * 32,
    "operator_authority": bytes([2]) * 32,
    "reserve_authority": bytes([3]) * 32,
    "confidential_transfer_mint_authority": None,
    "confidential_transfer_fee_authority": bytes([4]) * 32,
    "withdraw_withheld_authority_elgamal_pubkey": bytes([5]) * 32,
    "withdraw_withheld_authority": bytes([6]) * 32,
    "name": "",
    "symbol": "",
    "uri": "",
    "metadata_pointer_authority": bytes([7]) * 32,
    "fee_ceiling_basis_points": 100,
    "fee_ceiling_base_units": 1_000_000,
}
_NONE = _encode(FIELD_ORDER, _VEC)
assert _NONE[96] == 0x00 and _NONE[97] == 4, "none tag not at offset 96"
_SOME = _encode(FIELD_ORDER, dict(_VEC, confidential_transfer_mint_authority=bytes([9]) * 32))
assert _SOME[96] == 0x01 and _SOME[97:129] == bytes([9]) * 32 and _SOME[129] == 4, "some tag layout"
assert len(_SOME) == len(_NONE) + 32, "some is not 32 bytes longer than none"
_ZERO = _encode(FIELD_ORDER, dict(_VEC, confidential_transfer_mint_authority=bytes(32)))
assert _ZERO[96] == 0x01 and _ZERO != _NONE, "a zero pubkey must encode as present"
assert len(_NONE) == 247, f"none-layout length {len(_NONE)}, want 247"

# The conforming profile.
assert ARGS["confidential_transfer_mint_authority"] is None, "CT mint authority must be none"
assert ARGS["fee_ceiling_basis_points"] == 100, "basis-points ceiling must be the reference mint's"
assert ARGS["fee_ceiling_base_units"] == 1_000_000, "absolute ceiling must be the reference mint's"
assert (ARGS["name"], ARGS["symbol"], ARGS["uri"]) == ("ddc", "DDC", ""), "placeholder metadata"

# Every key distinct, and none is the program's deploy key at genesis.
_KEYS = [
    MINT, PAYER,
    ARGS["issuer_authority"], ARGS["operator_authority"], ARGS["reserve_authority"],
    ARGS["confidential_transfer_fee_authority"], ARGS["withdraw_withheld_authority"],
    ARGS["metadata_pointer_authority"], METADATA_UPDATE_AUTHORITY,
]
assert len(set(_KEYS)) == len(_KEYS), "two roles share one key"
_DEPLOY_KEY_AT_GENESIS = "EYzWKVdZ4b6Sav47vN3vjcM6GQmnUq1KqP6rqdqisEuV"
assert _DEPLOY_KEY_AT_GENESIS not in _KEYS, "a genesis key is the deploy key"

DISCRIMINATOR = hashlib.sha256(b"global:initialize_mint").digest()[:8]
EXPECTED_DISCRIMINATOR = bytes(
    [0xD1, 0x2A, 0xC3, 0x04, 0x81, 0x55, 0xD1, 0x2C]
)  # instruction.rs:17
assert DISCRIMINATOR == EXPECTED_DISCRIMINATOR, "discriminator drifted from instruction.rs"


def decode_args(data: bytes):
    """Independent decode: walks the same layout and returns (field, start, end, value)."""
    rows = []
    pos = 0
    for field, kind in FIELD_ORDER:
        start = pos
        if kind in ("pubkey", "bytes32"):
            raw = data[pos : pos + 32]
            pos += 32
            value = b58encode(raw) if kind == "pubkey" else raw.hex()
            if kind == "bytes32":
                value += f"  (= bytes of {b58encode(raw)})"
        elif kind == "option_pubkey":
            tag = data[pos]
            pos += 1
            assert tag in (0, 1), f"bad Option tag {tag}"
            if tag == 0:
                value = "None (tag 0x00)"
            else:
                value = f"Some {b58encode(data[pos : pos + 32])}"
                pos += 32
        elif kind == "string":
            ln = int.from_bytes(data[pos : pos + 4], "little")
            pos += 4
            raw = data[pos : pos + ln]
            pos += ln
            value = f'len={ln} "{raw.decode("utf-8")}"'
        elif kind == "u16":
            value = str(int.from_bytes(data[pos : pos + 2], "little"))
            pos += 2
        elif kind == "u64":
            value = str(int.from_bytes(data[pos : pos + 8], "little"))
            pos += 8
        rows.append((field, start, pos, value))
    assert pos == len(data), f"trailing bytes: consumed {pos} of {len(data)}"
    return rows


def main():
    program_id = b58decode_32(PROGRAM_ID)
    mint = b58decode_32(MINT)
    pda1, bump1 = find_program_address([b"mint_state", mint], program_id)
    pda2, bump2 = find_program_address([b"attestation", mint], program_id)

    # I-1 account order; flags per the handler's assert_writable /
    # assert_signer ladder (processor/initialize_mint.rs).
    accounts = [
        ("mint", MINT, True, True),
        (f"PDA-1 MintState (bump {bump1})", b58encode(pda1), False, True),
        (f"PDA-2 AttestationRecord (bump {bump2})", b58encode(pda2), False, True),
        ("payer", PAYER, True, True),
        ("system_program", SYSTEM_PROGRAM, False, False),
        ("token_2022_program", TOKEN_2022, False, False),
        ("metadata_update_authority (#7)", METADATA_UPDATE_AUTHORITY, False, False),
    ]

    body = serialize_args()
    data = DISCRIMINATOR + body

    print("=== I-1 v3 initialize_mint -- DRY CONSTRUCTION (nothing sent) ===")
    print("withheld ElGamal pubkey ristretto255 gate: PASS (asserted at import)")
    print("CT mint authority: none; fee ceilings 100 bps / 1000000 base units; schedule zero at genesis")
    print(f"program_id: {PROGRAM_ID}")
    print()
    print("--- accounts (index, role, pubkey, is_signer, is_writable) ---")
    for i, (role, key, signer, writable) in enumerate(accounts):
        print(f"  #{i}  {role:<38} {key}  signer={signer}  writable={writable}")
    print()
    print(f"--- instruction data ({len(data)} bytes = 8 discriminator + {len(body)} borsh) ---")
    print(data.hex())
    print(f"sha256(data) = {hashlib.sha256(data).hexdigest()}")
    print()
    print("--- decode (field, byte range within data, value) ---")
    print(f"  discriminator            [0:8)      {data[:8].hex()}  (SHA-256('global:initialize_mint')[0..8])")
    for field, start, end, value in decode_args(body):
        print(f"  {field:<44} [{start + 8}:{end + 8})  {value}")
    print()
    print("transaction shell (NOT built here): fee payer = payer; signers = [payer, mint];")
    print("blockhash + signing + send deliberately out of scope for this script.")


if __name__ == "__main__":
    main()
