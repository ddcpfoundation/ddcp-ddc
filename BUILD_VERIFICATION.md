# Build verification

This document explains how anyone can rebuild the on-chain program in `program/` from this source and check that the result is the program deployed on devnet. It covers the program only. The command-line tool in `cli/` runs on the user's machine and is not deployed.

## What is compared

The program is built in a published Docker image named by its digest, so every builder uses the same compiler, the same Solana platform tools and the same file paths. Two builds of the same source in that image produce the same bytes.

Two hashes describe a build. Both are given below, labelled:

- **Executable hash.** The hash `solana-verify` reports: a SHA-256 of the program file with its trailing zero bytes removed. The same tool computes the same hash over a deployed program, so this is the hash to compare with the chain.
- **File SHA-256.** A plain SHA-256 of the program file `ddcp_ddc.so`. It identifies the file, and differs from the executable hash.

A build made outside the image, with `cargo build-sbf` on a developer's own machine, is not guaranteed to match, because the compiler, the platform tools and the file paths are then that machine's. It is not the comparison this document describes.

## The deployed build

| | |
|---|---|
| Program | `Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp`, devnet |
| Deployed | slot 523,214,795, transaction `sE8TEy364gxnEzYp7tCFB3UmUZNUN6AMnGn8uZfgCcZAKv7LSrdcNZnvQKESFWu4Ekbz97ffrRM9r6JZXBcvo2P` |
| Source | the commit tagged `v0.3.0`. Its program was rebuilt in the image on 2026-11-17 (UTC) and gave the executable hash below. |
| Build image | `solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3` |
| Build tool | `solana-verify` 0.5.1 |
| Executable hash | `df375a9119e35c7badffe780e44f2175d57199dbfc07aa89aa2fd0e5ba7ffbd0` |
| File SHA-256 | `fa969d0a4d3a3a53f17d9b99f472637d389611393d4d09ee1c5ea1042ea0a179` |
| Size | 142,808 bytes |

## How to check it

You need Docker (running before step 3), `git`, and `solana-verify` 0.5.1 (`cargo install solana-verify --version 0.5.1`).

1. **Fetch the image by its digest.**

   ```
   docker pull solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3
   ```

   Pulling by digest makes Docker check the image's contents. Check that it is present with `docker image inspect` on the same name; an image pulled by digest has no tag, and `docker image ls` filtered by repository may not list it.

2. **Unpack a clean copy of the source.** The build writes a `target/` directory into the directory it builds, so build from a fresh copy, never from a working tree:

   ```
   git archive --format=tar --output=source.tar <commit>
   mkdir build && tar -xf source.tar -C build
   ```

   `<commit>` is the commit named under Source above.

3. **Build in the image.** Name the image on the command, so that a different version of the tool cannot choose a different image. Give the folder by its full path: `solana-verify` 0.5.1 passes the name to Docker unchanged, and Docker reads a name without a slash as a named volume, so the build would see an empty folder:

   ```
   solana-verify build "$PWD/build" --library-name ddcp_ddc --base-image solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3
   ```

   The last line the build prints is its executable hash.

4. **Hash the build and the deployed program.**

   ```
   solana-verify get-executable-hash build/target/deploy/ddcp_ddc.so
   solana-verify get-program-hash -u https://api.devnet.solana.com Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp
   ```

   The two hashes must be equal, and equal to the executable hash in the table above.

## What to expect

- A build takes several minutes and needs network access to fetch Rust dependencies.
- A build can fail partway with `error[E0463]: can't find crate` in one of the dependencies, before the program's own code is compiled. It was seen once in three builds of an earlier deployed source; the same source built cleanly from a fresh unpacked copy. Build again from a new copy; do not reuse the directory of the failed build.
- `solana-verify` prints `Program Solana version: v0.0.0` when the image is given with `--base-image`. That line reports a value the tool did not read, not a property of the build.
- The image is the one `solana-verify` 0.5.1 selects for Solana 3.1.10, the version named in `[workspace.metadata.cli]` in `Cargo.toml`. Naming the image by digest makes the build independent of that selection.

## When the program changes

A change to the program's source reaches devnet only through an upgrade. An upgrade is made from a build in the image, and its buffer is checked against the build's executable hash before the upgrade is signed (`solana-verify get-buffer-hash`); the procedure is in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md). This table is updated with each upgrade.
