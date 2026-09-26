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

**Released as 0.1.0; early.** What exists: the redirect (in-memory snapshot,
spool before response, click caps, traffic classification and actions, country rules
from an in-memory IP lookup, the password gate on a link), Caddy in front of it with
on-demand TLS gated on a verified domain or the configured admin host, the worker (spool
to ClickHouse, migrations on boot, IP data updates, domain DNS verification, the retention
pass), the admin
API (one account, sessions, TOTP with recovery codes, API keys, domain/link/settings
CRUD, answering on `CLICKMONK_ADMIN_HOST` alone — unset, every route but `/health` is a
503 and links serve exactly as before), reporting over that API (a summary, a chart by
hour or day, a breakdown over ten dimensions, the raw click log and a streamed CSV of it,
all reading hourly rollups except the log and its export), the web interface (a React app
the admin service serves from that same host, behind the same host guard — every screen
built on the admin API and nothing it can reach that a script cannot), retention (two
periods on the settings row, enforced hourly by the worker, dropping raw clicks a partition
at a time and blanking the address on a click in place), the CLI (`migrate`,
`domain add|list|verify`, `link add`, `settings show|set`, `ipdata status|update`,
`admin create|passwd`, `admin totp disable`, `apikey create|list|revoke`, `version`),
`install.sh`, `backup.sh` and `restore.sh`, a Compose stack, and the restart durability and
stack test suites.

**A retention period is a floor, not a deadline, and it is never defaulted by a reader
that deletes.** `clicks` is partitioned by month and dropped whole, so 90 days keeps 90 to
121 days; and a settings row that is missing or cannot be read as retention means the pass
deletes nothing at all, rather than the defaults. **A report counts whole buckets** — it
aligns the window to the grain it answers at, the hour for the summary and the breakdown
and the requested bucket for the chart, so `bucket=day` counts whole days — and echoes what
it counted, while the click log and the export use the window to the millisecond. So one
request can be answered differently by all three and every answer is right.

**The two services read `CLICKMONK_ADMIN_HOST` differently on purpose.** The admin service
refuses to boot on a value it cannot parse; the redirect logs `ADMIN_HOST_IGNORED` once and
serves links with the certificate check approving verified link domains only. The redirect
reads it for one thing — telling the proxy which name may have a certificate — and a
mistyped host name is not a reason to take every link on the install down.

What does not exist yet, and must not be implied by any documentation:

- **More than one admin account.** One account is the whole of the access control: no
  roles, no second person, no attribution of who did what. An API key is the only
  credential that can be handed out and revoked on its own, and it is not a person.
- **A way back in over the API when both factors are lost.** Removing the second factor
  there requires the second factor. `clickmonk admin totp disable` is the answer, and it is
  a command on the server for that reason.
- **A CSV of a report, from the API itself.** `GET /api/clicks.csv` streams the click log
  only. A summary or a breakdown is one small answer already, and turning one into a file is
  the web interface's own doing, client-side, not a route the API streams.
- **A time zone, on the API.** Every window and retention period it takes is UTC, and so is a
  chart's bucket size — `offset` only moves where a day bucket begins, in whole hours, and does
  nothing for an hourly one. The web interface computes a preset like "yesterday" from the
  browser's own zone; a caller of the API directly still has to — see
  `packages/ui/src/window/range.ts`.
- **Notifications of any kind.** No mail configuration exists; `GET /api/alerts` is what
  an operator reads instead.
- **Most link settings in the CLI.** `link add` takes `--target`, `--backup`, `--cap`,
  `--expires`, `--no-passthrough` and `--action` only, and no command changes a link
  after `link add`. `settings set` sets the install-wide traffic actions, the safe URL,
  the abuser threshold and the two retention periods. Device URLs, a returning URL,
  country rules, a name, a password and the disabled state are the admin API's and the web
  interface's, or hand-written SQL without it.
  A returning URL also needs HTTPS to do anything: its cookie is marked `Secure`, so a
  browser drops it over plain HTTP.
- **Proxy/VPN detection beyond Tor exits, cloud providers' published ranges, and region
  or city.** No licensed VPN or proxy list has been found; datacenter traffic is
  recognised by ASN only, since no cloud provider's range file states a licence. The
  region and city columns exist on a click and are always empty, and a breakdown by
  either would be a new materialized view and a backfill of it.
