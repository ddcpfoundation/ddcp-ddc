# Program upgrade procedure

This document describes the upgrade arrangement a currency gives its own deployment of the program in `program/`, and how an upgrade is carried out under each arrangement. Every currency built using this repository deploys its own copy of the program at its own address; no currency is created on the Foundation's deployment. The Foundation's devnet deployment is a demonstration of the published code and stays under its deploy key (section 2). The Token-2022 program that holds every mint is a separate program with its own upgrade authority; that dependency is recorded in `LIMITS.md` and is not governed by anything here.

## 1. What the upgrade authority can and cannot do

Whoever holds a program's upgrade authority can replace its code. For this program that includes every rule it enforces: the co-signature required for every mint, the issuance pause, the two transfer-fee ceilings stored at genesis, and the requirement that the issuer, operator and reserve keys stay three distinct keys. The program holds the mint authority and the transfer fee configuration authority of every mint created with it, so replaced code could mint without the co-signature or set a fee above the ceilings. The ceilings are therefore only as settled as the program.

The upgrade authority cannot add a Freeze Authority or a Permanent Delegate to a mint that already exists: Token-2022 accepts neither after a mint is initialized. It cannot change a mint's Confidential Transfer settings where that mint's Confidential Transfer authority is none, and it cannot change token metadata, whose authorities are held by the issuer and not by the program.

## 2. The arrangements

| Stage of a deployment | Upgrade authority |
|---|---|
| Before its mint carries value: development, test networks, the period before an audit | A dedicated deploy key, held only for this purpose and separate from every holder key and every test key. |
| Backing a mint that carries value | A time-locked multisig: signers the issuer, the operator and the reserve, with a fourth independent signer recommended; threshold three of three, moving to three of four with the independent signer required once one is appointed; delay seven days. Member keys are distinct from the mint's co-signer keys. |
| Made permanent, if the currency chooses it | None, only after an audit (section 4). |

The Foundation's devnet demonstration stays in the first row: its upgrade authority is the deploy key named in the README, and it follows the published code. Anyone can create a mint on it, because creating a mint needs only the new mint's keypair and a payer; such a mint would be a test instrument like the reference mint, and the Foundation deploys the program nowhere a mint can carry value.

The seven-day delay is longer than the notice Token-2022 gives for a fee change, which takes effect two epochs after it is set, so no change of rules can take effect faster than a holder can leave. A currency publishes its program's address, its upgrade arrangement and, for a multisig, its address, threshold, the role of each member and the delay in its own specification.

The `state` command shows the program's current upgrade authority, or `none (program is immutable)`.

## 3. Upgrading under a deploy key

Commands are those of the Solana CLI, version 3.1.10, and `solana-verify` 0.5.1.

**Custody of the deploy key.** The deploy key is kept only in encrypted storage, outside any synced or cloud-backed folder and outside every repository, and is made readable only for the step that signs with it. Each command that signs with the deploy key (steps 2 and 5, and section 4) is run by the keyholder directly, never by an automated tool acting on the keyholder's behalf. Preparation and every check before and after are separate steps that need no access to the key. The storage is closed again as soon as the signing step ends.

1. **Build and record.** Build the program from a named commit in the verifiable-build image, as described in [BUILD_VERIFICATION.md](../BUILD_VERIFICATION.md), and record the executable hash the build reports.
2. **Write the buffer (signs with the deploy key).** `solana program write-buffer <path to .so> --buffer-authority <deploy key>`. Record the buffer address the command prints.
3. **Check the buffer.** `solana-verify get-buffer-hash -u <cluster URL> <buffer address>` must equal the executable hash recorded in step 1. Do not upgrade from a buffer that fails this check.
4. **Record the program's data account.** `solana program show <program id>` names the program's data account; read its balance with `solana balance <data account address> --lamports` before the upgrade.
5. **Upgrade (signs with the deploy key).** `solana program upgrade <buffer address> <program id> --upgrade-authority <deploy key>`. The loader moves the buffer's lamports, and any rent the data account holds above the current minimum, to a spill account; the CLI uses the fee payer as that account.
6. **Read back.** `solana program show <program id>` must report the new last deployed slot and an unchanged authority. `solana-verify get-program-hash -u <cluster URL> <program id>` must equal the executable hash recorded in step 1. The program's accounts (its state for each mint) are unchanged by an upgrade; read them back with `state`.
7. **Rent surplus.** Compare the data account's balance with step 4. Before its mint carries value, on a test network, a surplus may be left with the fee payer and recorded. Under a value-carrying arrangement it may not: see section 5.

