# Known Limits against DDCP

This file is the reference implementation's Known Limits against DDCP: for each of the fifteen [DDCP conformance criteria](https://github.com/ddcpfoundation/protocol-governance/blob/criteria-v20261008-2/CRITERIA.md), what this program and command-line tool deliver, how, and where they fall short. It describes the code in this repository as it would run in a deployment that carries value. It describes neither the protocol nor DDCP Foundation Inc. The Foundation's own deployment, on devnet, is described in the [README](README.md#the-deployed-reference-instance). A currency built using this code publishes its own Known Limits against DDCP. This file is versioned with the code; cite it by commit.

**As of:** `v0.1.0`, 2026-10-09 (UTC).

Each section has up to three parts:

- **Delivered** is what the code does toward the criterion and how.
- **Limits** is where it falls short, one gap per line. A gap that also bears on another criterion is referenced there by number.
- **Depends on** names what the delivered part rests on that this code does not control, and who controls it. A section without that part depends on nothing outside the code.

What the program does, instruction by instruction, is in [docs/SPECIFICATION.md](docs/SPECIFICATION.md). Who holds each authority is a fact about each deployment, stated in its own specification.

The Foundation examines this record in its own evaluation of the reference implementation, published in the [evaluation registry](https://github.com/ddcpfoundation/conformance-evaluations). This file is the implementation describing itself; the evaluation may disagree with it.

## 1. Control

- **Delivered.** The genesis creates a mint with no Freeze Authority, no Permanent Delegate and a Confidential Transfer mint authority of none. No key can freeze a token account, move value out of one, add an auditor key or switch off automatic approval of confidential accounts. The genesis instruction offers no other configuration, and refuses a Confidential Transfer mint authority other than none. Holders' transfers are processed by Token-2022, not by this program, so nothing this program does can stop them.
- **Limits.**
  - Every absence above holds under the current Token-2022 code. Whoever holds Token-2022's upgrade key can undo it, for every token at once (see 2, 14).
  - Whoever holds a deployed program's upgrade authority can change what it does, including the genesis checks (see 12, 14).
- **Depends on.**
  - The Token-2022 program and its upgrade key. At the reading of 2026-10-08, its upgrade authority on mainnet-beta was `AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz`. The address has no private key; only a program that derives it can sign for it. The chain records the address, not who controls it.
  - An open upstream proposal for a confidential permanent delegate would require holders to share their secret keys, and cannot reach a holder who refuses.

## 2. Unconditionality

- **Delivered.** No spending restriction, expiry or behavioral condition exists in the program, and none can be set on a mint it creates. The genesis fixes exactly five extensions, none of them a Transfer Hook, so no program other than Token-2022 executes on a transfer of the currency. Programs a holder chooses to send value to are outside this.
- **Limits.**
  - Bounded by Token-2022 upgradeability (see 1).
- **Depends on.** As 1.

## 3. Settlement

- **Delivered.** Nothing toward this criterion. Transfers are confirmed by the validators of the chain this implementation runs on. The Foundation does not claim the settlement aim is realized.
- **Limits.**
  - The criterion is not delivered by this implementation or by any infrastructure it uses.
- **Depends on.** The host chain and its validators.

## 4. Privacy: balance and amount

- **Delivered.** A holder can turn on Confidential Balances with `setup-privacy`, which asks first; it is strongly recommended on first use and never turned on silently. That holder then has an encrypted balance, and the amount of each confidential transfer is encrypted. The keys for it are derived from the wallet's signing key and can be regenerated from it.
- **Limits.**
  - **Opt-in only.** It covers only holders who turn it on. The public balance and its history are fully visible, so value that passes through a public balance carries a traceable history.
  - **Shield and unshield amounts.** Amounts moved into and out of the confidential balance (`shield`, `unshield`) are visible.
  - **Fee decryption key.**
    - Where a currency charges a transfer fee, the fee on each confidential transfer is encrypted to the withheld-fee decryption key fixed at genesis.
    - Whoever holds that key and knows the rate can narrow the amount of any transfer whose fee is below the absolute ceiling. The band is 10,000 divided by the rate, in base units: at 100 basis points, within 100 base units, or 0.0001 of a unit at six decimals.
    - A transfer whose fee reaches the ceiling shows only that it is at or above that size.
    - At a zero fee schedule, which the genesis sets, nothing is revealed this way (see 11).
  - **Wallet derivation.** Only wallet software that derives the keys the same way can read a confidential balance; a wallet that derives differently will not show it (see 15).
  - **Size limits.**
    - One confidential transfer or shield carries at most 2^48 − 1 base units (281,474,976.710655 units at six decimals); larger amounts go in parts.
    - An account accepts at most 65,536 incoming confidential transfers before its holder runs `apply-pending`; the tool warns as the count nears the limit.
- **Depends on.**
  - The Confidential Balances suite of Solana Token Extensions, via the Token-2022 program.
  - Solana's zero-knowledge proof program and the client libraries that build proofs.
    - The program has been disabled in the past for security fixes.
    - While it is disabled, turning on Confidential Balances, confidential transfers and unshielding stop.
    - Shielding, applying pending credits and public transfers continue (see 15).
  - The RPC endpoint the holder chooses, which sees the network address of each request and the accounts queried and signed for. With a proxy, the proxy sees the address and the endpoint sees the proxy's.

## 5. Privacy: sender and receiver

- **Delivered.** Nothing toward this criterion. The sending and receiving token accounts of every transfer, confidential or public, are visible on chain.
- **Limits.**
  - The criterion is not delivered.
- **Depends on.** The design of Token-2022's confidential transfers, which conceal amounts and balances only.

## 6. Privacy: timing and frequency

- **Delivered.** Nothing toward this criterion. Every transaction is timestamped and attributable to its accounts on chain.
- **Limits.**
  - The criterion is not delivered.
- **Depends on.** As 5.

## 7. Lawful access

- **Delivered.** The part about administrative override: no key can reach value held in self-custody (see 1). Nothing in this code identifies anyone or records anything about anyone.
- **Limits.**
  - The intermediary layer is outside this code. In a deployment that carries value, identity sits with whatever licensed intermediaries a currency uses at its entry and exit points.
  - Whether identity and records are reachable through judicial process, and only through it, is a fact about that currency's intermediaries, stated in its own specification. Nothing here delivers or prevents it.

## 8. Backing

- **Delivered.**
  - The program records a reserve statement published by the reserve key. It holds one figure (the value of the reserve, in the currency's unit of account, in base units), the time of publication, and a link to a document.
  - The specification asks that the document state the time of measurement and how the reserve was valued, and that the link carry the document's SHA-256 ([docs/SPECIFICATION.md](docs/SPECIFICATION.md), section 9). The program stores the link as given.
  - `ddc state` prints it. Supply is public, so anyone can compare the stated reserve with supply.
- **Limits.**
  - The program does not check the statement, and minting does not depend on it. Backing is asserted by whoever publishes the statement; verification is whatever that statement's document and any named attestor provide.
  - The program does not enforce redemption. A deposit into a redemption-collection account is a transfer; paying out against it is the issuer's act, outside the chain.
  - A currency pegged to a national currency carries that currency's purchasing power, whatever it retains or loses. Full backing covers the promise, not its purchasing power. The code does not fix what a currency is anchored to.

## 9. Reserve structure

- **Delivered.** The reserve role is a distinct co-signer: every mint needs the issuer and the reserve signing together, and the reserve key alone publishes the reserve statement. The three co-signer keys must be distinct at genesis and at every replacement.
- **Limits.**
  - Distinct keys are not independent holders. Whether the reserve key is held by an institution separate from the issuer is a fact about each currency (see 12, 13).
  - No independent reserve foundation exists today. Separation, ring-fencing and independent attestation are conditions a currency meets or does not; the code places no constraint on any of them.

## 10. Reserve dispersion

- **Delivered.** Nothing toward this criterion. The code places no constraint on where reserves are held.
- **Limits.**
  - The criterion is not delivered by this code. It is a fact about each currency's reserves, and about the regulatory constraint its specification discloses.

## 11. Fee ceilings

- **Delivered.**
  - Two ceilings are set at genesis and stored in program state: a basis-points ceiling (at most 10,000) and an absolute per-transfer ceiling. Neither can be raised.
  - Fee changes above either ceiling are refused. A ceiling of zero means that fee can never be charged.
  - The genesis sets the fee schedule itself to zero.
  - The genesis instruction's documentation (`program/src/instruction.rs`) gives the reference mint's ceilings, 100 basis points and one whole unit. The program applies no default: both ceilings are required arguments.
  - `ddc state` prints the ceilings, the schedule in force and the fee authority holder.
- **Limits.**
  - The ceilings are enforced by this program, so whoever can upgrade the deployed program can remove the check (see 12, 14). The ceilings and the upgrade arrangement are therefore always disclosed together.
  - The ceilings are the mint creator's choice at genesis; a high ceiling is permitted (see 14).
  - A fee change takes effect two epochs after it is set, by Token-2022's rules.
  - Where fees are above zero, the fee decryption key narrows confidential amounts (see 4).

## 12. Authority allocation

- **Delivered.**
  - Minting needs the issuer and the reserve together; fee changes need the issuer and the operator together.
  - The issuance pause can be set by any one of the three co-signers alone and lifted only by the issuer and the reserve together. It halts new minting only, and touches no holder's balance or transfer.
  - A co-signer key is replaced only by the operator and the reserve signing together, whichever key is replaced, so the issuer can be replaced without its own signature.
  - The arrangement for a program backing a mint that carries value is in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md): a time-locked multisig with member keys distinct from co-signer keys, or no authority at all after an audit.
  - `ddc state` prints every authority and its holder.
- **Limits.**
  - **Distinct keys, not independent holders.** The code enforces three distinct co-signer keys, not three independent holders (see 9).
  - **The upgrade authority contains every other control.** Whoever holds it can remove the ceiling check and the two-signature mint.
  - **Lost keys.**
    - Losing the issuer key stops minting, burning, the lifting of an issuance pause and fee changes until the operator and the reserve replace it.
    - Losing the operator key stops fee changes and every key replacement.
    - Losing the reserve key stops minting, burning, the lifting of a pause, reserve statements and every key replacement, so redemptions that require a burn stop too.
    - Any remaining key can still set the pause, and transfers continue in every case.
    - While a deployed program is upgradeable, an upgrade can repair what a lost key stops. Once a currency has made its program permanent, nothing can.
  - **Nonce accounts.** With this command-line tool, a replacement for a lost issuer key also needs a new durable-nonce account. The tool's nonce accounts are set in `cli/src/constants.ts`, and a nonce account can be handed over only by its current holder.
  - **Metadata authorities.** The genesis gives the metadata authorities, like the issuer's other authority keys, to whatever keys the mint creator names. The code provides no multi-party control over them. Once a currency carries value, the criterion is met only if the mint creator gives them to multi-party arrangements; which kind each authority accepts is in [docs/SPECIFICATION.md](docs/SPECIFICATION.md), section 3.1.
- **Depends on.** The holder of the program's upgrade authority, named in each deployment's own specification.

## 13. Accurate disclosure of capabilities

- **Delivered.** [docs/SPECIFICATION.md](docs/SPECIFICATION.md) states every capability the program creates over a mint, who can exercise it and under what conditions. `ddc state` reads from the chain every authority, and the public half of the withheld-fee decryption key, for any mint the program created.
- **Limits.**
  - **Unaudited.** Before an independent audit, the code is checked with automated static-analysis tools and with adversarial tests written separately from the implementation, from its instruction list, account constraints and error codes. Neither is an audit. An audit, when published, certifies a commit of this repository; a currency proves that its own deployment matches that commit, or states its changes to it. This section is updated when a report is published.
  - **Tested against two pinned Token-2022 builds.** The program suite runs against the Token-2022 build deployed on mainnet-beta and against the one deployed on devnet, which differ, each pinned by its SHA-256 in a record in `program/tests/fixtures/`. A later Token-2022 upgrade on either cluster is not tested until its binary is fetched again and the suite re-run ([docs/TEST_COVERAGE.md](docs/TEST_COVERAGE.md), section 7).
  - **No development history.** The published repository starts from a single snapshot commit, with no record of what was tested and rejected before it. The development history records are retained privately. The Foundation's evaluations rest on on-chain inspection, review of deployed code and the published specification, not on a development history.
  - **Holders are per deployment.** The specification describes the code. Who holds each capability is a fact about each deployment, stated in its own specification.

## 14. Disclosure of mutability

- **Delivered.** [docs/SPECIFICATION.md](docs/SPECIFICATION.md), section 2, states what the genesis fixes for every mint it creates, what it leaves to the mint creator, and what can be changed afterward and by whom.
- **Limits.**
  - "Fixed at genesis" holds under the current Token-2022 code (see 1) and under the deployed program's upgrade arrangement (see 12). Every settled property in this file is bounded by both.
  - A currency with the conforming profile cannot be wound down by force:
    - tokens keep moving;
    - confidential balances cannot be compelled to redeem;
    - the mint cannot close while supply exists;
    - the issuance pause is the only wind-down tool.

    Each issuer's policy for unredeemed residual reserves is its own.

## 15. Basics and payments

- **Delivered.** The currency is divisible to six decimals, transferable to any Solana wallet address at any hour, fungible, and counterfeit-proof to the extent the chain is. A confidential transfer is one transaction carrying its proofs, with no temporary accounts and no rent to return, at the same signature fee as a public transfer.
- **Limits.**
  - **SOL for fees and rent.** Holders need SOL for network fees and for account rent, paid by whoever signs. A fee-payer relay is not built; when built, it will cover network fees only, and rent remains the holder's.
  - **Confidential transfer mechanics.**
    - A confidential transfer needs the network's newer transaction format.
    - It takes longer to prepare, because the proofs are built on the sender's machine.
    - The recipient's account must have Confidential Balances turned on, which makes it larger and holds more rent than a public account.
    - The recipient runs `apply-pending`, a transaction of its own, before the amount can be spent.
  - **Wallet portability.** Portability of a confidential balance between wallets depends on wallet software using the same key derivation as the Token-2022 client libraries. A test in the tool (`cli/src/confidential-keys.test.ts`) checks that this tool's derivation is byte-identical to theirs at the version it pins. Wallet compatibility has not been measured.
  - **Proof program.** Confidential operations stop while the proof program is disabled (see 4).
- **Depends on.** The host chain's fee and rent rules; wallet developers; the proof program and its client libraries.