- **Backups that encrypt, rotate or leave the server**, and **a restore of one part of a
  backup**. `backup.sh` writes one directory; `restore.sh` replaces everything and is an
  outage while it runs.
- Segments ClickHouse rejects are set aside as `.bad` files, and nothing reports them.
- One redirect process per spool directory.
- A full spool stops recording without stopping redirects; the drop count is on
  `/health` on the internal port and nowhere else.
- The internal port (`redirect:9091`, which serves `/ask`) and the admin port
  (`admin:9100`) are published nowhere on the host, but any container on the compose
  network can reach both, not only Caddy. The admin service's own `Host` guard — read
  from the connection, never from a forwarded header — and its credential check are what
  stand behind that, and `/health` sits in front of the guard on purpose.
- The worker has no healthcheck, so `docker compose up -d --wait` can return before its
  boot migration has finished; a `domain add` run immediately after refuses with "this
  database has not been migrated yet".
- The published-port IPv6 test is skipped on a host with no IPv6 address of its own;
  see "The stack suites" below for what still runs when it is.

**Upgrade the worker before the redirect.** A worker never deletes or sets aside a spool
segment whose record version is newer than it reads: segments from a newer redirect wait
in the spool, counting toward its size bound, until the worker is upgraded. Support for
reading a record version ships no later than writing it.

## Stack and layout

A pnpm workspace of TypeScript packages, Node 22, ESM throughout. TypeScript is `strict`
with `noUncheckedIndexedAccess`; avoid `any`, and justify it inline on the rare occasion
it is unavoidable. Biome handles lint and format. Vitest runs the tests. Two stores:
**Postgres** for domains, links, counters, the admin account and its credentials, the one
install-wide settings row (the traffic actions and the two retention periods) and the
single migration ledger; **ClickHouse** for click events and the hourly rollups over them.

