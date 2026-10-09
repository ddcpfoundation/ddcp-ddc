# Security

This code is unaudited and runs on devnet only. The reference mint on devnet has no value.

## Reporting a vulnerability

Report privately. Do not open a public issue, pull request or discussion about a vulnerability.

- GitHub: use **Report a vulnerability** on this repository's Security tab (private vulnerability reporting).
- Email: security@ddcpfoundation.org.

Include what you found, the commit you tested, the steps or transaction that show it, and what you believe an attacker could achieve. A report that names an instruction of the program and an account it fails to check is enough to start.

## What happens next

- A person, not an automatic reply, confirms we received your report within 5 business days.
- We tell you whether we accept it as a vulnerability, and keep you informed while it is addressed.
- We publish an advisory and credit you unless you ask us not to.

Please give us a reasonable time to address the report before you disclose it. There is no bug bounty at this time.

## How a fix reaches deployed code

- **While a deployed program is upgradeable,** a fix is deployed by upgrading it as set out in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md). The Foundation's devnet demonstration stays upgradeable and is upgraded to the fixed code this way.
- **Once a currency has made its program permanent,** it cannot be changed, including to fix a vulnerability. A fix is published as a new version of the program at a new address. Mints created with the earlier version keep its rules, including the vulnerability, for as long as they exist. The advisory then names the versions affected, which cannot be patched in place, rather than the deployments, since each currency deploys its own copy; the full disclosure rule is in [docs/UPGRADE_PROCEDURE.md](docs/UPGRADE_PROCEDURE.md), section 6.
- **A currency built from this repository** runs its own program. Whether and how it can take a fix depends on that currency's own upgrade arrangement, stated in its own specification.

## Scope

In scope: the on-chain program in `program/`, the command-line tool in `cli/`, and the scripts in `scripts/`.

Out of scope here, and best reported to their maintainers: Solana's Token-2022 program, the zero-knowledge proof program, the Solana runtime, and the third-party packages listed in `cli/package-lock.json` and `Cargo.lock`. A currency built from this repository is maintained by its own issuer; report issues in its own code to that issuer.

Known limits of the design, such as the visibility of sender, receiver and timing, are recorded in [the Known Limits against DDCP](LIMITS.md) and are not vulnerabilities.

## Your keys

Never send a private key, keypair file or recovery phrase, to us or to anyone. No one at the Foundation will ask for one. Test only with devnet keys created for the purpose.
