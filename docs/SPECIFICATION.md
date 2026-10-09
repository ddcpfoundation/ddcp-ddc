# Specification of the reference program

This document specifies the program in `program/` and the mints it creates: how a mint is configured, the roles and authorities, every instruction with its accounts, arguments, checks and effects, the program's records and errors, and the documents a mint links to. Its last section maps the command-line tool in `cli/` to the instructions.

It describes the code, not the protocol. DDCP's commitments are in the [Manifesto](https://github.com/ddcpfoundation/protocol-governance/blob/main/MANIFESTO.md), and the criteria a currency is examined against are in [CRITERIA.md](https://github.com/ddcpfoundation/protocol-governance/blob/criteria-v20261008-2/CRITERIA.md). Where this code falls short of those criteria is in [LIMITS.md](../LIMITS.md). Who holds each authority is a fact about each deployment: the Foundation's devnet demonstration is described in the [README](../README.md#the-deployed-reference-instance), and a currency built using this code states its own holders in its own specification.

## 1. Conventions

- **Placeholder.** `ddc`, `DDC` and `Ddc` in this document are the currency placeholder, which a currency built from this repository renames (for example `DdcError` becomes `XyzError`); `ddcp` names the protocol and never changes. <!-- rename-currency: keep -->
- **Account positions** in instruction account lists are counted from 1.
- **Amounts** are in base units. Every mint the program creates has six decimals: one unit is 1,000,000 base units.
- **Instruction data** begins with an 8-byte discriminator, the first 8 bytes of `SHA-256("global:<instruction_name>")`, followed by the arguments in borsh encoding, in the order listed: integers little-endian, strings and byte vectors with a 4-byte length prefix, an optional value with a 1-byte tag.
- **Account data** of the program's records begins with an 8-byte discriminator, the first 8 bytes of `SHA-256("account:<RecordName>")`, followed by a fixed-size borsh body.
- These encodings are compatible with Anchor; the program does not depend on it.
- **Reserve statement.** The record of the reserve's value is called a reserve statement in this document and in the command-line tool. On chain it keeps its original names: the instruction `publish_attestation`, the record `AttestationRecord` with seed `"attestation"`, its fields `attested_reserve_amount`, `attestation_timestamp`, `attestor_pubkey` and `attestation_uri`, and the error `InvalidAttestationUri`. The names do not mean the figure is attested by anyone; see section 9.

The Rust package is `ddcp-ddc`, built as the library `ddcp_ddc`. The program's address is declared in its source (`declare_id!` in `program/src/lib.rs`) and used by the program's own tests. At run time the program uses the address it is deployed at and never compares it with that line. A currency built from this repository declares its own deployment's address there, so that its tests refer to it.

## 2. The mint

The program creates every mint it governs, in its genesis instruction (I-1). Anyone can create a mint with the program: I-1 needs only the new mint's keypair and a payer. Creating a mint with this program does not by itself make it conforming; whether a mint conforms is a question about that currency, answered in its own specification.

### 2.1 Fixed by the genesis for every mint

These properties are settled at genesis. Each holds under the current Token-2022 code and under the deployed program's upgrade arrangement (see LIMITS.md, sections 1 and 14).

- **Token program.** The mint is a Token-2022 mint.
- **Extensions.** Exactly five, initialized in this order:
  1. Confidential Transfers (`ConfidentialTransferMint`);
  2. Transfer Fee (`TransferFeeConfig`);
  3. Confidential Transfer Fee (`ConfidentialTransferFeeConfig`);
  4. Metadata Pointer (`MetadataPointer`);
  5. Token Metadata, stored on the mint itself and initialized last.

  Token-2022 accepts a fixed-size mint extension only before the mint itself is initialized. Token Metadata is the exception: Token-2022 initializes it afterward, on a mint that already carries a Metadata Pointer, which is why it comes last. A token group is the other exception, and it needs a group pointer set before initialization, which this mint does not have. A mint created by this program can therefore never carry a Permanent Delegate, Pausable, Transfer Hook, Default Account State, Confidential Mint Burn or Mint Close Authority extension, and cannot join a token group.
- **Decimals.** Six.
- **Freeze Authority.** None. Token-2022 does not allow one to be added afterward.
- **Mint Authority.** The program's record PDA-1. No instruction hands it to another key.
- **Transfer fee configuration authority.** The program's address PDA-3. No instruction hands it to another key.
- **Confidential Transfers.** Automatic approval of new confidential accounts is on and there is no auditor key. Both are made permanent by a Confidential Transfer mint authority of none, which the genesis requires (error 6011 otherwise).
- **Withheld-fee decryption key.** The ElGamal public key under which the fee of every confidential transfer is encrypted, given at genesis. No instruction, in this program or in Token-2022, can change it.
- **Fee ceilings.** A rate ceiling in basis points (at most 10,000) and an absolute ceiling per transfer in base units, stored in PDA-1. No instruction raises either; a ceiling of zero means that fee can never be charged.
- **Co-signers.** Three distinct keys for the issuer, operator and reserve roles, kept distinct at every replacement (error 6012).

### 2.2 Set at genesis and changeable afterward

| Property | At genesis | Changed by | How |
|---|---|---|---|
| Fee rate and maximum fee | 0 and 0 | Issuer and operator together | I-6, up to the ceilings; takes effect two epochs after it is set (section 7) |
| Minimum fee record | 0 | Issuer and operator together | I-6; recorded, not enforced on chain (section 7) |
| Issuance pause | Off | Set by any one co-signer; lifted by issuer and reserve together | I-4, I-5 (section 8) |
| Issuer, operator and reserve keys | As given | Operator and reserve together | I-8 (section 3) |
| Reserve statement | Empty | Reserve | I-7 (section 9) |
| Name, symbol and metadata link | As given | Token Metadata update authority | Token-2022 |
| Where the metadata pointer points | The mint itself | Metadata Pointer authority | Token-2022 |
| Whether confidential withheld fees can be collected into the mint | On | Confidential Transfer fee authority | Token-2022 |
| Holder of the withdraw-withheld authority, the Confidential Transfer fee authority, the Metadata Pointer authority and the Token Metadata update authority | As given | Each authority's current holder | Token-2022: handed to another key or given up |

### 2.3 Left to the mint creator at genesis

The values of the two fee ceilings; the keys that hold the issuer, operator and reserve roles; the four authority keys in the last row above; the withheld-fee decryption key; and the name, symbol and metadata link.

## 3. Roles and authorities

### 3.1 Every authority on a mint

| Authority | Held by | Exercised when | Can it move? |
|---|---|---|---|
| Mint Authority | PDA-1 | The issuer and the reserve sign I-2 | No instruction moves it |
| Freeze Authority | None | — | Cannot be added |
| Confidential Transfer mint authority | None | — | Cannot be restored |
| Transfer fee configuration authority | PDA-3 | The issuer and the operator sign I-6 | No instruction moves it |
| Redemption-collection authority | PDA-5 | The issuer and the reserve sign I-3 | No instruction moves it |
| Withdraw-withheld authority | A key named at genesis | Its holder, directly through Token-2022, withdraws withheld fees, public and confidential; a confidential withdrawal also needs a proof made with the withheld-fee decryption key's secret | Its holder |
| Confidential Transfer fee authority | A key named at genesis | Its holder, directly through Token-2022, switches on or off whether confidential withheld fees can be collected into the mint; it withdraws nothing | Its holder |
| Withheld-fee decryption key | An ElGamal key pair; the public key is on the mint, the secret is held off chain by whoever generated it | Whoever holds the secret can decrypt the fee carried by each confidential transfer | Never |
| Metadata Pointer authority | A key named at genesis (argument) | Its holder, through Token-2022 | Its holder |
| Token Metadata update authority | A key named at genesis (account 7 of I-1) | Its holder, through Token-2022 | Its holder; giving it up makes the metadata permanent |
| Issuer, operator and reserve | Three keys stored in PDA-1 | The instructions in 3.2 | I-8 |
| Program upgrade authority | Set by whoever deploys the program | Replacing the program's code | See [docs/UPGRADE_PROCEDURE.md](UPGRADE_PROCEDURE.md) |

The Metadata Pointer authority and the Token Metadata update authority are separate fields and may be separate keys: the first governs where the metadata is, the second what it says.

For the issuer, operator and reserve, the program checks only that the stored key signed. An address that signs by cross-program call, such as a multisig program's vault, counts as a signer, so any of the three can be such an address. A Token-2022 multisig account cannot sign this program's instructions. Token-2022 accepts one for the withdraw-withheld, Confidential Transfer fee and Metadata Pointer authorities, but not for the Token Metadata update authority, which must sign itself. The command-line tool signs only with key files.

### 3.2 Who signs each instruction

| Instruction | Signers |
|---|---|
| I-1 `initialize_mint` | The new mint's keypair and the payer; no stored authority exists yet |
| I-2 `mint_tokens` | Issuer and reserve |
| I-3 `burn_tokens` | Issuer and reserve |
| I-4 `pause_issuance` | Any one of issuer, operator, reserve |
| I-5 `resume_issuance` | Issuer and reserve |
| I-6 `update_transfer_fee` | Issuer and operator |
| I-7 `publish_attestation` | Reserve alone |
| I-8 `rotate_signer` | Operator and reserve |

### 3.3 Replacing a co-signer key

Any of the three co-signer keys is replaced by I-8, signed by the operator and the reserve together, whichever key is replaced. The issuer cannot replace any key, its own included, and can itself be replaced without its signature. After a replacement the three keys must still be distinct. What each lost key stops is in LIMITS.md, section 12.

## 4. Instructions

There are eight, numbered I-1 to I-8 in the code. A refused instruction changes nothing.

### I-1 `initialize_mint`

Creates a mint with the configuration of section 2.1, and the program's records PDA-1 and PDA-2 for it.

**Discriminator** `d12ac3048155d12c`.

**Arguments** (`InitializeMintArgs`, in order):

| Field | Type | Notes |
|---|---|---|
| `issuer_authority` | Pubkey | |
| `operator_authority` | Pubkey | |
| `reserve_authority` | Pubkey | The three must be distinct |
| `confidential_transfer_mint_authority` | Option&lt;Pubkey&gt; | Must be none |
| `confidential_transfer_fee_authority` | Pubkey | |
| `withdraw_withheld_authority_elgamal_pubkey` | [u8; 32] | The withheld-fee decryption key's public half |
| `withdraw_withheld_authority` | Pubkey | |
| `name` | String | |
| `symbol` | String | |
| `uri` | String | Link to the metadata document (section 11) |
| `metadata_pointer_authority` | Pubkey | |
| `fee_ceiling_basis_points` | u16 | At most 10,000 |
| `fee_ceiling_base_units` | u64 | |

The Token Metadata update authority is not an argument: it is the address of account 7.

**Accounts:**

1. `mint` (writable, signer): the new mint's keypair
2. `PDA-1` (writable): created here
3. `PDA-2` (writable): created here
4. `payer` (writable, signer)
5. `system_program`
6. `token_2022_program`
7. `metadata_update_authority` (read-only, not a signer): its address becomes the Token Metadata update authority

**Checks, in order, after the account checks:** a rate ceiling above 10,000 (6010); a Confidential Transfer mint authority other than none (6011); co-signer keys that are not three distinct keys (6012); a default key in account 7 (6004). A mint that already exists is refused by the System program when the instruction tries to create its account.

**Effects:**

- creates the mint, funded by the payer to the rent-exempt minimum for its final size, and initializes the five extensions in the order of section 2.1;
- transfer fee: rate 0, maximum 0, fee authority PDA-3, withdraw-withheld authority from the argument;
- Confidential Transfer Fee: authority and withheld-fee key from the arguments;
- Metadata Pointer: authority from the argument, pointing to the mint itself;
- Token Metadata: name, symbol and link from the arguments, update authority account 7, initialization signed by PDA-1;
- Freeze Authority none; Mint Authority PDA-1;
- creates PDA-1 unpaused, with the three co-signer keys, minimum fee 0 and the two ceilings;
- creates PDA-2 with every field zero except its bump.

### I-2 `mint_tokens`

Mints new supply to a token account of the mint.

**Discriminator** `3b8418f67a2708f3`. **Arguments** (`MintTokensArgs`): `amount` (u64). Instruction data is 16 bytes.

**Accounts:**

1. `mint` (writable)
2. `destination` (writable): a token account of this mint
3. `PDA-1` (read-only)
4. `issuer_authority` (signer)
5. `reserve_authority` (signer)
6. `token_2022_program`

**Checks, in order:** the destination belongs to another mint (6007); a signer does not match the stored issuer or reserve (6001); issuance is paused (6000). A wrong signer on a paused mint therefore receives 6001.

**Effects:** mints `amount` to the destination, signed by PDA-1. The reserve statement (PDA-2) is not read: minting does not depend on it.

### I-3 `burn_tokens`

Burns from a redemption-collection account (section 10).

**Discriminator** `4c0f33fee5d77942`. **Arguments** (`BurnTokensArgs`): `amount` (u64). Instruction data is 16 bytes.

**Accounts:**

1. `mint` (writable)
2. `source` (writable): a token account of this mint whose owner is PDA-5
3. `PDA-1` (read-only)
4. `PDA-5` (read-only): signs the burn
5. `issuer_authority` (signer)
6. `reserve_authority` (signer)
7. `token_2022_program`

**Checks, in order:** the source belongs to another mint (6007); a signer does not match the stored issuer or reserve (6001); the source's owner is not PDA-5 (6001). There is no pause check: burning works while issuance is paused.

**Effects:** burns `amount` from the source, signed by PDA-5, reducing supply. Token-2022 refuses a burn above the source's balance.

### I-4 `pause_issuance`

Sets the issuance pause, which stops I-2 only (section 8).

**Discriminator** `c70d81ec90b58a98`. **Arguments:** none; instruction data is the 8-byte discriminator, and any further bytes are refused (`InvalidInstructionData`).

**Accounts:**

1. `mint` (read-only): used only to derive PDA-1
2. `PDA-1` (writable)
3. `authority` (signer): any one of the three co-signers

**Checks:** the signer is none of the three stored keys (6001).

**Effects:** sets `pause_active`. Pausing a paused mint succeeds and changes nothing.

### I-5 `resume_issuance`

Lifts the issuance pause.

**Discriminator** `e10ad2de30200b92`. **Arguments:** none; as I-4.

**Accounts:**

1. `mint` (read-only): used only to derive PDA-1
2. `PDA-1` (writable)
3. `issuer_authority` (signer)
4. `reserve_authority` (signer)

**Checks:** a signer does not match the stored issuer or reserve (6001).

**Effects:** clears `pause_active`. Resuming a mint that is not paused succeeds and changes nothing.

### I-6 `update_transfer_fee`

Changes the transfer fee within the ceilings.

**Discriminator** `876a394d5df7d29e`. **Arguments** (`UpdateTransferFeeArgs`): `new_fee_basis_points` (u16), `new_maximum_fee` (u64), `new_minimum_fee` (u64). Instruction data is 26 bytes.

**Accounts:**

1. `mint` (writable)
2. `PDA-3` (read-only): signs the fee change
3. `PDA-1` (writable)
4. `issuer_authority` (signer)
5. `operator_authority` (signer)
6. `token_2022_program`

**Checks, in order:** a signer does not match the stored issuer or operator (6001); the minimum fee is above the maximum (6002); the rate is above the rate ceiling (6008); the maximum fee is above the absolute ceiling (6009).

**Effects:** sets the rate and maximum fee on the mint through Token-2022, signed by PDA-3; they take effect two epochs later. Writes the minimum fee to PDA-1.

### I-7 `publish_attestation`

Publishes the reserve statement (section 9).

**Discriminator** `7726782d56169137`. **Arguments** (`PublishAttestationArgs`): `attested_reserve_amount` (u64) and `attestation_uri` (bytes, at most 128). Instruction data is 20 bytes plus the link's length: the discriminator (8 bytes), the figure (8) and the link's 4-byte length prefix, then the link.

**Accounts:**

1. `mint` (read-only): used only to derive the records
2. `PDA-2` (writable)
3. `PDA-1` (read-only)
4. `reserve_authority` (signer)

**Checks, in order:** the signer is not the stored reserve (6001); the link is longer than 128 bytes (6003).

**Effects:** overwrites PDA-2 with the figure, the cluster clock at publication, the signer's key and the link, zero-padded to 128 bytes. Earlier statements remain only in the transaction history.

### I-8 `rotate_signer`

Replaces one co-signer key.

**Discriminator** `c687351b15cb0800`. **Arguments** (`RotateSignerArgs`): `role` (u8: 0 issuer, 1 operator, 2 reserve) and `new_pubkey` (Pubkey). Instruction data is 41 bytes.

**Accounts:**

1. `mint` (read-only): used only to derive PDA-1
2. `PDA-1` (writable)
3. `operator_authority` (signer)
4. `reserve_authority` (signer)

**Checks, in order:** a signer does not match the stored operator or reserve (6001); the new key is the default key (6004); the role is above 2 (6005); the three keys would not be distinct after the replacement (6012).

**Effects:** writes the new key into the role's slot in PDA-1. The replaced key is refused by every instruction afterward.

## 5. The program's records

The program derives four addresses from each mint, numbered 1, 2, 3 and 5. There is no PDA-4, and the number is not reused. Each is derived from its seed and the mint's address; the program accepts only the canonical derivation.

| Number | Seeds | Data | Role |
|---|---|---|---|
| PDA-1 | `"mint_state"`, mint | `MintState`, 178 bytes | The mint's state; the mint's Mint Authority |
| PDA-2 | `"attestation"`, mint | `AttestationRecord`, 185 bytes | The reserve statement; written by I-1, which creates it, and by I-7; read by no instruction |
| PDA-3 | `"fee_authority"`, mint | None | The mint's transfer fee configuration authority |
| PDA-5 | `"redemption_authority"`, mint | None | Owner of redemption-collection accounts; signs the burn in I-3 |

**`MintState`**, after its 8-byte discriminator:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `pause_active` | bool | Issuance pause |
| 9 | `issuer_authority` | Pubkey | |
| 41 | `operator_authority` | Pubkey | |
| 73 | `reserve_authority` | Pubkey | |
| 105 | `minimum_fee` | u64 | Recorded by I-6; not enforced on chain (section 7) |
| 113 | `fee_ceiling_basis_points` | u16 | |
| 115 | `fee_ceiling_base_units` | u64 | |
| 123 | `reserved` | [u8; 54] | Zero at genesis; no instruction uses it |
| 177 | `bump` | u8 | |

**`AttestationRecord`**, after its 8-byte discriminator:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `attested_reserve_amount` | u64 | The reserve's value in the currency's unit of account, in base units |
| 16 | `attestation_timestamp` | i64 | The cluster clock at publication; not the time of measurement |
| 24 | `attestor_pubkey` | Pubkey | The key that published it; the default key means none has been published |
| 56 | `attestation_uri` | [u8; 128] | The link to the statement's document, zero-padded |
| 184 | `bump` | u8 | |

## 6. Errors

### 6.1 The program's errors

The enum is `DdcError`; each is returned as `ProgramError::Custom(code)`. Codes are appended and never renumbered.

| Code | Name | Returned by | When |
|---|---|---|---|
| 6000 | `MintPaused` | I-2 | Issuance is paused |
| 6001 | `Unauthorized` | I-2 to I-8 | A signer does not match the stored key; or, in I-3, the source's owner is not PDA-5 |
| 6002 | `FeeBoundsInvalid` | I-6 | The minimum fee is above the maximum |
| 6003 | `InvalidAttestationUri` | I-7 | The link is longer than 128 bytes |
| 6004 | `InvalidPubkey` | I-1, I-8 | I-1: account 7 is the default key. I-8: the new key is the default key |
| 6005 | `InvalidRole` | I-8 | The role is above 2 |
| 6006 | `InvalidInstruction` | Every call | The data is shorter than 8 bytes, or its discriminator matches no instruction |
| 6007 | `TokenAccountMintMismatch` | I-2, I-3 | The destination or source belongs to another mint |
| 6008 | `FeeAboveCeiling` | I-6 | The rate is above the rate ceiling |
| 6009 | `MaximumFeeAboveCeiling` | I-6 | The maximum fee is above the absolute ceiling |
| 6010 | `FeeCeilingInvalid` | I-1 | The rate ceiling is above 10,000 |
| 6011 | `ConfidentialTransferAuthorityNotNone` | I-1 | A Confidential Transfer mint authority other than none was given |
| 6012 | `CoSignersNotDistinct` | I-1, I-8 | The three co-signer keys are not distinct, or would not be after the replacement |

### 6.2 Structural checks

Every instruction checks its accounts before its business rules and returns the runtime's built-in errors:

| Error | Failure |
|---|---|
| `NotEnoughAccountKeys` | Too few accounts |
| `InvalidAccountOwner` | An account owned by the wrong program |
| `InvalidSeeds` | A record at an address other than its canonical derivation |
| `MissingRequiredSignature` | A required signature absent |
| `Immutable` | An account that must be writable is not |
| `InvalidInstructionData` | Arguments that fail to decode, or trailing bytes |
| `IncorrectProgramId` | The wrong program passed as Token-2022 or the system program |
| `InvalidAccountData` | A record whose data is malformed or has the wrong discriminator |

Errors raised by Token-2022 in a call the program makes reach the caller unchanged.

## 7. Fees

- **Transfer fee.** Token-2022 deducts the fee from each transfer, at the mint's rate up to its maximum fee per transfer. Only I-6 can change the rate and maximum, within the two ceilings; a change takes effect two epochs after it is set, under Token-2022's rules.
- **Minimum fee.** I-6 records a minimum fee in PDA-1, refusing one above the maximum, but nothing on chain enforces it on transfers: Token-2022's fee has no floor. It is a parameter of record for client software. The command-line tool applies it: `confidential-transfer` and `public-transfer` refuse a transfer whose fee would be below it. Other software need not.
- **Withheld fees.** Fees are withheld in recipients' token accounts. The fee of a confidential transfer is encrypted under the withheld-fee decryption key and the recipient's key. The withdraw-withheld authority withdraws withheld fees, public and confidential; a confidential withdrawal also needs a proof made with the withheld-fee decryption key's secret. The Confidential Transfer fee authority only switches on or off whether confidential withheld fees can be collected into the mint; while collection is on, anyone can move them there, and they are withdrawn from the mint by the withdraw-withheld authority. These are Token-2022 instructions; the program has none, and the command-line tool has no command for them.
- **Confidential transfers.** Because the mint carries the Transfer Fee extension, Token-2022 accepts only its transfer-with-fee form of confidential transfer on it, at any rate including zero. The sender proves the fee with the transfer.
- **Visibility.** Whoever holds the withheld-fee decryption key can narrow the amount of a confidential transfer from its fee when the rate is above zero; the extent is in LIMITS.md, section 4.

## 8. Issuance pause

The pause is a flag in PDA-1. While it is set, I-2 is refused (6000). Nothing else is affected: burning, fee changes, key replacements, reserve statements and every holder's balance and transfers continue. Any one co-signer can set it alone, so that issuance can be stopped without coordination; lifting it needs the issuer and the reserve together. It is an issuance pause, not a pause of the currency.

## 9. Reserve statement

The reserve key publishes the reserve statement with I-7. It records:

- a figure: the value of the reserve, in the currency's unit of account, in base units;
- the time of publication, from the cluster clock;
- the publishing key;
- a link, at most 128 bytes, to a document.

The document states the figure, the day it was measured (`Measured: YYYY-MM-DD UTC`) and how the reserve was valued, and names any attestor. The link carries the document's SHA-256 as a fragment, `#sha256=` followed by 64 hexadecimal characters, so anyone can check that the document read is the one the statement points to. The document is fixed before its hash is taken, never contains its own hash, and never changes afterward; a new measurement is a new document and a new statement. With the fragment taking 72 bytes, the document's address can be at most 56 bytes.

The program does not check the statement, and no instruction reads it. It records what the reserve key asserts; verification is whatever the document and any named attestor provide. Supply is public on the mint, so anyone can compare it with the stated figure. `ddc state` prints the current statement, with the link as stored. Neither `state` nor `admin publish-reserve-statement` fetches the document or checks its hash; anyone reading the statement does that.

## 10. Redemption

A redemption-collection account is any token account of the mint whose owner is PDA-5. The program creates none, and the command-line tool has no command that does. Anyone can create one with general Token-2022 tooling, for example as the associated token account of PDA-5 for the mint, paying its rent.

A holder redeems by transferring to such an account, an ordinary Token-2022 transfer, and the issuer and the reserve then burn the amount with I-3. Paying the holder out is the issuer's act, outside the chain; the program does not enforce it. The command-line tool sends only to wallet addresses and has no command that deposits into a redemption-collection account; general Token-2022 tooling can.

## 11. Token metadata

The name, symbol and link are stored on the mint by the Token Metadata extension, which the Metadata Pointer points to on the mint itself. The link points to a JSON document. The reference instance's document carries five fields, `name`, `symbol`, `description`, `external_url` and `attributes`, and no image. A currency publishes its own document at its own address.

## 12. Confidential Balances

Every token account of the mint is approved for confidential transfers automatically. A holder turns Confidential Balances on for their own token account by writing their ElGamal public key into it with Token-2022; the command-line tool does this only through `setup-privacy`, after asking.

The holder's two confidential keys, the ElGamal key pair and the key that encrypts the balance figure the holder reads, are derived from one Ed25519 signature by the wallet's key. The signed message is the bytes of `solana-conf-bal/v1` followed by the owner's address and the mint's address, 32 bytes each. The keys are taken from that signature by `ConfidentialKeys.fromSignature` in `@solana/zk-sdk` 0.5.1, which mixes it with HKDF-SHA512. A test in the tool checks that the result is byte-identical to the derivation in `@solana-program/token-2022` 0.15.0. Ed25519 signatures are deterministic, so the keys can be regenerated from the wallet key and need no separate backup; a wallet whose signatures are randomized, such as a passkey wallet, cannot derive them this way. A wallet must derive the same way to read the balance.

The confidential operations are Token-2022's:

- **shield** moves an amount from the public balance into the pending confidential balance;
- **apply pending** moves received and shielded amounts into the available confidential balance;
- **confidential transfer** sends from the available confidential balance in one transaction carrying five proofs, built on the sender's machine;
- **unshield** moves an amount from the available confidential balance to the public balance.

The limits of what this conceals are in LIMITS.md, sections 4 to 6.

## 13. Program upgrade

Whoever holds the program's upgrade authority can replace its code, and with it every rule in this document that the program enforces. The arrangements a currency can give its own deployment, and how an upgrade is carried out, are in [docs/UPGRADE_PROCEDURE.md](UPGRADE_PROCEDURE.md). `ddc state` prints the program's current upgrade authority.

## 14. Command-line tool

The tool `ddc` reads every authority of a mint the program created and the public half of its withheld-fee decryption key, and builds every instruction except I-1. No command creates a mint; a genesis transaction is built to the layout in section 4. The reference genesis transaction is built by `scripts/devnet_i1v3_send.py` from the values in `scripts/devnet_i1v3_dry_construct.py`, among them the reference fee ceilings of 100 basis points and 1,000,000 base units. It takes the mint's and the payer's key files as arguments and refuses keys other than the reference mint's and payer's. It prints the instruction and a transaction signed over a placeholder blockhash the network refuses, and sends only with `--send`. It builds that one genesis; a currency builds its own genesis with its own values.

**Holder commands:** `state`, `balance`, `setup-privacy`, `shield`, `unshield`, `apply-pending`, `confidential-transfer`, `public-transfer`. They are described in the README.

**Administrative commands:**

| Instruction | Command | Prepared by | Countersigned by |
|---|---|---|---|
| I-2 | `admin serialize mint`, then `admin countersign` and `admin submit` | Issuer | Reserve |
| I-3 | `admin serialize burn`, then as above | Issuer | Reserve |
| I-4 | `admin issuance-pause` | Any one co-signer | — |
| I-5 | `admin serialize resume`, then as above | Issuer | Reserve |
| I-6 | `admin serialize update-fee`, then as above | Operator | Issuer |
| I-7 | `admin publish-reserve-statement` | Reserve | — |
| I-8 | `admin serialize rotate`, then as above | Operator | Reserve |

Each two-signature instruction is prepared by one signer, passed to the second as a file in the `ddc-admin-tx-v1` format, checked and countersigned there, and submitted as separate steps. The transaction is signed against a durable nonce so that it does not expire in between: the issuer's nonce account for I-2, I-3 and I-5, the operator's for I-6 and I-8, both set in `cli/src/constants.ts`. `admin cancel issuer` or `admin cancel operator` advances that nonce, which invalidates a prepared transaction that has not been submitted. The second signer's check is made against the transaction itself, never against the description that accompanies it.
