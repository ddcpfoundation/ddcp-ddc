# ddc: the DDCP reference implementation on Solana

This repository is the reference implementation of the Decentralized Digital Currency Protocol (DDCP), published by DDCP Foundation Inc. It runs on Solana's Token-2022 program and contains:

- an on-chain program (`program/`) that governs a Token-2022 mint: minting with two signatures, burning from a redemption-collection account, an issuance pause, a reserve statement published by the reserve key, transfer-fee changes bounded by ceilings fixed at genesis, and rotation of the program's co-signers;
- a command-line tool, `ddc` (`cli/`), for holders and for the people who operate a currency built with it.

What the program does, instruction by instruction, is specified in [docs/SPECIFICATION.md](docs/SPECIFICATION.md).

`ddc` is a placeholder. A currency built from this repository replaces it with its own name; `ddcp` names the protocol and does not change. <!-- rename-currency: keep -->

`scripts/rename-currency.py` makes that replacement in every tracked file and then checks that no placeholder is left; run both test suites afterwards. It leaves the following unchanged:

- the npm scope `@ddcpfoundation`, which a currency replaces with its own;
- the program address;
- the test data captured from the reference mint;
- the descriptions of the Foundation's devnet demonstration in this README and in section 3 of docs/UPGRADE_PROCEDURE.md, which a currency replaces with its own deployment's.

It then lists, for a currency to check by hand, every line it left unchanged because the line carries its keep marker, and every line of the test files that names an address or key of the Foundation's devnet demonstration, where it stands for any address. It also lists every line outside the test files that still names one, and exits 1 until a currency has replaced those with its own deployment's values.

In this README, `ddc` stands for `node dist/index.js`, run from `cli/`.

This repository does not include steps for deploying the program at a new address or for creating a new mint; a currency built using this code performs those steps itself. The genesis scripts record how the reference devnet mint was created.

## Status

**Unaudited. Devnet only.** No independent security audit has been completed. [Known Limits against DDCP](LIMITS.md) records the audit status and is updated when a report is published.

## The deployed reference instance

Devnet only, as a demonstration of the published code. The Foundation deploys this program on no network where value can be carried. A currency built using this repository deploys its own copy of the program at its own address, under its own upgrade arrangement; no currency is created on the Foundation's deployment. The demonstration backs one reference mint, kept as a test instrument: it carries supply but has no value, no reserve and no redemption.

| | Devnet address |
|---|---|
| Program | `Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp` |
| Program upgrade authority | Deploy key `8J6DmzQ8ZFLpAgnELpqtRmbL9ve6AB3nmGhxAG7bcWvR`, separate from every holder key and test key. The demonstration stays upgradeable under it so that it follows the published code. The arrangement a currency gives its own deployment is in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md). |
| Reference mint | `9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa`. Token metadata: name `ddc`, symbol `DDC`, link `https://ddcp.dev/metadata/ddc-devnet.json`. <!-- rename-currency: keep --> |
| Reserve statement | `7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP`, published by the reserve key. The figure reads 0 (no reserve is held). Its document is `https://ddcp.dev/reserve/ddc-devnet.txt`, whose SHA-256 the statement's link carries; a readable page is at `https://ddcp.dev/reserve/ddc-devnet`. <!-- rename-currency: keep --> |

`ddc state` prints these addresses, every authority listed below and the public half of the withheld-fee decryption key, live from the chain.

Before the current reference mint, this program created two test mints on devnet; both are retired and carry no value.

### What every mint fixes

The program creates every mint it governs in its own genesis instruction. [docs/SPECIFICATION.md](docs/SPECIFICATION.md), section 2, covers three things:

- what that instruction fixes;
- what it leaves to the mint creator;
- what can be changed afterward, and by whom.

Creating a mint with this program does not by itself make it conforming; whether a mint conforms is a question about that currency, answered in its own published specification.

### Who holds each authority on the reference mint

| Authority | Holder |
|---|---|
| Mint authority | The program's mint-state account `GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B`. Minting needs the issuer and the reserve signing together. |
| Freeze Authority | None. |
| Confidential Transfer mint authority | None. |
| Transfer fee configuration authority | The program's fee account `48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu`, directed by the issuer and the operator signing together. |
| Withdraw-withheld authority | `J5aokYFjfeyWsXAzdXQGfQoUrx5Xc4WDc6BCVjyeopAQ`, a key held by the issuer, separate from its co-signer key. |
| Confidential Transfer fee authority | `CxVb4kZeyyzDfJqTAQVuhHomAb5JoAkH74eZdrCDZhzW`, a second key held by the issuer, separate from its co-signer key. |
| Withheld-fee decryption key | ElGamal public key `dvHT4Aldldboa/o8o0RZLCo09MLXx2UlOwPTZFcNCkM=`, fixed at genesis; its secret is held by the issuer. |
| Metadata pointer authority | `4QVtXiCKrhnPjHJenhPic25MKz5gvHSz6cfegpeh9oUe`, a key held by the issuer. |
| Metadata update authority | `BKBuFZExXGBH12Kt2vHxLduuKPGQZy1yL3E9rKfZPEKv`, a second key held by the issuer. |
| Co-signers in the program's record | Issuer `5AygggFgzsTFFbuQNYsxWoLRyJYpPwSzTWq3ZHdZStPV`, operator `BHbcbfSXvxU2toUw5R6YEqWNcCb6PpYaLd1QdoCPyUSU`, reserve `8Zff6SFUwZnS54qt2JiWodWQ2Hhrg25j3sWko6UzWUSx`: three distinct keys. |
| Program upgrade authority | The deploy key `8J6DmzQ8ZFLpAgnELpqtRmbL9ve6AB3nmGhxAG7bcWvR`. |

