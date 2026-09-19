# Working in this repository

## ⚠️ This is a public repository

Treat everything in this repo as **published to the world, permanently**. It is the public
ClickMonk product repo and is open to the internet.

That applies to *all* of it, not just source files:

- File contents, commit messages, branch names, tags, code comments, TODOs
- Issues, PR descriptions, docs, examples, test fixtures, seed data
- Git history — a bad commit is not fixed by a later commit that removes the file

Never commit here:

- Secrets of any kind: API keys, tokens, passwords, private keys, connection strings
- Real customer, user, or prospect data — use obviously fake data in examples and fixtures
- Real tracked links, affiliate IDs, network account names or campaign names — use the
  reserved `example.com` / `.invalid` domains and made-up IDs
- Internal business material: revenue, pricing strategy, roadmap rationale, competitor
  analysis, partner/vendor names, marketing plans, hiring notes
- Personal information: home addresses, phone numbers, private email addresses
- Private infrastructure detail: internal hostnames, IPs, server layouts, admin URLs
- References to any private/internal repository or its contents

Business-side material belongs in the private companion repo, which this repo never
mentions by name or path.

**When in doubt, ask before committing.** Writing to a local file is cheap to undo;
pushing to a public repo is not.

The `boundary` job in `.github/workflows/ci.yml` enforces the mechanical part of this:
it fails on tracked session-tooling directories, `.env` files, key files and a local
Compose override, and runs a secret scan over the whole history. It cannot judge
business material. That part stays a judgement made before committing.

## What ClickMonk is

Self-hosted link tracking and reporting for affiliate and digital marketers. Customers
run it on their own infrastructure; their click data stays theirs.

## Current status

**Pre-code.** The repository holds the license, the community files and CI. There is no
product, no install and no API yet. Do not write documentation that implies otherwise.

## Stack and layout

**Not decided yet.** When it is, this section gets the package layout, the commands to
build, lint, typecheck and test, and the order CI runs them in — and the local gate is
that same order, so local red means CI red.

Three properties of the product are already fixed and shape every stack choice:

- **The redirect path is the product.** A click that fails to redirect is lost revenue
  for the person who paid for the traffic, and it cannot be replayed. It must stay up and
  answer fast when everything behind it (reporting, the admin UI, the database the
  reports read) is slow or down.
- **Custom domains are first-class.** Every customer domain needs TLS, issued and renewed
  without anyone touching a certificate.
- **The redirect endpoint is public and unauthenticated by nature.** Anything reachable
  from it is reachable by anyone on the internet.

## License and its consequences

Fair-code, under the Sustainable Use License (`LICENSE.md`). Two rules follow:

1. **Never describe ClickMonk as "open source."** SUL is not OSI-approved. The correct
   terms are "fair-code" and "source-available." This applies to the README, docs,
   marketing copy, commit messages, and anything else written about the project.
2. **A CLA must be in place before merging any external PR.** Without it we lose the
   right to relicense contributed code. `CLA.md` is a draft and the bot in
   `.github/workflows/cla.yml` is switched off until the text has had a legal review.

## Non-negotiables

These hold from the first line of code, whatever the stack turns out to be:

- **Anything reachable from a public endpoint is bounded.** Page sizes, window ceilings,
  cache entries, queue depths and result limits each need a bound, not a convention.
- **The tenant is taken from the credential, never from the request.** Whatever scopes a
  query to one workspace or project is injected from the authenticated key or session,
  and no request field can express or remove it.
- **Every value reaching SQL is a bound parameter.** Identifiers that cannot be
  parameters come from a fixed compile-time allowlist, never from request data.
- **Migrations are additive, and an applied one is never amended.** Editing a shipped
  migration changes fresh installs only. Fix it forward in a new one.
- **A redirect never waits on reporting.** Recording a click is not allowed to add
  latency to, or a failure mode to, sending the visitor on.

## Writing tests here

A test counts only once it has been shown to fail against the broken implementation.
That rule is easy to satisfy badly, so:

- **Mutate the narrowest unit, and the exact line the test claims to protect.** Reverting
  a wrapper proves the wrapper runs, not that the logic inside it does anything.
- **Mutate compound conditions one clause at a time.** Deleting a whole `if (a || b)`
  proves nothing about `b`.
- **Ask whether there is a second, easier way for the test to pass.** An assertion that
  holds for every possible output, or one made against the test's own fixture, cannot
  fail.
- **A mutation that breaks everything proves nothing** about the specific test you are
  checking. If it fails unrelated tests too, narrow it.
- **Fixture timestamps are relative to now,** never pinned to an absolute date. A pinned
  fixture expires on a wall-clock schedule and turns the suite red with no code change.

## Shell scripts

Anything that runs on an operator's host rather than in a container — an installer,
backup or restore — targets **bash 3.2**, the version macOS still ships: no associative
arrays, no `mapfile`. `shellcheck` is pinned in the repo and CI runs the pinned copy,
never a runner's preinstalled binary, so a lint that fails in CI can be reproduced
locally.

## Conventions

- Write for an outside reader who has no context on the project. Assume a stranger is
  reading every file.
- Documentation here is user- and contributor-facing. Design rationale and decision
  records do not live in this repo.
- **Say what does not work yet.** A README, a changelog entry or a release note that
  lists only what works is overclaiming. The limits are what stop someone filing a bug
  against a documented gap.
- **ClickMonk has no visual identity yet. Do not invent one** — no logo, palette, favicon
  or social card. When one exists it will arrive as generated assets with usage rules
  beside them.
- Commit and PR titles are `<area>: <lowercase phrase>`, no trailing period. The area is
  the surface touched, not the package.

## Cutting a release

**A pushed tag is not a release.** GitHub's Releases page lists release objects, and
pushing a tag creates none. The whole sequence, in order:

1. Branch `chore/release-X.Y.Z`.
2. Bump the version in every manifest and every version constant compiled into shipped
   output, then **grep for the new version and count** rather than grepping for the old
   one and assuming. The places are listed here once the stack exists.
3. Write the `CHANGELOG.md` entry: Added / Fixed / Changed, plus what the release still
   cannot do. Before writing it, read `git log --oneline --no-merges <lasttag>..HEAD`
   against the changelog; merged work with no entry is how releases under-report.
4. Open the PR and wait for **every** CI job, not only the required ones.
5. Merge.
6. Tag the merge commit explicitly, annotated, never lightweight:

   ```sh
   git fetch origin
   git tag -a vX.Y.Z <merge-commit> -F <message-file>
   git push origin vX.Y.Z
   ```

7. Create the release: `gh release create vX.Y.Z --verify-tag --title "vX.Y.Z — <name>"
   --notes-file <file>`. The body is prose written for users, not the changelog pasted.
8. Confirm it is Latest with `gh release list`.

**Version numbers are cheap; a wrong one is not.** If a bump ships without its tag,
record that in the changelog rather than tagging afterwards — a tag created later names a
moment nobody could have fetched.
