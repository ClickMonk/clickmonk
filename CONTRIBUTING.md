# Contributing to ClickMonk

Thanks for your interest. ClickMonk has no code yet, so the most useful contributions right now are use cases, problems you hit with the link tracking you run today, and feedback via [issues](../../issues).

**Found a security problem? Do not open an issue.** Use [private vulnerability reporting](../../security/advisories/new) (the "Report a vulnerability" button on the Security tab) or email `hello@clickmonk.co` with `security` in the subject. See [SECURITY.md](SECURITY.md) for what to include and what to expect. ClickMonk is self-hosted, so a public report is a set of instructions for attacking every install that has not upgraded yet.

## Before you contribute code

> **Contributor License Agreement (CLA) required.**
> ClickMonk is fair-code licensed under the [Sustainable Use License](LICENSE.md), and a hosted cloud version is planned. All code contributors must sign a CLA granting ClickMonk the right to relicense contributed code, for example for the cloud or enterprise offerings. This is the same model n8n and many other fair-code projects use.
>
> **Status: not in force yet, so please do not send code yet.** The agreement is drafted at [CLA.md](CLA.md) and the signing bot is committed at `.github/workflows/cla.yml`, but both are switched off until the text has had a legal review. Asking you to sign a document that says it is a draft would be worse than asking nothing. Until it is live, please open an issue to discuss any code contribution rather than sending a pull request. Documentation fixes, bug reports, and issues are welcome now and need no CLA.

## How to contribute

1. **Open an issue first** for anything non-trivial: bugs, feature ideas, design discussions.
2. **Fork and branch** from `main`.
3. **Keep PRs focused**: one logical change per PR.
4. **Describe the why**, not just the what, in your PR description.
5. **Use obviously fake data** in examples and fixtures: `example.com` or `.invalid` URLs and made-up affiliate IDs, never a real link, network account or campaign.

## Development setup

The technology stack has not been decided yet. Setup instructions will land here together with the first packages.

## Code of conduct

All participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