On this devnet instance a single keyholder holds every key in this table. The issuer, operator and reserve keys are three distinct keys, not three independent holders. The deploy key is a single key, which is one reason the demonstration carries no value and no currency is created on it. Because the reference mint carries no value, a key lost on it would be addressed by a new genesis at a new address. A currency built from this repository states in its own specification who holds each of its keys.

## Confidential Balances

Confidential Balances (the Confidential Balances suite of Solana Token Extensions, via the Token-2022 program) hides balances and transfer amounts, and only for a holder who chooses to turn it on. `ddc setup-privacy` asks for that choice before it does anything. We strongly recommend it on first use, and it is never turned on silently.

## What it does not do

Read the reference implementation's [Known Limits against DDCP](LIMITS.md) before relying on any property described here. In short:

- sender, receiver and timing are visible, and so are amounts moved into and out of a confidential balance;
- when a currency charges a transfer fee, the holder of its fee decryption key can narrow the amount of each confidential transfer from its fee;
- holders need SOL for network fees and account rent;
- every property fixed at genesis is bounded by the upgradeability of the Token-2022 program and of this program;
- the protocol does not enforce reserve backing or redemption;
- the command-line tool sends only to wallet addresses. It has no command that deposits into a currency's redemption-collection account; use general Token-2022 tooling for that step.

## Build

Requirements: Rust with the Solana tools 3.1.10 (`cargo build-sbf`, platform-tools v1.52), and Node.js 24.2 or later, below 25.

Program:

```
scripts/fetch-fixture-programs.sh   # once, from the repository root, before the first test run
cd program
cargo build-sbf                     # writes target/deploy/ddcp_ddc.so at the repository root
cargo test                          # against the mainnet-beta build of Token-2022
DDCP_TOKEN_2022=devnet cargo test   # against the devnet build of Token-2022
```

Command-line tool:

```
cd cli
npm ci
npm run build
npm test
```

Related documents:

- [docs/SPECIFICATION.md](docs/SPECIFICATION.md): what the program does, instruction by instruction.
- [BUILD_VERIFICATION.md](BUILD_VERIFICATION.md): how to rebuild the program from source and check it against the program deployed on devnet.
- [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md): how a deployment of the program is upgraded, and how a currency can make its own deployment permanent.

## Quickstart (devnet)

Read the mint, its authorities, the program's record for it and the upgrade arrangement. This sends nothing:

```
cd cli
node dist/index.js state --rpc-url https://api.devnet.solana.com
```

Holder commands, each taking `--keypair <path>` and a stated cluster (`--rpc-url <url>`, or `rpc_url` in `~/.ddc/config.json`):

| Command | What it does |
|---|---|
| `balance` | Public, confidential and pending figures for a wallet. |
| `setup-privacy` | Turns on Confidential Balances for your account, after asking. |
| `shield <amount>` | Moves an amount from your public balance into your confidential balance. |
| `unshield <amount>` | Moves an amount from your confidential balance to your public balance. |
| `apply-pending` | Moves confidential credits you have received into your available confidential balance. |
| `confidential-transfer <amount> <wallet>` | Sends an amount from your confidential balance. |
| `public-transfer <amount> <wallet>` | Sends an amount from your public balance. |

How each command confirms:

- `confidential-transfer`, `public-transfer` and `unshield` show what they will send and ask you to type `CONFIRM` first.
- `setup-privacy` asks for your consent.
- `shield` and `apply-pending` show what they will send and send once their checks pass.

A command exits with status 0 when it did what it exists to do, and 1 when it stopped short: a refusal, an abort or a decline.

The RPC endpoint you choose sees your network address and the accounts you query and sign for. If you configure a proxy, the proxy sees your network address and the endpoint sees the proxy's.

The `admin` commands are for the people who operate a currency: two signatures for mint, burn, fee and co-signer changes, prepared, countersigned and submitted as separate steps. `node dist/index.js` with no arguments lists them.

## License

Code: Apache-2.0, in [LICENSE](LICENSE). Written works published by the Foundation, including the Manifesto: CC BY 4.0. Third-party notices are in [NOTICE](NOTICE).

## Contributing

Contributions are welcome under the Developer Certificate of Origin: sign off each commit (`git commit -s`). There is no contributor license agreement. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report a vulnerability privately, never in a public issue. See [SECURITY.md](SECURITY.md).

## Trademark

DDCP is a trademark of DDCP Foundation Inc (U.S. application pending). The license covers the code, not the mark. A currency built from this repository may state its provenance as "Built as a fork of the DDCP reference implementation"; a currency built without this code may state "Based on the DDCP protocol". Any implication of endorsement by the Foundation, or of conformance to the protocol, is permitted only as recorded in the Foundation's [conformance evaluations](https://github.com/ddcpfoundation/conformance-evaluations). The trademark usage policy is in the Foundation's governance repository: [TRADEMARK_USAGE_POLICY.md](https://github.com/ddcpfoundation/protocol-governance/blob/main/TRADEMARK_USAGE_POLICY.md).

The DDCP reference implementation is published at https://github.com/ddcpfoundation/ddcp-ddc. <!-- rename-currency: keep -->

## The Manifesto

The commitments this implementation works toward are set out in the DDCP Manifesto, in the Foundation's governance repository: [MANIFESTO.md](https://github.com/ddcpfoundation/protocol-governance/blob/main/MANIFESTO.md).
