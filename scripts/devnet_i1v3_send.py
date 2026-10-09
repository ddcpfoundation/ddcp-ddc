#!/usr/bin/env python3
"""I-1 v3 'initialize_mint' SEND script -- devnet, the reference (conforming) mint.

See devnet_i1v3_dry_construct.py for the layout and the inputs. Importing that module runs its gates -- the ristretto255
gate on the withheld ElGamal key, the Option-encoding vectors, the conforming
profile and the key-distinctness checks; this file never reaches main() if any
of them fails.

Default mode is INSPECTION: reconstructs the instruction (imported from
devnet_i1v3_dry_construct -- same code, hence byte-identical payload), loads the
mint + payer keypairs, compiles and signs the legacy transaction over an
ALL-ZERO SENTINEL BLOCKHASH, prints everything, and exits WITHOUT any network
call. A sentinel-blockhash transaction can never land: devnet rejects an
unknown blockhash, so nothing printed in inspection mode is broadcastable.

Usage:  python3 scripts/devnet_i1v3_send.py --mint-keypair PATH --payer-keypair PATH [--send]
Broadcast requires the explicit flag --send.
Only then does the script fetch a live blockhash, re-sign, and submit via
sendTransaction. There is no other network path in this file.

Secret material touched: exactly two keypair files, the mint's and the
payer's, each named on the command line; no key path is written in this
file. Secrets are never printed; loaded pubkeys are verified against the
ratified base58 constants before anything is signed.
"""

import json
import sys
import urllib.request
from hashlib import sha256, sha512
from pathlib import Path

from devnet_i1v3_dry_construct import (
    ARGS,
    DISCRIMINATOR,
    METADATA_UPDATE_AUTHORITY,
    MINT,
    PAYER,
    PROGRAM_ID,
    SYSTEM_PROGRAM,
    TOKEN_2022,
    b58decode_32,
    b58encode,
    find_program_address,
    serialize_args,
)

USAGE = "usage: python3 scripts/devnet_i1v3_send.py --mint-keypair PATH --payer-keypair PATH [--send]"

RPC_URL = "https://api.devnet.solana.com"
SENTINEL_BLOCKHASH = bytes(32)  # inspection mode: unbroadcastable by design

# --- ed25519 signing (RFC 8032, stdlib-only) ---------------------------------

_P = 2**255 - 19
_Q = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P


def _inv(x):
    return pow(x, _P - 2, _P)