**When a step fails.** A failed buffer write can print the buffer's recovery seed phrase. Keep command output out of shared transcripts, or filter it to error, program id, signature and close lines. Do not resume a partially written buffer: close it with `solana program close <buffer address> --recipient <address>` and start again from step 2. On the public devnet endpoint, `--use-rpc` has been observed to exhaust its write retries on a program of this size, while the default transport succeeded.

**Worked example (the devnet demonstration).** The Foundation's demonstration program `Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp` was upgraded in place under a devnet deploy key, last deployed slot 505,443,776, program bytes sha256 `accb46272b200beec0ebee9a0df18a5a370f55a6cf0b2f27114dfeae0eeadcbc`. The data account `3E12roc1asN7PwHQd8BrbfYcgJoUiSLQJVSPRRuWD9Je` had been funded at a higher rent minimum than the one in force at the upgrade, and 545,525,240 lamports of surplus moved to the deploy key as fee payer. On devnet it was recorded and left there. The program was later upgraded in place again from the verifiable build described in [BUILD_VERIFICATION.md](../BUILD_VERIFICATION.md): last deployed slot 507,622,712, executable hash `85481bc4143b6fcaaf7b4d8a24c765b94807a7daaea0e6b23c4a93af0e9ad60a`. Its upgrade authority is now the deploy key `8J6DmzQ8ZFLpAgnELpqtRmbL9ve6AB3nmGhxAG7bcWvR`; `state` shows it live.

## 4. Making a currency's program permanent

A currency may give its deployment no upgrade authority at all. This step cannot be undone. It is taken only when all of the following hold:

- an audit report on a commit of this repository, or of the currency's own source, is published and has no open finding of high or critical severity;
- the deployed program has been shown, by a verifiable build, to be the build of the audited commit (see `BUILD_VERIFICATION`): the audit certifies a commit, and the build verification proves the deployment matches it;
- the currency's Known Limits against DDCP and its specification record the change of upgrade arrangement.

Then, run by the keyholder: `solana program set-upgrade-authority <program id> --final --upgrade-authority <deploy key>`, followed by `solana program show <program id>` and `state`, which must report that the program is immutable.

After this:

- No change to the program is possible, including a fix. A defect is addressed by a new version (section 6).
- A lost co-signer key can no longer be repaired by an upgrade. The program replaces a co-signer key only with the operator and the reserve signing together. A lost issuer key can therefore still be replaced; until it is, minting, burning, the lifting of an issuance pause and fee changes stop. A lost operator key permanently stops fee changes and every key replacement; a lost reserve key permanently stops minting, burning, the lifting of an issuance pause, reserve statements and every key replacement. Holders can still transfer, because transfers are processed by Token-2022, not by this program.
- Anyone can create a new mint with the program, with authorities of their choice: creating a mint requires only the new mint's keypair and a payer. Whether such a mint conforms is a question about that currency, answered in its own specification.

## 5. A program backing a mint that carries value

The program is deployed under a deploy key, held as in section 3, until the multisig of section 2 is in place, and before the mint carries value.

The keys of the multisig members are distinct from the mint's co-signer keys. One lost key then removes at most one of the two: a co-signature on the mint, or a vote on the upgrade that can repair it.

Every upgrade is a multisig proposal, visible for the full delay before it can execute. The proposal:

- names the buffer, and the buffer is checked against a verifiable build of the source the currency has published;
- names the spill account deliberately, never defaulting to a fee payer;
- returns any rent released from the program's data account to that data account in the same proposal, so the surplus remains the program's and never passes to an operator.

The mainnet deployment checklist repeats the buffer and program hash checks of section 3 at the deployment itself.

## 6. New versions

A version of this program that follows an immutable one is deployed as a new program at a new address; it does not replace the old one. Each deployment has its own address, and the program runs at the address it is deployed at. The address declared in its source (`declare_id!` in `program/src/lib.rs`) is used only by its tests; a currency's copy declares its own there. Mints created on an earlier version keep that version's rules for as long as they exist: a new version applies to mints created with it. A currency whose program has a multisig upgrade authority can adopt a new version through section 5.

A defect found in an immutable program is disclosed in a security advisory and in the release note of the version that corrects it, naming the versions affected. Where the defect bears on a conformance criterion, LIMITS.md records it under that criterion. The disclosure states the migration path open to a currency whose program can no longer be upgraded: a new mint on the corrected version, with holders moved by that currency's issuer through redemption and reissue. Mints on a defective version are never moved by anyone else.
