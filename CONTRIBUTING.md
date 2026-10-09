# Contributing

## The open core

Every currency built on this repository runs the code in it. A fork may add to it; what a fork adds is its own, maintained and audited by its issuer, and stated in that currency's own specification.

## Sign-off (Developer Certificate of Origin)

Every commit carries a sign-off certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```
git commit -s
```

which adds a line of the form `Signed-off-by: Your Name <you@example.org>`. You keep the copyright in your contribution and license it under Apache-2.0, the license of this repository. There is no contributor license agreement, and the Foundation has no right to relicense contributed code.

## What will not be merged

Whatever its source or justification, no change that introduces any of the following enters this repository:

- administrative freeze functions of any kind;
- spending restrictions that limit what value can be exchanged for;
- expiry conditions that cause holdings to lapse;
- behavioral conditions that make access contingent on compliance with external criteria;
- general-purpose programmable logic deployable by third parties at the protocol layer.

A capability outside the conforming profile, such as a Freeze Authority, a Permanent Delegate or an auditor key, belongs in the fork of the issuer that needs it, never here. A change that touches an item on this list, or any of the [DDCP conformance criteria](https://github.com/ddcpfoundation/protocol-governance/blob/criteria-v20261008-2/CRITERIA.md), governs this repository and what is built from it afterward; it never applies to a currency already issued.

The rules for changing the protocol are in the protocol change policy, in the Foundation's governance repository: [PROTOCOL_CHANGE_POLICY.md](https://github.com/ddcpfoundation/protocol-governance/blob/main/PROTOCOL_CHANGE_POLICY.md).

## Making a change

1. Open an issue first for anything beyond a small fix, so the approach can be agreed before you write it.
2. Keep each pull request to one change, with tests that fail without it.
3. Before you open it, run the same checks the maintainers run:

   ```
   (cd program && cargo build-sbf && cargo test && DDCP_TOKEN_2022=devnet cargo test && cargo clippy --all-targets && cargo fmt --check && cargo audit)
   (cd cli && npm run typecheck && npm test)
   ```

   `cargo audit` is not part of the Rust toolchain; install it once with `cargo install cargo-audit`. The maintainers also run `npm audit` in `cli`; `cargo clippy --lib -- -W clippy::arithmetic_side_effects -W clippy::cast_possible_truncation -W clippy::cast_sign_loss -W clippy::cast_possible_wrap -W clippy::integer_division -W clippy::indexing_slicing` in `program`, reading each warning it prints; and the Solana static analyzer X-Ray, from the image `ghcr.io/sec3-product/x-ray@sha256:543dc6a984d4abf8792d00884b9225b2ad28cdd06320d7a8ba3855a46a491997`, run without network access over an export of the tracked files.

4. Every refusal the tool prints states the cause, the risk, and the action, and says whether anything was sent.
5. A change to the program changes the deployed binary. Say so in the pull request; the binary is rebuilt and verified as described in [BUILD_VERIFICATION.md](BUILD_VERIFICATION.md).

## Language

`Token-2022` names the Solana program; `Token Extensions`, or the extension's own name, names a feature on a mint. A Freeze Authority, Permanent Delegate or Transfer Hook acts on a token account; say "wallet" only when describing the effect on a person. The issuance pause halts minting only; never describe it as a pause of the currency.

## Security

Never report a vulnerability in an issue or pull request. See [SECURITY.md](SECURITY.md).

## Maintainers

Merge authority rests with the maintainers of DDCP Foundation, listed in [MAINTAINERS](MAINTAINERS).
