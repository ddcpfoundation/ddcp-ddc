# Release notes

Release notes of the DDCP reference implementation. A release that corrects a defect names it here with the versions affected, as section 4 of the Foundation's [change policy](https://github.com/ddcpfoundation/protocol-governance/blob/main/PROTOCOL_CHANGE_POLICY.md) requires. Each release is identified by its tag.

## v0.3.0

**Unaudited. Devnet only.** No independent security audit has been completed.

### What this release changes

- **Program.** The instruction that replaces a co-signer key, I-8, now requires the signature of the key it installs, as a fifth account ([docs/SPECIFICATION.md](docs/SPECIFICATION.md), section 3.3 and I-8). A caller that sends I-8 in its earlier four-account form is refused.
- **Command-line tool, version 0.3.0.** A co-signer replacement gains one step, `admin countersign --incoming`, in which the holder of the new key signs. The defects listed below are corrected.
- **Holder client library.** The eight holder operations now live in a library, `cli/src/holder/`, and the tool's holder commands are built on it. It is not yet published as a package; see the [README](README.md#holder-client-library).

### Defects corrected

Eight defects were reported to the Foundation by an outside reviewer. That review was not an audit. Each defect was reproduced before it was corrected.

Severity is the Foundation's own grading:

- **critical:** holder value lost or taken, or an authority taken without consent;
- **high:** holder funds locked with no recourse;
- **medium:** funds unusable through the reference tools, and another party can cause it;
- **low:** needs unusual conditions or the holder's own mistake, or costs a small fee;
- **informational:** not reachable on the reference mint.

None of the eight is critical or high.

Defects 1 to 3 and 5 to 8 are in the command-line tool and were reproduced on `v0.2.0`. Each of them is in code that `v0.1.0` carries unchanged, apart from how it derives the keys of a confidential account; `v0.1.0` is affected too. Defect 4 is in the program, which did not change between `v0.1.0` and `v0.2.0`; both are affected.

1. **A short copy of the confidential balance (medium).** A confidential account keeps a copy of its balance that the holder reads. `shield` and `apply-pending` could leave that copy short of the encrypted balance when a credit, or a second `shield` on the same account, landed at the same time. `unshield` and `confidential-transfer` then could not send from that account, and the tool had no repair. The balance itself was not lost. Corrected: every confidential command now compares the copy with the encrypted balance; `apply-pending` and `shield` write the corrected copy and say so; `unshield` and `confidential-transfer` refuse and name `apply-pending`; `balance` warns with the amount. `shield` and `apply-pending` also refuse before sending when the encrypted balance changed between their read and their send. That check narrows the window and does not close it; the comparison after the send reports what remains.
2. **Pending credits too large to read (informational on the reference mint; low for a currency where 2^48 base units can be pending).** When pending credits reached a total the tool's decryption could not read, which two credits of 2^47 base units each produce, `apply-pending` refused and no holder command could reach the pending amount. Corrected: the tool reads these larger totals; a total beyond its bound is still refused.
3. **A failure reported too early (low).** The tool reported a transaction as failed, and said nothing had moved, on the first status a node returned. A status at that stage can be rolled back, and the transaction could still succeed. Corrected: a failure is reported as final only once the transaction's status is confirmed or finalized; until then the tool keeps checking, and says the transaction may still land if it cannot tell.
4. **A co-signer replacement could install a key nobody holds (low).** I-8 checked the signatures of the operator and the reserve and never a signature by the new key. The two together could, by mistake, install an address nobody can sign for. For the reserve role that stops minting, burning, the lifting of an issuance pause, reserve statements and every later replacement; for the operator role it stops fee changes and every later replacement. Only a program upgrade restored either. Corrected in the program: no replacement can install a key that has not signed it. What a lost key stops is unchanged and is in [LIMITS.md](LIMITS.md), section 12.
5. **A payment refused although it fitted (informational on the reference mint; low under a large fee ceiling).** `confidential-transfer` and `public-transfer` refused a payment whenever the amount plus the mint's maximum fee passed the largest amount one transfer can carry, even when the amount plus the fee actually due fitted. Corrected.
6. **Rent not shown in `public-transfer` (low).** The command shows the rent for a new recipient account only when it found the account absent. A recipient who closed an empty account between that reading and the send made the sender pay rent that was never shown. Corrected: the command creates the recipient's account only when its reading found it absent; otherwise an account closed in the meantime makes the transfer fail, for the network fee only.
7. **The RPC address printed in full (low).** The tool printed the configured RPC address as given, including any access key it carried. Corrected: it prints the scheme and host only.
8. **The proxy setting repeated in refusals (low).** A refused proxy setting was repeated in the refusal, including a user name and password or a key if it carried one. Corrected: a refusal names the scheme and host only.

### Adopting this release

- **A deployment whose program can be upgraded** takes the corrected program by an upgrade, as set out in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md). An upgrade does not change the program's records for a mint. From then on a co-signer replacement needs the three signatures and the five accounts of I-8, and the tool at 0.3.0 builds it.
- **A deployment whose program has been made permanent** cannot take the corrected program. Defect 4 stays with it: the operator and the reserve must make sure that every key they install is one its holder can sign with. The path to the corrected version is the one the change policy states: a new mint on the corrected version, with holders moved by that currency's issuer through redemption and reissue. Mints on an earlier version are never moved by anyone else.
- **The Foundation's devnet demonstration** was upgraded in place; [BUILD_VERIFICATION.md](BUILD_VERIFICATION.md) names the deployed build.
- **Holders** need do nothing to their accounts. The corrections to the tool take effect by using version 0.3.0. An account whose confidential keys were derived by version 0.1.0 has been refused since 0.2.0 and still is ([LIMITS.md](LIMITS.md), section 4).