def _recover_x(y, sign):
    x2 = (y * y - 1) * _inv(_D * y * y + 1) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * pow(2, (_P - 1) // 4, _P) % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_BY = 4 * _inv(5) % _P
_BX = _recover_x(_BY, 0)
_B = (_BX, _BY, 1, _BX * _BY % _P)


def _add(p1, p2):
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = 2 * t1 * t2 * _D % _P
    dd = 2 * z1 * z2 % _P
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(s, pt):
    q = (0, 1, 1, 0)
    while s:
        if s & 1:
            q = _add(q, pt)
        pt = _add(pt, pt)
        s >>= 1
    return q


def _compress(pt):
    x, y, z, _ = pt
    zi = _inv(z)
    x, y = x * zi % _P, y * zi % _P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _expand_seed(seed: bytes):
    h = sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def pubkey_from_seed(seed: bytes) -> bytes:
    a, _ = _expand_seed(seed)
    return _compress(_mul(a, _B))


def sign(seed: bytes, msg: bytes) -> bytes:
    a, prefix = _expand_seed(seed)
    pub = _compress(_mul(a, _B))
    r = int.from_bytes(sha512(prefix + msg).digest(), "little") % _Q
    big_r = _compress(_mul(r, _B))
    k = int.from_bytes(sha512(big_r + pub + msg).digest(), "little") % _Q
    s = (r + k * a) % _Q
    return big_r + s.to_bytes(32, "little")


# --- keypair loading ----------------------------------------------------------


def load_keypair(path: Path, expected_b58: str, label: str) -> bytes:
    """Load a Solana JSON keypair (64-byte array); return the 32-byte seed.

    Verifies the file's stored pubkey AND the pubkey re-derived from the seed
    both equal the ratified constant. Never prints secret bytes.
    """
    arr = json.loads(path.read_text())
    assert isinstance(arr, list) and len(arr) == 64, f"{label}: not a 64-byte keypair"
    seed, stored_pub = bytes(arr[:32]), bytes(arr[32:])
    derived = pubkey_from_seed(seed)
    assert derived == stored_pub, f"{label}: derived pubkey != stored pubkey"
    assert b58encode(derived) == expected_b58, (
        f"{label}: keypair pubkey {b58encode(derived)} != ratified {expected_b58}"
    )
    return seed


# --- legacy transaction compilation ------------------------------------------


def shortvec(n: int) -> bytes:
    out = b""
    while True:
        b7 = n & 0x7F
        n >>= 7
        out += bytes([b7 | (0x80 if n else 0)])
        if not n:
            return out


def build_instruction():
    program_id = b58decode_32(PROGRAM_ID)
    mint = b58decode_32(MINT)
    pda1, _ = find_program_address([b"mint_state", mint], program_id)
    pda2, _ = find_program_address([b"attestation", mint], program_id)
    data = DISCRIMINATOR + serialize_args()
    # I-1 order, flags per the handler ladder -- identical to the dry construct.
    accounts = [
        ("mint", MINT, True, True),
        ("PDA-1 MintState", b58encode(pda1), False, True),
        ("PDA-2 AttestationRecord", b58encode(pda2), False, True),
        ("payer", PAYER, True, True),
        ("system_program", SYSTEM_PROGRAM, False, False),
        ("token_2022_program", TOKEN_2022, False, False),
        ("metadata_update_authority (#7)", METADATA_UPDATE_AUTHORITY, False, False),
    ]
    return accounts, data


def compile_message(accounts, data, blockhash: bytes) -> bytes:
    """Legacy message: fee payer first, writable signers, then writable
    non-signers, then readonly non-signers (incl. the program id last)."""
    keys = [
        PAYER,  # fee payer -- writable signer
        MINT,  # writable signer
        accounts[1][1],  # PDA-1 -- writable
        accounts[2][1],  # PDA-2 -- writable
        SYSTEM_PROGRAM,  # readonly
        TOKEN_2022,  # readonly
        METADATA_UPDATE_AUTHORITY,  # readonly
        PROGRAM_ID,  # readonly -- invoked program
    ]
    header = bytes([2, 0, 4])  # 2 required sigs, 0 readonly signed, 4 readonly unsigned
    ix_account_indices = bytes([keys.index(a[1]) for a in accounts])
    compiled_ix = (
        bytes([keys.index(PROGRAM_ID)])
        + shortvec(len(ix_account_indices))
        + ix_account_indices
        + shortvec(len(data))
        + data
    )
    return (
        header
        + shortvec(len(keys))
        + b"".join(b58decode_32(k) for k in keys)
        + blockhash
        + shortvec(1)
        + compiled_ix
    )


def rpc(method: str, params):
    req = urllib.request.Request(
        RPC_URL,
        data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        ).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as f:
        resp = json.load(f)
    if "error" in resp:
        raise RuntimeError(f"{method}: {resp['error']}")
    return resp["result"]


def keypair_paths(argv):
    """The ONLY two secret files this script reads, each named on the command line."""
    paths = {}
    rest = list(argv)
    while rest:
        flag = rest.pop(0)
        if flag == "--send":
            continue
        if flag in ("--mint-keypair", "--payer-keypair") and rest and flag not in paths:
            paths[flag] = Path(rest.pop(0))
            continue
        sys.exit(f"{USAGE}\nunexpected argument: {flag}")
    if len(paths) != 2:
        sys.exit(USAGE)
    return paths["--mint-keypair"], paths["--payer-keypair"]


def main():
    mint_keypair_path, payer_keypair_path = keypair_paths(sys.argv[1:])
    send = "--send" in sys.argv[1:]

    accounts, data = build_instruction()
    print("=== I-1 v3 initialize_mint SEND SCRIPT ===")
    print(f"mode: {'SEND (--send given)' if send else 'INSPECTION (no --send): will NOT broadcast'}")
    print()
    print("--- accounts (index, role, pubkey, is_signer, is_writable) ---")
    for i, (role, key, signer, writable) in enumerate(accounts):
        print(f"  #{i}  {role:<32} {key}  signer={signer}  writable={writable}")
    print()
    print(f"--- instruction data ({len(data)} bytes) ---")
    print(data.hex())
    print(f"sha256(data) = {sha256(data).hexdigest()}")
    print()

    mint_seed = load_keypair(mint_keypair_path, MINT, "mint")
    payer_seed = load_keypair(payer_keypair_path, PAYER, "payer")
    print("--- keypairs loaded (pubkeys verified against ratified constants) ---")
    print(f"  mint : {mint_keypair_path}")
    print(f"  payer: {payer_keypair_path}")
    print(f"  fee payer = payer; signers, in signature order = [payer, mint]")
    print()

    if not send:
        msg = compile_message(accounts, data, SENTINEL_BLOCKHASH)
        sig_payer = sign(payer_seed, msg)
        sig_mint = sign(mint_seed, msg)
        wire = shortvec(2) + sig_payer + sig_mint + msg
        print("--- INSPECTION: signed over ALL-ZERO SENTINEL blockhash ---")
        print("    (devnet rejects unknown blockhashes: this exact transaction")
        print("     CANNOT land; it exists only to prove the signing path)")
        print(f"  message bytes : {len(msg)}")
        print(f"  wire size     : {len(wire)} bytes (limit 1232)")
        print(f"  payer sig     : {b58encode(sig_payer)}")
        print(f"  mint  sig     : {b58encode(sig_mint)}")
        print()
        print("NOT BROADCAST. Re-run with --send to fetch a live blockhash,")
        print("re-sign, and submit.")
        return

    # --- SEND PATH (only reachable with --send) ------------------------------
    bh = rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
    print(f"live blockhash: {bh}")
    msg = compile_message(accounts, data, b58decode_32(bh))
    wire = shortvec(2) + sign(payer_seed, msg) + sign(mint_seed, msg) + msg
    assert len(wire) <= 1232, f"wire {len(wire)} exceeds packet limit"
    import base64

    sig = rpc(
        "sendTransaction",
        [base64.b64encode(wire).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}],
    )
    print(f"BROADCAST -- signature: {sig}")
    import time

    for _ in range(30):
        time.sleep(2)
        st = rpc("getSignatureStatuses", [[sig]])["value"][0]
        if st is not None:
            print(f"status: {st}")
            if st.get("confirmationStatus") in ("confirmed", "finalized"):
                return
    print("status polling timed out -- check the signature on an explorer")


if __name__ == "__main__":
    main()
