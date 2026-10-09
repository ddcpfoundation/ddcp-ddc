# Build verification

This document explains how anyone can rebuild the on-chain program in `program/` from this source and check that the result is the program deployed on devnet. It covers the program only. The command-line tool in `cli/` runs on the user's machine and is not deployed.

## What is compared

The program is built in a published Docker image named by its digest, so every builder uses the same compiler, the same Solana platform tools and the same file paths. Two builds of the same source in that image produce the same bytes.

Two hashes describe a build. Both are given below, labelled:

- **Executable hash.** The hash `solana-verify` reports: a SHA-256 of the program file with its trailing zero bytes removed. The same tool computes the same hash over a deployed program, so this is the hash to compare with the chain.
- **File SHA-256.** A plain SHA-256 of the program file `ddcp_ddc.so`. It identifies the file, and differs from the executable hash.

A build made outside the image, with `cargo build-sbf` on a developer's own machine, does not match. The platform tools embed the paths of the machine that built them, and those differ between distributions, so such a build differs from the image's in a few bytes even from the same source.

## The deployed build

| | |
|---|---|
| Program | `Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp`, devnet |
| Deployed | slot 507,622,712, transaction `3DtqncoMuyRUT45TJLdVpg8TKesC5nnBp1Q5tVNsGwjaCzvS7nXiLS1fniDP6BEANWLeHA7mP2ZU99QQJUp271G7` |
| Source | the first commit of this repository, the published snapshot, tagged `v0.1.0`. Its program was rebuilt in the image on 2026-10-09 (UTC) and gave the executable hash below. |
| Build image | `solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3` |
| Build tool | `solana-verify` 0.5.1 |
| Executable hash | `85481bc4143b6fcaaf7b4d8a24c765b94807a7daaea0e6b23c4a93af0e9ad60a` |
| File SHA-256 | `3c837f45f7981f55bab538a68bd98f69358cd5bec55c845eae7213f99f61c16c` |
| Size | 142,552 bytes |

## How to check it

You need Docker, `git`, and `solana-verify` 0.5.1 (`cargo install solana-verify --version 0.5.1`).

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

3. **Build in the image.** Name the image on the command, so that a different version of the tool cannot choose a different image:

   ```
   solana-verify build build --library-name ddcp_ddc --base-image solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3
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
- A build can fail partway with `error[E0463]: can't find crate` in one of the dependencies, before the program's own code is compiled. It was seen once in three builds of the deployed source; the same source built cleanly from a fresh unpacked copy. Build again from a new copy; do not reuse the directory of the failed build.
- `solana-verify` prints `Program Solana version: v0.0.0` when the image is given with `--base-image`. That line reports a value the tool did not read, not a property of the build.
- The image is the one `solana-verify` 0.5.1 selects for Solana 3.1.10, the version named in `[workspace.metadata.cli]` in `Cargo.toml`. Naming the image by digest makes the build independent of that selection.

## When the program changes

A change to the program's source reaches devnet only through an upgrade. An upgrade is made from a build in the image, and its buffer is checked against the build's executable hash before the upgrade is signed (`solana-verify get-buffer-hash`); the procedure is in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md). This table is updated with each upgrade.
