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

**Early, unreleased, not for production.** What exists: the redirect (in-memory snapshot,
spool before response, click caps, traffic classification and actions, country rules
from an in-memory IP lookup), the worker (spool to ClickHouse, migrations on boot, IP
data updates), the CLI (`migrate`, `domain add`, `link add`, `settings show|set`,
`ipdata status|update`), a Compose stack, and the restart durability suite.

What does not exist yet, and must not be implied by any documentation:

- **TLS.** The redirect serves plain HTTP on 8080. Visitor cookies are `Secure`, so
  browsers drop them over HTTP and returning-visitor routing does not work until TLS.
- **Admin API and UI.** Links and domains are added with the CLI. `domain add` marks a
  domain verified without a DNS check.
- **Most link settings in the CLI.** `link add` takes `--target`, `--backup`, `--cap`,
  `--expires`, `--no-passthrough` and `--action` only, and no command changes a link
  after `link add`. `settings set` sets the install-wide traffic actions, the safe URL
  and the abuser threshold. The evaluator supports device URLs, a returning URL,
  country rules, a name and the disabled state; the CLI cannot set them yet, so they
  need hand-written SQL.
- **Reporting.** Clicks reach ClickHouse; there are no reports or exports.
- **Proxy/VPN detection beyond Tor exits, cloud providers' published ranges, and region
  or city.** No licensed VPN or proxy list has been found; datacenter traffic is
  recognised by ASN only, since no cloud provider's range file states a licence.
- **Password links, backup and restore.**
- Segments ClickHouse rejects are set aside as `.bad` files, and nothing reports them.
- One redirect process per spool directory.

**Upgrade the worker before the redirect.** A worker never deletes or sets aside a spool
segment whose record version is newer than it reads: segments from a newer redirect wait
in the spool, counting toward its size bound, until the worker is upgraded. Support for
reading a record version ships no later than writing it.

## Stack and layout

A pnpm workspace of TypeScript packages, Node 22, ESM throughout. TypeScript is `strict`
with `noUncheckedIndexedAccess`; avoid `any`, and justify it inline on the rare occasion
it is unavoidable. Biome handles lint and format. Vitest runs the tests. Two stores:
**Postgres** for domains, links, counters and the single migration ledger; **ClickHouse**
for click events.

```
packages/core/      pure logic, no I/O: link schemas (zod), the redirect evaluator,
                    device, OS and browser detection, traffic classification,
                    destination tokens, passthrough, rotation, click IDs, the click
                    record. Owns SCHEMA_VERSION.
packages/db/        Postgres and ClickHouse clients and the migrator. Migrations live
                    in packages/db/migrations/{postgres,clickhouse} as one shared
                    version sequence.
packages/ipdata/    IP data: the compact range-table format, the source parsers
                    and their licences, the manifest the redirect loads, and the
                    updater the worker runs.
packages/redirect/  the service that answers link domains: an in-memory snapshot,
                    the IP data and the per-address rate counter, the spool
                    writer, the click-cap counter.
packages/worker/    ships the spool into ClickHouse; runs migrations on boot;
                    updates the IP data.
packages/cli/       `clickmonk migrate | domain add | link add | settings | ipdata`.
```

Three properties of the product shape every change:

- **The redirect path is the product.** It must keep answering when ClickHouse, the
  worker or Postgres is down. It never queries ClickHouse and never waits on reporting.
- **Custom domains are first-class.** Every customer domain needs TLS, issued and renewed
  without anyone touching a certificate.
- **The redirect endpoint is public and unauthenticated by nature.** Anything reachable
  from it is reachable by anyone on the internet, so all of it is bounded.

## Running the tests

```sh
corepack enable
pnpm install
docker compose -f docker-compose.test.yml up -d --wait   # Postgres + ClickHouse
pnpm build        # required before the first `pnpm test`
pnpm test
```

**Build before the first test run, and after changing `core`, `db` or `ipdata`.**
Packages import each other by name, which resolves to the *built* `dist/`, and `dist/`
is not committed.
A test in `packages/redirect` exercising a change in `packages/core` runs against the
last build until you rebuild; it stays green and the green means nothing.

The image is compiled with `pnpm build:image` instead, which uses each package's
`tsconfig.build.json` to leave out the tests and `packages/db/src/testing.ts`. A new
test-only file that is not named `*.test.ts` must be excluded there too, or it ships.

**While iterating, run the focused test files for what you touched.** Before opening a
pull request, run the full gate in CI's order, so local red means CI red:

```sh
pnpm lint && pnpm lint:sh && pnpm typecheck && pnpm build && pnpm test
```

**Run one test suite at a time.** Every database-backed test resets the shared test
databases in `beforeAll`; two runs at once delete each other's fixtures. A mass failure
across files you did not touch is a second test run until proven otherwise.

### The durability suite

```sh
pnpm build
pnpm vitest run --config vitest.durability.config.ts   # builds an image; a few minutes
```

It builds the image, starts the whole stack from `docker-compose.ci.yml`, and restarts
ClickHouse, the worker and the redirect under continuous traffic, then requires every
`302` the client received to be a click in ClickHouse. It is excluded from `pnpm test`
and runs as its own CI job.

The CI stack binds **8080 and 8123**; the test databases bind **8123 and 5433**. Stop the
test databases before running it, or you get "port is already allocated", which reads
like a broken test. Bring them back before the next `pnpm test`. The suite runs
`down -v` on its own project only (`clickmonk-ci`).

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
arrays, no `mapfile`. `install.sh` is the first. `shellcheck` is pinned as a Docker image
and run by `pnpm lint:sh` over every `*.sh` in the repository, so a new script is linted
without anything being added to the script, and by CI with the same command, so a failure
there is reproducible here.

## Conventions

- Write for an outside reader who has no context on the project. Assume a stranger is
  reading every file.
- Documentation here is user- and contributor-facing. Design rationale and decision
  records do not live in this repo.
- **Say what does not work yet.** A README, a changelog entry or a release note that
  lists only what works is overclaiming. The limits are what stop someone filing a bug
  against a documented gap.
- **ClickMonk has a visual identity. Do not invent one.** It is in `brand/`, and the
  rules are in `BRANDING.md`; read that before adding a README header, favicon, social
  card, docs theme or UI colour. The two rules that are invisible until they are
  expensive: there is **no single brand hex** (the accent is a different value per
  mode), and **red is status only** (blocked and error), never the brand. Contrast is
  measured in `brand/contrast-report.txt`, never estimated.
- **`brand/` is generated output. Do not hand-edit it.** The generator is not in this
  repo, and a rebuild overwrites every file there. Say so rather than patching an asset.
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
