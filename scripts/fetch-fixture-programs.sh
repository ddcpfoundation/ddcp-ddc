#!/usr/bin/env bash
# Fetch the deployed Token-2022 program binaries from mainnet-beta and devnet
# for LiteSVM integration tests, and record their provenance.
#
# No binary blob is committed to the repository: each .so lands at a
# gitignored path, while this committed script plus the committed provenance
# records (address, cluster, date, slot, SHA-256) pin exactly what the tests
# run against. The test harness refuses to load a .so whose SHA-256 does not
# match its committed record. `cargo test` loads the mainnet-beta build;
# `DDCP_TOKEN_2022=devnet cargo test` loads the devnet build.
#
# Without --refresh the script never rewrites a record. For each cluster, if
# the .so is missing or differs from its record, it dumps that cluster's
# Token-2022 and keeps the dump only if its SHA-256 equals the record. If a
# cluster now serves a different binary, it refuses for that cluster and
# exits 1: the tests stay pinned to the recorded binary until someone re-pins
# on purpose with --refresh and commits the new record.
#
# Usage:
#   scripts/fetch-fixture-programs.sh                            # both clusters: fetch if missing; refuse if a cluster differs from its record
#   scripts/fetch-fixture-programs.sh --refresh mainnet|devnet   # dump that cluster's current binary and rewrite its record
#
# Prerequisites: solana CLI on PATH, network access to both clusters.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/program/tests/fixtures"

# Token-2022 program ID.
PROGRAM_ADDRESS="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

mkdir -p "$FIXTURE_DIR"

# A dump that is checked before it is kept goes to a temporary file, removed on exit.
TMP_SO=""
trap 'rm -f "$TMP_SO"' EXIT

checksum() {
    shasum -a 256 "$1" | awk '{print $1}'
}

usage() {
    echo "usage: scripts/fetch-fixture-programs.sh [--refresh mainnet|devnet]" >&2
    exit 1
}

# Sets SO_NAME, SO_PATH, PROVENANCE_PATH and CLUSTER_URL for a cluster name.
select_cluster() {
    case "$1" in
        mainnet)
            SO_NAME="token_2022-mainnet.so"
            PROVENANCE_PATH="$FIXTURE_DIR/token-2022-mainnet.provenance.txt"
            CLUSTER_URL="https://api.mainnet-beta.solana.com"
            ;;
        devnet)
            SO_NAME="token_2022.so"
            PROVENANCE_PATH="$FIXTURE_DIR/token-2022.provenance.txt"
            CLUSTER_URL="https://api.devnet.solana.com"
            ;;
        *)
            usage
            ;;
    esac
    SO_PATH="$FIXTURE_DIR/$SO_NAME"
}

# Dumps the cluster's current binary and rewrites its record. Returns 1, with
# the record unchanged, if the cluster cannot be read.
refresh_cluster() {
    echo "Dumping $PROGRAM_ADDRESS from $CLUSTER_URL ..."
    local slot sha256 date_utc
    if ! slot="$(solana slot --url "$CLUSTER_URL")"; then
        echo "FAILED: could not read the slot of $CLUSTER_URL; the record is unchanged." >&2
        return 1
    fi
    if ! solana program dump --url "$CLUSTER_URL" "$PROGRAM_ADDRESS" "$SO_PATH"; then
        echo "FAILED: could not dump $PROGRAM_ADDRESS from $CLUSTER_URL; the record is unchanged." >&2
        return 1
    fi
    sha256="$(checksum "$SO_PATH")"
    date_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

    cat > "$PROVENANCE_PATH" <<EOF
# Provenance record for program/tests/fixtures/$SO_NAME (gitignored blob).
# Written by scripts/fetch-fixture-programs.sh — do not edit by hand.
# The test harness verifies the .so's SHA-256 against this record before
# loading it into LiteSVM; no binary is committed to the repository.
program_address=$PROGRAM_ADDRESS
cluster_url=$CLUSTER_URL
dump_date_utc=$date_utc
slot_at_fetch=$slot
sha256=$sha256
EOF

    echo "Wrote $SO_PATH (sha256=$sha256, slot=$slot)"
    echo "Provenance recorded at $PROVENANCE_PATH"
}

# Makes the cluster's .so match its record, or refuses. Returns 1 on refusal
# or when the cluster cannot be read.
check_cluster() {
    if [[ ! -f "$PROVENANCE_PATH" ]]; then
        echo "No record at $PROVENANCE_PATH - writing the first one."
        refresh_cluster
        return
    fi
    local recorded fetched
    recorded="$(grep '^sha256=' "$PROVENANCE_PATH" | cut -d= -f2)"
    if [[ -f "$SO_PATH" && "$(checksum "$SO_PATH")" == "$recorded" ]]; then
        echo "$SO_NAME present and matches committed provenance (sha256=$recorded) - nothing to do."
        return 0
    fi
    echo "Dumping $PROGRAM_ADDRESS from $CLUSTER_URL to check it against the committed record ..."
    TMP_SO="$(mktemp "${TMPDIR:-/tmp}/token_2022.XXXXXX")"
    if ! solana program dump --url "$CLUSTER_URL" "$PROGRAM_ADDRESS" "$TMP_SO"; then
        rm -f "$TMP_SO"
        echo "FAILED: could not dump $PROGRAM_ADDRESS from $CLUSTER_URL; the record and $SO_PATH are unchanged." >&2
        return 1
    fi
    fetched="$(checksum "$TMP_SO")"
    if [[ "$fetched" == "$recorded" ]]; then
        mv "$TMP_SO" "$SO_PATH"
        echo "Wrote $SO_PATH (sha256=$fetched), the binary the committed record pins."
        return 0
    fi
    rm -f "$TMP_SO"
    echo "REFUSED: Token-2022 on $CLUSTER_URL (sha256=$fetched) is not the binary the committed record pins (sha256=$recorded)." >&2
    echo "The record and $SO_PATH are left unchanged. To test against the current binary, run with --refresh and the cluster name, and commit the new record." >&2
    return 1
}

if [[ $# -eq 0 ]]; then
    status=0
    for cluster in mainnet devnet; do
        select_cluster "$cluster"
        check_cluster || status=1
    done
    exit "$status"
fi

if [[ "$1" == "--refresh" && $# -eq 2 ]]; then
    select_cluster "$2"
    refresh_cluster
    exit
fi

usage