```
packages/core/      pure logic, no I/O: link schemas (zod), the redirect evaluator,
                    device, OS and browser detection, traffic classification,
                    destination tokens, passthrough, rotation, click IDs, the click
                    record, the vocabulary a report is asked in (bucket sizes,
                    dimensions, window bounds) and the credential primitives
                    (password hashing, opaque tokens, TOTP, recovery codes,
                    attempt counting). Owns SCHEMA_VERSION.
packages/db/        Postgres and ClickHouse clients and the migrator. Migrations live
                    in packages/db/migrations/{postgres,clickhouse} as one shared
                    version sequence.
packages/ipdata/    IP data: the compact range-table format, the source parsers
                    and their licences, the manifest the redirect loads, and the
                    updater the worker runs.
packages/redirect/  the service that answers link domains: an in-memory snapshot,
                    the IP data and the per-client rate counter, the spool
                    writer, the click-cap counter, the password gate and its
                    proof cookie.
packages/worker/    ships the spool into ClickHouse; runs migrations on boot;
                    updates the IP data; checks domain DNS verification on a schedule;
                    deletes past the retention periods; owns the one reader and
                    writer of the settings row that the CLI and the admin API share.
packages/admin/     the admin API: sessions, API keys, TOTP, domain/link/settings CRUD,
                    the reports, the click log and its CSV export.
packages/ui/        the web interface: React 19, Tailwind 4, a Vite build the admin
                    service serves from its own host and dist/. No colour in source, no
                    Radix overlay primitive, no runtime import from a service package,
                    one <h1> per screen. Every time shown is the browser's own zone, except a
                    click's raw fields, which are labelled UTC.
packages/cli/       `clickmonk migrate | domain | link add | settings | ipdata | admin | apikey |
                    version`.
                    Two commands here are deliberately not API routes: `admin create`,
                    because nothing can authenticate before the account exists, and
                    `admin totp disable`, because it is the way back in when the second
                    factor is gone and so must not be reachable by a request.
caddy/              the Caddyfile, and the tls.d/ and proxy.d/ drop-in directories an
                    operator edits: where certificates come from, and a proxy in
                    front of Caddy. The Caddyfile routes CLICKMONK_ADMIN_HOST to the
                    admin service and every other name to the redirect, with a CEL
                    expression rather than a host matcher so an unset value starts.
install.sh          writes .env once, with fresh secrets, and starts the stack.
backup.sh           copies Postgres, ClickHouse, the spool, caddy-data and .env into one
                    directory, stopping only the worker, and only while the spool and
                    ClickHouse are copied.
restore.sh          checks a backup, then replaces all four stores with it; the only
                    script here that deletes data. Both source backup-lib.sh, which
                    holds the lock they share: one run at a time per install.
clickhouse/         backup-disk.xml, the disk ClickHouse's own BACKUP writes to.
test/stack/         brings the whole stack up against a local certificate authority
                    and DNS server; proves TLS issuance, domain verification, real
                    client addresses over IPv4 and IPv6, and the admin host — its
                    certificate, a sign-in over HTTPS, a password-protected link
                    answered end to end, a click driven through the whole stack and
                    read back as a report, a log page and a CSV, and a retention
                    period lowered and then enforced. `ui.test.ts` drives the web
                    interface itself in a real browser, on that same stack, and fails
                    on any content security policy violation on any screen.
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

**`pnpm test` is two suites, run one after the other: the service packages' own Vitest run,
then `packages/ui`'s** (`vitest run && pnpm --filter @clickmonk/ui test`). The interface's
suite has its own config and runs in `Australia/Adelaide`; see `packages/ui/vitest.config.ts`
and CONTRIBUTING.md. Neither talks to the browser suite in `test/stack/`, which is part of
the stack suites below.

**Build before the first test run, and after changing `core`, `db`, `ipdata`, `worker` or
`admin`.**
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

### The stack suites

```sh
pnpm build
pnpm vitest run --config vitest.stack.config.ts   # starts the stack; a few minutes
```

They bring the whole stack up with a certificate authority and a DNS server of their own,
so no ACME traffic and no public DNS lookup leaves the machine (the images themselves
are still pulled over the network, once): a domain gets no certificate until it
publishes its verification record, the address every visitor arrives from is the
visitor's, and `install.sh` writes its secrets once. They also bring the admin service
up, sign in to it over HTTPS on the admin host, and drive a password-protected link from
the form to the redirect. One of them clicks a link through Caddy and then reads that
click back through the admin host as a summary, a chart, a breakdown, a log page and a
CSV, and lowers a retention period and watches the worker enforce it — the one path where
the admin service's own ClickHouse configuration has to be right. One of them takes backups
of a running stack, refuses damaged and newer ones without touching anything, then destroys
every volume and restores into an empty stack. They bind **80 and 443**; the
durability suite binds 8080 and 8123 and the test databases 8123 and 5433. Run one at a
time.

The IPv6 half of the address suite is skipped on a host with no IPv6 address of its own,
which is most CI runners. Run it by hand on a host that has one before a release.

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
- **`packages/ui/src` writes no colour of its own.** A colour bypasses the measured brand
  roles; use a semantic class or `var(--color-…)`.
- **`packages/ui` ships no Radix overlay primitive, no inline script or style, and no
  runtime import from a service package.** The first two the content security policy
  refuses outright; the third throws at load in a browser that has no Node behind it.
- **Every screen in `packages/ui` has exactly one `<h1>`**, asserted by heading level, not
  by its text.

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
arrays, no `mapfile`. `install.sh` is the first. `backup.sh`, `backup-lib.sh` and
`restore.sh` follow the same rules, and the backup suite parses all three under a real
bash 3.2. `shellcheck` is pinned as a Docker image
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
   one and assuming.
   The places: `"version"` in the root `package.json` and in each of the eight
   `packages/*/package.json`, and `VERSION` in `packages/core/src/version.ts` — ten in all.
   `packages/core/src/version.test.ts` fails if any of them disagrees, and counts the
   manifests, so a new package fails it until the count in the test is raised.
   The README's "Installing" block checks out the release by its tag, and is bumped in the
   same commit. The version test does not see it, so count it too:
   `sed -n '/^## Installing/,/^## /p' README.md | grep -c 'git checkout vX.Y.Z'` prints 1.
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
