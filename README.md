<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup-light.svg" alt="ClickMonk" width="220">
  </picture>
</h1>

Self-hosted link tracking and reporting for affiliate and digital marketers. You run it
on your own infrastructure, and your click data stays yours.

## Status

**0.1.0, the first release.** It has not yet carried anyone's production traffic, and the list
below of what it does not do is part of the release. What it does:

- **The redirect**, which answers links on your domains from an in-memory copy of the
  configuration: weighted rotation across destinations, click caps, expiry, backup URLs
  and query passthrough. It writes every click to a spool on
  local disk before it answers, and keeps redirecting while Postgres or ClickHouse is
  down.
- **The worker**, which ships spooled clicks into ClickHouse, runs the database
  migrations when it starts, keeps the IP data up to date, and deletes what this install
  has stopped keeping.
- **TLS on every link domain.** Caddy sits in front and obtains a certificate the first
  time someone asks for a domain over HTTPS, then renews it without anyone touching a
  file. It asks ClickMonk first, and ClickMonk says yes only for a domain you added and
  verified, and for the admin host name if you set one, so a host name somebody else
  points at your server never makes your install ask a certificate authority for anything.
- **Domain verification.** `clickmonk domain add` prints a TXT record to publish. The
  worker looks for it every five minutes, up to 50 domains a pass with the longest unchecked
  first, and `clickmonk domain verify` looks now. Until
  it is found, links on that domain answer 404 and it gets no certificate. A check that
  fails later is recorded and shown, and never takes a verified domain back down.
- **`./install.sh`**, which writes `.env` with fresh secrets the first time, builds the
  image and starts the stack. Running it again changes nothing that is already set.
- **An admin API.** One admin account, created on the server with `clickmonk admin
  create`, a session cookie for a browser and API keys for a script, two-factor
  authentication with recovery codes, and endpoints for domains, links, the
  install-wide settings and everything under "Reading the clicks back out"
  below. It answers on one host name of its own — set
  `CLICKMONK_ADMIN_HOST` — and Caddy gets it a certificate the first time you visit it.
- **A web interface**, served on that same host name, over HTTPS, alongside the API — see
  ["The web interface"](#the-web-interface) below.
- **Password-protected links.** Set a password on a link and visitors are asked for it on
  a ClickMonk page on your own domain before they are sent on. Attempts are counted per
  client per link — an IPv4 address, or a whole IPv6 /64, since one client usually holds
  an entire /64 and can pick a new address out of it for every request — and the proof a
  visitor holds stops working the moment you change the password.
- **Traffic classification.** Every click is classed as human, bot, abuser, anonymous
  (a Tor exit), datacenter, or unknown when the IP checks could not run, from its
  user-agent, the number of requests from the same client in the current one-minute window,
  and IP data held on your server. Bot, abuser, anonymous and datacenter each have an
  action: flag (the default), nothing, block, or send to a safe URL. An unknown click is sent
  on as a human one is. A flagged click never uses up a click
  cap, but a cap that is used up closes the link to it like any other. A HEAD request,
  which link checkers and preview bots send, gets the same answer as a GET, is recorded
  as a bot unless another check gives it a class, and never uses up a click cap. Each
  click also records its country, network (ASN), operating system and browser.
- **Country rules** use the country looked up from the visitor's address.
- **Reports over the admin API.** Clicks come back out: a summary of a window, a chart by
  hour or by day, and a breakdown by country, device, operating system, browser, referring
  host, the target rotation chose, the traffic class, the action taken, the outcome, or the
  link. They
  read hourly rollups written as the clicks arrive rather than the clicks themselves, so a
  window of a year is read as hours and not as every click inside it, and every number
  counts a click once even if the worker shipped its spool segment twice. **A report counts
  whole buckets** and says in its answer which window it counted: ask for
  `from=2026-09-24T10:30:00Z` and the summary tells you you were given 10:00 onwards, while
  a chart by day tells you it gave you the whole day.
- **The click log, and a CSV of it.** `GET /api/clicks` lists the clicks themselves, newest
  first, filterable by link, traffic class, outcome, country and time, and exact to the
  millisecond. `GET /api/clicks.csv` is the same rows as a file: it streams, so the file is
  never built in memory, and its window, like every other, is at most 400 days. When it
  reaches its row cap it says so in a header rather than handing you a prefix that looks
  complete. The file identifies visitors, which "Reading the clicks back out" spells out
  before you send one to anybody.
- **Addresses are shown as networks, always.** The log and the export show
  `198.51.100.0/24` and `2001:db8:1234:5678::/64`, never the address itself — enough to see
  a pattern or a bot, and not a file of addresses. The whole address stays in the database
  until the address retention period blanks it, because the traffic classification and the
  per-client counters need it, and no response reads it back out.
- **Retention.** Raw clicks are kept for 90 days on a new install and the address on them
  for 30, both changeable with `clickmonk settings set --keep-clicks` and
  `--keep-addresses`, and either can be `never`. The rollups are never deleted, so a chart
  or a breakdown still answers for a window whose raw clicks are gone. **Both periods are
  floors, not deadlines**: clicks are stored a month at a time and dropped the same way, so
  90 days keeps 90 to 121 days of clicks and 30 days of addresses keeps them 30 to 61.
- **The CLI**: `clickmonk migrate`, `clickmonk domain add|list|verify`, `clickmonk link add`,
  `clickmonk settings show|set`, `clickmonk ipdata status|update`, `clickmonk admin create`,
  `clickmonk admin passwd`, `clickmonk admin totp disable`, `clickmonk apikey create|list|revoke`,
  `clickmonk version`.
  `settings set` covers the traffic actions, the safe URL, the abuser threshold and how
  long this install keeps clicks and the addresses on them (`--keep-clicks`,
  `--keep-addresses`, each taking a number of days or `never`).
  `admin create` and `admin passwd` read the password from standard input and from nowhere
  else; `admin totp disable` reads none, and is the way back in when both factors are lost.
- **A Docker Compose stack** that runs all of it, and a test that restarts each service
  under continuous traffic and requires every redirect the client received to arrive in
  ClickHouse as a click.
- **Backup and restore.** `./backup.sh` copies everything an install holds — the clicks
  and rollups, the configuration, clicks still waiting in the spool, the certificates and
  `.env` — while links keep answering, and `./restore.sh` puts all of it back, into the
  same release or a newer one. A test takes a backup, destroys every volume, restores into
  an empty stack and counts every click once. See ["Backup and restore"](#backup-and-restore).

What does not work yet:

- **More than one admin account.** There is exactly one, and it is the whole of the access
  control: no second person, no roles, no record of which of you did something, and no way
  to let someone in and then out again except by changing the one password, which signs
  every browser out. An API key is the only credential you can hand over and revoke on its
  own, and a key is not a person — it cannot sign in, and nothing it does is attributed to
  anyone. The admin API also cannot be tried without a real domain name: see that section.
- **A CSV of a report, from the API itself.** `GET /api/clicks.csv` streams the click log
  only; a summary, a chart or a breakdown is already one small answer, and turning one of
  those into a file is the web interface's own doing, in the browser, not a route this API
  streams.
- **A time zone, for the install or on the API.** The install has no zone setting of its own
  ([#43](../../issues/43)). Every window and retention period it takes is UTC, and so is
  a chart's bucket size — `offset` only moves where a day bucket begins, in whole hours, and
  does nothing for an hourly one. A preset like "yesterday" is for whoever is asking to work
  out — the web interface does that from the browser's own zone; a script calling the API
  directly still has to.
- **A breakdown by two things at once.** One dimension per request: clicks by country, or
  clicks by browser, never clicks by country by browser.
- **A report of a window older than this install's rollups.** They are written as the clicks
  arrive and there is nothing to backfill them from, so a window from before this install
  had them reads as zeroes rather than as a refusal.
- **A report is only as fresh as the shipper.** Nothing reads the spool: a click that has
  not been shipped is in no report, and the shipper stops while ClickHouse is unreachable.
  The redirect keeps answering and keeps spooling throughout, so nothing is lost — it has
  simply not arrived yet.
- **Reports answer nothing while ClickHouse is down.** `GET /api/reports/…`,
  `GET /api/clicks`, `GET /api/clicks.csv` and `GET /api/clicks/count` answer 503; domains,
  links and settings keep working. `GET /api/status` is the exception: it still answers
  200, with `"reporting":"unavailable"`, because it is the thing that says reporting is
  down.
- **An export that fails part way through ends the connection** rather than finishing the
  file, because a file that looks complete and is not is worse than a download that broke.
- **Any notification.** Nothing is emailed, posted or pushed anywhere: there is no mail
  configuration and no secret for one. `GET /api/alerts` lists every domain whose last DNS
  check did not find its token, and every domain no check has reached, which is what an
  operator has instead. A domain verified by hand (`domain add --verified`) is the one
  exception: it is not listed until a check has passed for it at least once, because
  nothing changed for it — a check that then fails, having once passed, is listed.
- **Most link settings in the CLI.** `clickmonk link add` sets targets, a backup URL, a
  click cap, an expiry, passthrough and traffic action overrides only, and no command
  changes a link once it is added. Per-device destinations, a returning-visitor
  destination, country rules, a link name, a password and disabling a link are set
  through the admin API, or by hand in SQL without it.
  Returning-visitor routing also needs HTTPS to do anything: its cookie is marked
  `Secure`, so a browser drops it over plain HTTP.
- **Bulk operations.** One link and one domain at a time, in the web interface as in the
  CLI ([#39](../../issues/39)).
- **Proxy and VPN detection beyond Tor.** The anonymous class covers Tor exit relays
  only. The well-known lists of VPN and proxy ranges publish no licence, so they are not
  used.
- **Cloud providers' published address ranges.** Datacenter traffic is recognised by its
  network (ASN) only. The providers' range files state no licence, so they are not used.
- **Region and city.** A click records its country only. The two columns exist and are
  always empty, and a breakdown by either would need a rollup of its own.
- **Backups that look after themselves.** `backup.sh` writes one directory and stops:
  it does not encrypt it, rotate old ones, or copy anything off the server. Those are yours,
  and the section on backups says what to use.
- **Restoring one part of a backup.** A restore replaces everything, and your links answer
  nothing while it runs.
- **Rejected clicks are not reported.** A batch of clicks ClickHouse refuses is set aside
  as a `.bad` file in the spool, and nothing tells you it is there.
- **More than one redirect process per spool directory.**
- **A full spool stops recording without stopping redirects.** Above its size bound the
  redirect keeps sending visitors on but drops the click; the running count of drops is
  in `/health` on the internal port, and nowhere else yet.
- **The redirect and the admin API are reachable from the whole compose network.** None of
  their ports is published on the host, but any other container on the stack's own Docker
  network can reach all of them, not only Caddy. On `redirect:9091` that means reading the
  `ask` check, which answers, for any name, whether it is a verified domain here. On
  `redirect:8080` it means more: the stack trusts a forwarded address from that network
  (`CLICKMONK_TRUSTED_PROXIES` is `uniquelocal,loopback`), so a container inside the install
  can set `X-Forwarded-For` and choose the address recorded, counted and looked up for every
  click it sends. On `admin:9100` a request still has to carry the admin host name in `Host`
  — a forwarded header will not do, and every route but `/health` is refused without it —
  and then it still needs a credential. Every container on that network is one you put
  there, which is what keeps this a limit rather than a way in.
- **IPv6 coverage depends on the host the tests run on.** The published-port IPv6 test
  is skipped when that host has no IPv6 address of its own — most CI runners — and is
  meant to be run by hand, on a host that has one, before a release. A second,
  always-run test proves the address Caddy passes on is the IPv6 client's own, but only
  on the stack's unique-local subnet.
- **A published container image.** A release is a tag, and an install builds its image from
  the checkout: see ["Upgrading"](#upgrading).

How fast a redirect is, how to back an install up, how to upgrade it and what it exposes
each have a section below.

If link tracking is a problem you have today, [open an issue](../../issues) describing
it. That is the most useful contribution at this stage.

## Installing

You need a Linux host with Docker and Docker Compose 2.23 or later (the backup scripts need
it), and ports 80 and 443 free.

```sh
git clone https://github.com/ClickMonk/clickmonk.git
cd clickmonk
git checkout v0.1.0
./install.sh
```

It writes `.env` with fresh passwords — that file is the only copy of them, so back it
up — builds the image from this checkout and starts the stack. Run it again any time:
it never changes a value already in `.env`.

`install.sh` waits for the services that declare a healthcheck; the worker does not
declare one, so `install.sh` can return before its boot migration has finished. If a
`domain add` run right after it says the database has not been migrated yet, that is
why: wait a few seconds and try again.

**Just trying it out?** A domain serves nothing until it is verified, so for a trial add
one with `--verified`, which skips the DNS check and makes its links answer at once over
plain HTTP on port 80. A returning visitor is not one of them: the visitor cookie is
marked `Secure`, so a browser drops it over plain HTTP, and returning-visitor routing
needs a real HTTPS domain to do anything.

```sh
docker compose exec -T worker node packages/cli/dist/index.js \
  domain add links.example.com --verified
docker compose exec -T worker node packages/cli/dist/index.js \
  link add links.example.com promo --target https://example.com/landing
```

Nothing points at this server yet, so ask for it by name instead of by DNS:

```sh
curl -H 'Host: links.example.com' http://localhost/promo
```

## Domains and TLS

Add a domain:

```sh
docker compose exec -T worker node packages/cli/dist/index.js domain add links.example.com
```

It prints the TXT record to publish, at `_clickmonk.links.example.com`, and reminds you to
point `links.example.com` at this server yourself — an A or AAAA record, or a CNAME,
whichever your DNS provider gives you. Publish both, then wait: the worker checks every five
minutes, up to 50 domains a pass with the longest unchecked first,
`domain verify links.example.com` checks at once, and `domain list` shows where each domain
stands.

**Until the TXT record is found the domain serves nothing.** Over plain HTTP, links on it
answer 404. Over HTTPS there is no certificate to present, so the connection never gets
that far: the TLS handshake itself fails, an SSL error with no page behind it. That is
what stops somebody else's hostname, pointed at your server, from getting a certificate
out of your install. `domain add --verified` is the way round it, for a trial or for a
domain you proved some other way; it says on screen that no DNS check was made, and such
a domain is not shown in `GET /api/alerts` or counted in `GET /api/status` until a check
has passed for it once — until then nothing has changed for it, so there is nothing to
warn about. A check that later fails, having once passed, is an alert.

ClickMonk does not know its own public address, so it records what a domain resolves to
rather than judging it — a host behind NAT, a load balancer or a CDN is normal. A domain
that stops publishing its record is reported, never un-verified: taking live links down
because a resolver hiccuped would be worse than the problem. If you take a domain back
down yourself — `POST /api/domains/:id/unverify` over the admin API, or deleting its row
in Postgres, since the CLI has no command for it — the certificate it already has stays
in the `caddy-data` volume and Caddy keeps presenting it until it expires. What stops is
the renewal, and any new certificate for it.

**IPv6 visitors are only recorded by their own address if the Docker daemon NATs their
connections to the published port**, rather than relaying them through its own userland
proxy — that is what `docker-compose.yml`'s `enable_ipv6: true` network setting is for.
Check it once you have an AAAA record published: a click from an IPv6 address should
show that visitor's own address, not one on your Docker bridge. If it does not, your
Docker install needs its own IPv6 NAT support turned on; this repository has not pinned
a minimum Docker version for that, so consult your distribution's own Docker
documentation.

**Behind Cloudflare's proxy**, the challenge a certificate authority sends is answered by
Cloudflare rather than by this server, so issuance fails. Either use a DNS-only (grey
cloud) record, or turn the proxy on with Cloudflare set to Full (strict) and use an
Origin certificate. Nothing mounts one into Caddy by default: add the mount in
`docker-compose.override.yml` first, then name the file in
`caddy/tls.d/00-defaults.caddy` — both are shown in that file's comments. Skip the mount
and Caddy exits at boot, unable to find a file that was never there. Flexible mode sends
traffic to your server in clear and is not an option.

Certificates live in the `caddy-data` volume, and `backup.sh` copies it with everything
else, so a restored install presents the certificates it had rather than asking the
certificate authority for every domain again at once.

## How fast a redirect is

A redirect is answered from memory. The redirect holds every link, domain and setting in an
in-memory copy it refreshes when something changes, looks the visitor's address up in IP data
it also holds in memory, writes the click to a file on local disk, and answers. It makes no
network call for a link without a click cap. A capped link asks Postgres to count the click,
waits at most 150 milliseconds for the answer, and sends the visitor on anyway if none comes;
either database can be down and links keep answering.

Measured with the stack this repository ships, on an 8-core AMD EPYC virtual machine with
6 GB of memory, over plain HTTP from a container on the stack's own network — so the figure
is Caddy and the redirect, not a network — on a link with no click cap: a median of 1.1 to
1.4 ms and a 99th percentile of 2.3 to 4.4 ms, over three runs of 2,000 requests one after
another. Measure your own server:

```sh
for i in $(seq 200); do
  curl -so /dev/null -w '%{time_starttransfer}\n' -H 'Host: links.example.com' http://localhost/promo
done | sort -n | awk '{a[NR]=$1} END {print "median", a[int(NR/2)], "p99", a[int(NR*0.99)]}'
```

**What no self-hosted tool can change is the distance.** A visitor in Sydney clicking a link
served from Frankfurt waits for the round trips between them — a TCP connection, a TLS
handshake and the request — which is hundreds of milliseconds whatever the server does. A
hosted service with servers on every continent answers from somewhere near the visitor;
ClickMonk answers from wherever you run it. Put it near the people who click.

**Each click is written before the visitor is answered**, and the disk is synced in batches
every 200 milliseconds: a click survives the redirect crashing the moment after it answered,
and a power cut loses at most the last 200 milliseconds of clicks.

## The admin API

**This one needs a real domain name.** A link domain can be tried over plain HTTP on a
laptop with `--verified`; the admin API cannot be tried at all that way. Plain HTTP on the
admin host answers `308` to HTTPS, and the session cookie is `Secure` with the `__Host-`
prefix, so a browser will not store it over HTTP even if it could reach the form. Set this
up on a host with a name pointed at it, not on your own machine.

Create the one admin account first — it needs nothing but the database, and nothing can
authenticate until it exists. The password is read from standard input, never from an
argument, because arguments are visible in `ps` and left in your shell history. It is
between 12 and 200 characters.

```sh
printf '%s' 'your-admin-password' | docker compose exec -T worker \
  node packages/cli/dist/index.js admin create you@example.com
```

**Keep the `-T`.** Run that line from a terminal without it and Compose asks for a terminal
inside the container, then refuses to attach the pipe to one — `cannot attach stdin to a
TTY-enabled container because stdin is not a terminal`, and the command never runs. (From a
script, where nothing is a terminal, it works either way. The flag is never wrong, so it is
in every line here.) Leave out the pipe as well and the command does run, and refuses: a
password typed at a terminal is echoed on screen and kept in your shell history.

Then pick the host name the API answers on. It must **not** be a link domain — link slugs
and admin routes would otherwise share one namespace, and `domain add` refuses a link
domain under this name for that reason — point it at this server, and put it in `.env`:

```sh
# in .env
CLICKMONK_ADMIN_HOST=admin.example.com
```

The value is a bare lower-case host name: no scheme, no port, no wildcard. The admin
service refuses to start on anything else and names the variable. **Your links are not
affected by a mistyped one:** the redirect reads the same variable only to tell Caddy which
name may have a certificate, so it logs that it ignored the value and carries on serving,
and the certificate check then approves verified link domains and nothing else — which
means the admin interface gets no certificate until the value is fixed.

Only `domain add`'s direction of the clash is caught. Set this to a name a link domain
**already** holds and Caddy starts sending it to the admin API, that domain's links stop
resolving, and nothing warns you, so check `clickmonk domain list` first. Restart when the
value is right, so Compose hands it to the services that read it:

```sh
docker compose up -d
```

Visiting `https://admin.example.com/api/me` is what makes Caddy obtain a certificate for
that name, on the first request; with no credential it answers `401`, which is the API
working. Sign in with `POST /api/session`, which sets a session cookie:

```sh
curl -s -c cookies.txt -X POST https://admin.example.com/api/session \
  -H 'content-type: application/json' -H 'origin: https://admin.example.com' \
  -d '{"email":"you@example.com","password":"your-admin-password"}'
curl -s -b cookies.txt https://admin.example.com/api/me
```

**Every request that changes something needs an `Origin` header naming that host — the
sign-in itself included** — which is what stops another site from making your browser
change your links. An API key is exempt, which is why a script is better off with one.

Turn on two-factor authentication with `POST /api/totp`, which takes the password and
hands back a secret to put in your authenticator app, then `POST /api/totp/confirm`, which
takes the password and a code from the app and prints ten recovery codes once. The secret
is the one the server minted, so `confirm` takes those two fields and nothing else — and it
does not wait: an enrolment you do not confirm within fifteen minutes is gone, and `confirm`
then tells you to start again. From then on the sign-in body carries a `code` as well, or a
`recoveryCode` instead of one; and replacing or removing the authenticator over the API
needs a code from the app you already have, or one of those recovery codes, not just the
password.

**Locked out, or the authenticator is gone.** Five wrong passwords lock the account for
five minutes, six for ten, and so on to an hour; the count is forgotten an hour after the
last failure, and a sign-in that succeeds clears it. `GET /api/me` shows the count and any
standing lock to a signed-in browser, before the lock bites. Separately, each client gets
ten failed sign-ins per fifteen minutes, counted in the process rather than in the
database — a client being one IPv4 address or one IPv6 /64, because an IPv6 client usually
holds a whole /64 and counting each address on its own would be no bound at all for one.
The session list still shows the full address each of your browsers signed in from. Two commands on the server are the way back, and both work while the account is
locked, because both run where a request cannot reach:

```sh
printf '%s' 'a-new-admin-password' | docker compose exec -T worker \
  node packages/cli/dist/index.js admin passwd
docker compose exec -T worker node packages/cli/dist/index.js admin totp disable
```

`admin passwd` sets the password, clears the lock and signs every browser out.
`admin totp disable` is for the case the API deliberately has no answer to: the
authenticator app **and** every recovery code are gone. It removes the second factor,
deletes the recovery codes — telling you how many were still unused, in case that number
is a surprise — clears any lock, signs every session out, and says to enrol again, because
until you do the password alone is the whole of the account. It reads no password and asks
nothing. **That it needs a shell on this host is the whole reason it is allowed to do
this:** over the API, removing the factor requires the factor, because otherwise
disable-then-enrol would be the way around having one at all.

`GET /health` on that host answers `{"status":"ok"}` to anyone, because Caddy has to be
able to route it and Compose has to be able to probe it. It tells a stranger nothing else —
not whether the install is configured, and not whether the account exists. That is
`GET /api/me`, which needs a credential.

`GET /api/domains` returns at most 500 entries and `GET /api/keys` at most 200, each
setting `"truncated": true` when there were more. `clickmonk domain list` has no such cap;
`clickmonk apikey list` has the same one and says when it hit it. `GET /api/links` pages
properly, with `limit` and an opaque `cursor` from the previous answer — newest links
first. `q` searches the slug and the name, case-insensitively, as a substring; it reads
every link on the install, so it is fine for what an operator has and not a plan for a
much larger one. Each link in the response carries `createdAt` and, for a link with a
click cap, `capUsed` — `null` for a link with none.

The install-wide settings are `GET /api/settings` and `PUT /api/settings` — the same
things `clickmonk settings set` covers, in two halves: `traffic` and `retention`. The
`PUT` takes the whole object rather than the fields you want to change, because the safe
action and the safe URL depend on each other and a half-written pair is how a link ends up
sent to nowhere. `retention` comes back as `null` rather than as the defaults whenever
this install's kept periods are not known — the settings row is missing, or its stored
periods cannot be read — and nothing is deleted while it reads that way. A missing row is
the likelier of the two: it is one `DELETE` away, and the defaults would answer it with a
period nobody chose.

**`clickmonk settings set` is what repairs that row, and the `PUT` is not.** The `PUT`
requires a `retention` object, so the body a `GET` hands back in this state — with
`"retention": null` — is one the `PUT` refuses: a script that reads, changes a field and
writes back cannot fix the state the read just told it about. Use the CLI, which writes the
periods you name over the defaults for the rest and prints what it wrote; after that the
`GET` and the `PUT` agree again.

The worker enforces both periods, and **each one is a floor rather than a deadline** —
[How long ClickMonk keeps things](#how-long-clickmonk-keeps-things) below has the numbers
and what a missing row does. What is deleted is the raw clicks and the addresses on them;
the hourly rollups — which every report but the click log and its export reads — are kept,
which is why a chart still answers for a window whose raw clicks are gone. A blanked
address reads as no `network` at all, `null` in the log and an empty cell in the export,
the same as an address this build's parser does not recognise: the answer does not tell
those two apart, because the row does not either.

For a script, mint an API key and send it as `Authorization: Bearer …`:

```sh
docker compose exec -T worker node packages/cli/dist/index.js apikey create reporting
```

A key can read and write domains, links and settings, read the reports, the click log and
the CSV export, and read the account's identity at `GET /api/me`: the email address,
whether two-factor authentication is on, and how many recovery codes are unspent. It can
change no credential at all. Every route that touches one wants a session instead: listing
or ending sessions, changing the password, anything to do with two-factor authentication,
and minting or revoking a key. So a key
that leaks cannot lock you out of your own install, and cannot make itself a second key.
`GET /api/me` also reports the failed sign-in count and any standing lockout, and those two
it reports only to a session: they say whether someone is attacking the account right now,
which is not a key's business.

**What the API cannot do, on purpose:** it cannot mark a domain verified. Only a DNS check
that finds this install's token, or `clickmonk domain add --verified` typed on the server,
can do that. It *can* un-verify one, which stops its links serving and stops its
certificate renewing — but a certificate Caddy already holds is presented until it expires,
so un-verifying is not a way to take a domain off the air quickly.

`POST /api/domains/:id/check` asks DNS now instead of waiting for the worker's next pass.
It refuses a second check of the same domain within a minute, naming the result it already
has, and it runs at most two checks at a time: a credential is not a licence to make this
install query DNS in a loop.

**If you never set `CLICKMONK_ADMIN_HOST`,** nothing above exists and nothing breaks: the
stack starts, Caddy routes every name to the redirect exactly as it did before, the admin
service answers `503` on every route but `/health`, and the CLI is the only way in.

## The web interface

Served on `CLICKMONK_ADMIN_HOST` and nowhere else, over HTTPS, by the same admin service that
answers the API — visit the admin host in a browser and sign in. Each screen:

- **Overview** — every link on every domain, as one report.
- **Links** — the link list, searchable, and where a link is created, edited, or opened for its
  own report.
- **Clicks** — the click log, filtered by link (from a link's own page), traffic class, outcome
  and country, with the CSV export.
- **Domains** — adding a domain and checking its record until it verifies.
- **Settings** — the traffic action for each non-human class, the safe URL, the abuser
  threshold, and how long this install keeps clicks and their addresses.
- **Account** — the password, two-factor authentication, the sessions signed in, and API keys.

**Every time on screen is in the browser's own zone, never the server's, except a click's raw
fields, which are labelled UTC.** A day chart's days
still begin on a whole hour of UTC, because that is the grain the hourly rollups are kept at.
So a zone that is not a whole number of hours from UTC — India Standard Time, UTC+5:30, is one
— has its days begin off midnight, at 23:30 or 00:30 rather than 00:00, and the screen says so
when it does.

**Unique visitors counts what a cookie sees**, the same as the API: a client that keeps no
cookie is a new visitor on every click. **The CSV export states the row count and whether it
will hit the cap before the download starts**, and only one export runs at a time — the same
limit ["Reading the clicks back out"](#reading-the-clicks-back-out) describes for the API.

**Nothing here polls.** The numbers on screen are as fresh as the last "Refresh", or as coming
back to the tab after a minute away; there is no timer running in the background asking the
service for anything.

**Nothing the interface does is unavailable to a script.** Every screen is built on the same
admin API documented in ["The admin API"](#the-admin-api) and
["Reading the clicks back out"](#reading-the-clicks-back-out) — so anything the interface can
do, a `curl` command or the CLI can do too.

**What it does not do yet:** there is no time zone setting for the install itself, only the
browser's own zone; no bulk operations — one link and one domain at a time, the same
as the CLI; and no local development mode, so trying it needs a real admin host set up, the
same as the API does. See [#43](../../issues/43), [#39](../../issues/39) and
[#23](../../issues/23).

## Reading the clicks back out

Every one of these is a read, so an API key reaches all of them and no `Origin` header is
needed. Windows are UTC, `from` is included and `to` is not, and a window may be at most
400 days.

```sh
# Everything, for a day
curl -H "authorization: Bearer $KEY" \
  "https://admin.example.com/api/reports/summary?from=2026-09-23T00:00:00Z&to=2026-09-24T00:00:00Z"

# A chart: bucket=hour or bucket=day, at most 2000 buckets in one answer.
# offset moves where a day begins: a whole number of hours from UTC midnight,
# -12 to 14, default 0. offset=3 counts days from 21:00 UTC — midnight at
# UTC+3. It changes nothing on an hourly chart, since a whole-hour offset
# moves no hour boundary, and a half-hour zone is counted from the nearest
# whole hour.
curl -H "authorization: Bearer $KEY" \
  "https://admin.example.com/api/reports/timeseries?from=2026-09-01T00:00:00Z&to=2026-09-24T00:00:00Z&bucket=day&offset=3"

# One dimension: country, device, os, browser, referrer, target, class, action,
# outcome, link. A breakdown by link carries a link object — slug, host and
# name — on each row, read from the link table rather than the rollup; null
# when the id names no link any more.
curl -H "authorization: Bearer $KEY" \
  "https://admin.example.com/api/reports/breakdown?from=2026-09-23T00:00:00Z&to=2026-09-24T00:00:00Z&dimension=country&limit=20"

# The log itself, newest first, paged with the cursor the previous answer gave
curl -H "authorization: Bearer $KEY" \
  "https://admin.example.com/api/clicks?from=2026-09-23T00:00:00Z&to=2026-09-24T00:00:00Z&class=bot&limit=100"

# How many rows an export of the same filters would write, before asking for
# the file: {"window":{...},"link":null,"count":1234,"cap":1000000,"truncated":false}
curl -H "authorization: Bearer $KEY" \
  "https://admin.example.com/api/clicks/count?from=2026-09-01T00:00:00Z&to=2026-09-24T00:00:00Z"

# And as a file
curl -H "authorization: Bearer $KEY" -OJ \
  "https://admin.example.com/api/clicks.csv?from=2026-09-01T00:00:00Z&to=2026-09-24T00:00:00Z"
```

Add `&link=<id>` to any of them for one link instead of all of them. **Nothing looks the
link up**, so an id that belongs to no link is an empty answer rather than an error, on all
six of these.

**`GET /api/status`** takes no query string and answers how fresh everything is in one read:

```sh
curl -H "authorization: Bearer $KEY" "https://admin.example.com/api/status"
# {"newestHour":"2026-09-24T11:00:00.000Z","reporting":"ok",
#  "ipData":{"country":{"version":"2026-09","fetchedAt":"2026-09-20T03:00:00.000Z"},
#            "asn":null,"datacenter":null,"tor":{"version":"…","fetchedAt":"…"}},
#  "ipDataProblem":null,"alerts":2}
```

`newestHour` and `reporting` are the summary's own freshness, answered here even when
ClickHouse cannot be reached: `reporting` is `"unavailable"` and `newestHour` is `null`
rather than a 503, because this is the route that says reporting is down. `ipData` is each
IP list's version and when it was fetched, `null` for a source never fetched and `null` for
the whole field on an install with no IP data yet — `CLICKMONK_IPDATA_UPDATE=off`, or a
fresh one. `ipDataProblem` is set, with `ipData` then `null` too, only when the manifest is
there and could not be read; the response never says why, so check the admin service's own
log for the reason. `alerts` is the count `GET /api/alerts` would list, capped at 501, which
means more than 500.

**A report counts whole buckets; the log counts milliseconds.** Before a report is counted,
`from` is floored and `to` raised to the next boundary, and **the boundary is the grain that
report answers at**: the hour for the summary and the breakdown, because that is the grain
the rollups hold, and the bucket you asked for on the chart — so `bucket=day` counts whole
days, from where `offset` puts midnight. The log, the export and the count use the two
instants exactly as they were sent. So the same
window can answer differently through these surfaces and none of them is broken: ask
`from=2026-09-24T10:30:00Z&to=2026-09-24T10:50:00Z` and the summary, the hourly chart and the
breakdown all count 10:00 to 11:00, a chart by day counts the whole of the 24th, and the log
counts the twenty minutes you named — three different numbers from one request. Every JSON
answer among these repeats the window it actually counted, in its own `window` field, and the
export puts it in its file name. Read that before comparing two numbers.

**What the numbers mean.** `clicks` counts distinct clicks and `visitors` distinct visitor
cookies, and both are counted as sets rather than added up: a click the worker shipped twice
is one click, and a visitor who clicked two links is one visitor for the install and one for
each link. The per-link visitor numbers therefore do not add up to the install-wide one, on
purpose. And `visitors` counts only what a cookie can see. A client that keeps no cookie is
a new visitor on every click, so for bot traffic `visitors` comes out close to `clicks`, and
that is the truth rather than a fault. The cookie is also `Secure` and set for one host
name: over a plain-HTTP trial every click is a new visitor, and one person using two of your
link domains is two visitors.

**An empty value is a row, not a gap.** A breakdown by country, by referrer or by target has
a row whose `value` is `""`, and it means something different in each: an address that could
not be looked up, a visitor who arrived with no referrer, and a click that reached no target.
They are kept so that the rows add up to the number beside them. A breakdown returns 100
rows unless you ask for more, at most 500, ordered by clicks, and sets `"truncated": true`
when there were more.

**Reports lag the clicks**, and the mechanism is the whole of it: a click is countable once
the spool segment holding it has been sealed and the shipper's next pass has taken it, which
with the intervals as shipped is a small number of seconds. Nothing here reads the spool, so
until both of those have happened the click is in no report and in no export.
`newestHour`, on the summary and the chart, is the newest hour the rollups hold anywhere,
not the newest hour in the window you asked for, and it is what says whether a run of zeroes
at the end of a chart is "nobody clicked" or "not arrived yet".

**Two reports or log pages at a time, and one export.** Past that the answer is `429` with
`retry-after` rather than a queued query: a credential is not permission to scan the table
in a loop. The export's slot is its own, so a download does not lock a dashboard out.

### The export

`GET /api/clicks.csv` answers `content-disposition: attachment` with a filename built from
the window — `clicks-20260901T000000Z-20260924T000000Z.csv` — and a chunked body with no
`content-length`, because the rows are read from the store and written out as they arrive
rather than built in memory first. The filename drops milliseconds, so two windows a
millisecond apart produce the same name; what distinguishes them is the request, not the
file.

**One export writes at most 1,000,000 rows**, which is just under what a spreadsheet will
open. Every export carries `x-clickmonk-row-cap` with that number and
`x-clickmonk-truncated`, `true` or `false`, and both are sent before the first byte of the
body — which is why a probe query runs in front of the export rather than a trailer being
appended, since the clients an operator actually uses do not show trailers. Narrow the
window and ask again; nothing is lost. The cap can be built as high as 10,000,000, and
there is no environment variable for it yet.

**`GET /api/clicks/count`** answers the same question ahead of the download: it takes the
log's own filters and runs the same bounded probe, so `{"count":1234,"cap":1000000,
"truncated":false}` tells you how many rows the export would write and whether it would
stop at the cap, before you ask for the file. It is a query rather than a body, so it takes
a report slot and not the export's — asking it does not compete with a download already
running. The window can gain clicks between this answer and the export; the export's own
header stays the authority on the file it actually wrote.

**A cell that would otherwise look like a formula is prefixed with an apostrophe.** A
spreadsheet runs a cell beginning `=`, `+`, `-` or `@`, or with a tab, carriage return or newline,
whether the cell is quoted or not. The two columns a visitor's own browser chooses the
contents of — `referrer` and `userAgent` — are where that turns up, so those are the ones
that can come back with an apostrophe in front of them.

**The file identifies people, and the truncated network is the least of it.** Every row
carries `visitorId`, the 128-bit value from a cookie that lives a year and does not change
between sessions, so one visitor's rows reconstruct everything that person did through this
install's links on that domain. Every row also carries the whole `userAgent` and the whole
`referrer`, query string included, which is whatever the referring site chose to put there.
Decide who receives the file with that in mind: it is not an anonymous export with one
field redacted. `GET /api/clicks` hands over the same three fields, and the reports hand
over none of them.

**A slow reader holds the export's slot**, because the slot is given back when the last row
has been written rather than when the request was accepted. A second export started while
one is still being read is refused. **That hold ends after ten minutes**, whether the caller
has finished or not: a client that takes the headers and then stops reading would otherwise
hold the only slot for as long as it kept the socket open, and nothing else would end it.
The cost falls on an honest slow reader — a very large file over a slow link is cut off the
same way a store failure cuts one off, mid-body, which the client sees as a failed transfer.
Ask for a narrower window.

**A store failure after the first byte is a short file and nothing else.** The 200 and every
header have already gone, so there is no status left to change and nothing honest to append:
the download stops mid-file, inside a chunked body that never gets its last chunk, which is
a transfer error the client can see rather than a file that looks whole. The only record on
the server is one error line in the admin service's log, and **a download cannot be
retracted** — so check that a file you are about to pass on ends where you expect it to.

## Password-protected links

Set a password when you create a link, or later with `PATCH /api/links/:id`. It is at
least 6 characters, and the domain has to be one you have already added:

```sh
curl -X POST https://admin.example.com/api/links \
  -H 'authorization: Bearer <your key>' -H 'content-type: application/json' \
  -d '{"host":"links.example.com","slug":"private","targets":[{"url":"https://example.com/"}],"password":"spring2026"}'
```

A visitor gets a page on your own domain with one field. A correct password sets a signed
cookie for that link, good for twelve hours, and they are sent on; the cookie is `Secure`,
so this needs HTTPS — over a plain-HTTP trial the visitor is asked every time. Wrong
answers are counted per client per link and refused after five in a minute, a client here
being one IPv4 address or one IPv6 /64 for the reason above. Changing the password
invalidates every cookie issued under the old one.

The limit counts wrong answers only — a correct one clears the count — so it is not a bound
on how often somebody who knows the password can make the server hash it. What bounds that
is the two-checks-at-once gate, which answers 503 and a `Retry-After` rather than queueing.

The password is stored as a slow salted hash and is never in a response, a log or a click
record. What is recorded is that the page was shown: every prompt, wrong answer, refusal
and correct answer is a click event with the step that decided it. **A wrong answer and a
first visit are the same event in that log** — both are the password step with a 200 — which
is what stops the log from being a list of near misses to an attacker who reaches it, and
also means you cannot count how many visitors got the password wrong.

**What a link password is not.** It gates the redirect, not the destination. The URL a
visitor is sent to is whatever you set, and anyone who already has that URL reaches it
without answering anything. A visitor who has answered holds a proof cookie for that link
until it expires or you change the password, and nothing stops them passing the cookie, or
the password, to someone else. It also does not replace the other checks, and does not
stand in front of all of them: a link blocked by its traffic class answers 403, and one
that has expired goes to its backup URL or answers 410, both without the password being
asked for at all. The click cap and a country rule are the other way round — both are
decided after the password, so a protected link whose cap is used up still answers the
password page, and answering it correctly gets the visitor no further than the 410 or the
backup URL. That ordering is deliberate: the page a protected link shows says nothing
about the link's state, and posting a guess at one must not say anything either. Use it to
keep a link out of casual hands, not to protect something that matters if it gets out.

## How long ClickMonk keeps things

```sh
docker compose exec -T worker node packages/cli/dist/index.js settings show
docker compose exec -T worker node packages/cli/dist/index.js settings set \
  --keep-clicks 180 --keep-addresses 7
```

- **Raw clicks**: 90 days on a new install. `--keep-clicks never` keeps them for ever.
- **The address on a click**: 30 days, after which that one column is blanked and the click
  keeps everything else. `--keep-addresses never` keeps them for ever.
- **The hourly rollups**: for ever. They are small, and they are what answers a question
  about a window whose raw clicks are gone.

Clicks are stored a month at a time and dropped a month at a time, and a month goes only
once every click it could hold is past the period — so 90 days means 90 to 121 days of
clicks, and 30 days means 30 to 61 days of addresses: the period, plus the longest month.
That is the trade for dropping a month in one statement instead of rewriting the table
continuously. The worker checks once an hour, or as often as
`CLICKMONK_RETENTION_INTERVAL_MS` says. Lowering a period applies on the next check; raising
one brings nothing back.

**Nothing is deleted while this install cannot say what it asked for.** If the settings row
is missing, or the two periods on it cannot be read, the pass does nothing at all and says
why in the worker's log, `settings show` prints `keep clicks: unknown, so nothing is being
deleted`, and `GET /api/settings` answers `"retention": null` with a `problem`. That is
deliberate rather than a gap: applying the defaults there would delete clicks for an
operator who never chose a period, including one who had chosen to keep them for ever and
whose row was since deleted. `settings set` writes the row back, and says that it did — and
it is the only thing that does: `PUT /api/settings` will not take a body with
`"retention": null` in it, so the repair is the CLI's.

Setting the address period longer than the click period does nothing: the address goes when
the click does. `settings show` and `GET /api/settings` say so in a note rather than letting
you find out.

## IP data

The worker downloads four lists to your server, and `clickmonk ipdata update` fetches
them on demand. The redirect looks each visitor's address up in memory: no lookup
leaves your server, and no request waits for a download. With the editions of September
2026 the lists take about 25 MB of the redirect's memory, measured, and each has a fixed
ceiling. The admin service also mounts this
volume, read-only, and reads it for nothing but `GET /api/status` — to say how old each
list is.

The address looked up is the one Caddy passes on, which is the visitor's: Caddy is the
only service with a published port, nothing outside the stack can open a connection to the
redirect, and Caddy replaces an `X-Forwarded-For` a client sent for itself. That is why
the stack sets `CLICKMONK_TRUSTED_PROXIES` to `uniquelocal,loopback` in
`docker-compose.yml` — the private and loopback ranges Caddy sits in — rather than to one
address. (The redirect's own default, if you run it without this stack in front, is
`127.0.0.1`.)

Change it only if you publish the redirect's port yourself, in which case narrow it to the
proxy you actually run: comma-separated addresses, ranges such as `172.17.0.0/16`, or
`loopback`, `linklocal` and `uniquelocal`. For a proxy on the Docker host, that is the
gateway of the stack's Docker network, such as `172.17.0.1` or `172.18.0.1`
(`docker network inspect clickmonk_default` shows it), or that network's subnet — not
`127.0.0.1`: the proxy's own connection to the redirect does not come from loopback. A
range ending in `/0` is refused, since it would let every visitor name its own address,
and the redirect does not start with a value it cannot read. **If a CDN sits in front of
Caddy**, name its ranges in `caddy/proxy.d/` instead — see the comments in that file.
Left unnamed, visitors arriving through it are all recorded as the CDN: they share one
request count, so all of them are classed as abusers once it passes the threshold, and
the country looked up is the CDN's.

| Data | Source | Licence | Checked for updates |
| --- | --- | --- | --- |
| Country | [DB-IP](https://db-ip.com) IP to Country Lite | CC BY 4.0 | daily; DB-IP publishes monthly |
| Network (ASN) | [DB-IP](https://db-ip.com) IP to ASN Lite | CC BY 4.0 | daily; DB-IP publishes monthly |
| Hosting networks | [bad-asn-list](https://github.com/brianhama/bad-asn-list) | MIT, notice below | weekly |
| Tor exit relays | the Tor Project's [Onionoo](https://metrics.torproject.org/onionoo.html) service | CC0 1.0 | every 6 hours |

IP Geolocation by [DB-IP](https://db-ip.com), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). ClickMonk converts it to its
own lookup format. The same credit is in the web interface's own footer, on every signed-in
screen.

A download replaces the list in use only when it parses whole and holds at least a
minimum number of entries (a small fraction of a current edition, about 5 to 15%; for
country, half the IPv4 space); otherwise the previous one stays. `clickmonk ipdata status` shows each
list's version and when it was fetched, and `clickmonk ipdata update` fetches them now.

On a server without internet access, set `CLICKMONK_IPDATA_UPDATE=off`. The redirect then
runs without IP data: countries are unknown, so a link limited to a list of countries sends
every visitor to its backup URL, or answers 403 when it has none, and clicks that no other
check marks are classed unknown rather than human.

bad-asn-list's licence:

    MIT License

    Copyright (c) 2025 Brian Hamachek

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Security

What an install exposes, and what stands behind each part.

- **Two ports.** Caddy publishes 80 and 443 and no other container publishes anything:
  Postgres, ClickHouse, the redirect and the admin service are reachable only on the stack's
  own Docker network. A test reads `docker compose config` and fails if that changes.
- **Links are public by nature.** Anyone can request any path on a link domain, so everything
  a request can reach is bounded: the path's length, the header block's size, the number of
  clients the per-client request count remembers, the password attempts per client per link,
  and the spool's size on disk.
- **A certificate only for a name you verified**, or for the admin host you named. A host name
  someone else points at your server gets no certificate, and your install asks the
  certificate authority for nothing on its behalf.
- **The admin interface and API answer on one host name, over HTTPS**, and nowhere else;
  plain HTTP on that name is sent to HTTPS. Signing in takes the one account's password and,
  once you turn it on, a code from an authenticator app. After five wrong passwords the
  account refuses sign-ins for five minutes, and each further wrong one adds five more, up to
  an hour. A session ends after 12 hours unused, and after 30 days whatever happens. Every
  request that changes anything, the sign-in included, must carry an `Origin` naming the
  admin host unless it carries an API key, which is what a script uses. The interface runs under a content security
  policy that allows no inline script and no inline style.
- **Nothing that signs in is stored in a form that can be replayed.** Passwords — the
  account's and every link's — and recovery codes are scrypt hashes; session tokens and API
  keys are stored as SHA-256 digests. The exception is the two-factor secret, which the
  server must be able to read to check a code; it is one reason a backup is a credential.
- **Visitors' addresses** are shown as networks, never as addresses, and blanked in the
  database once the address retention period has passed, 30 days on a new install
  (["How long ClickMonk keeps things"](#how-long-clickmonk-keeps-things)).
- **What your server contacts:** the certificate authority, for the names you verified (Caddy's
  defaults, or the authority you name in `caddy/tls.d/`); the three hosts the four IP data
  lists under ["IP data"](#ip-data) come from (`CLICKMONK_IPDATA_UPDATE=off` stops them); DNS
  resolvers, to check each domain's verification record (`CLICKMONK_DNS_CHECK=off` stops the
  worker's scheduled checks, and `domain verify` and the admin API's check still ask when you
  run them); and Docker's registries when you pull or build. ClickMonk sends nothing else
  anywhere: no telemetry, no licence check, no update check. A redirect makes no network call
  except the click-cap count on a capped link, which goes to your own Postgres.
- **What is not a boundary:** anyone with a shell on the server has everything, `.env` and the
  databases included; and the containers on the stack's own network can reach each other, as
  the limits under ["Status"](#status) spell out.

To report a vulnerability, see [SECURITY.md](SECURITY.md) — not a public issue.

## Backup and restore

Two scripts sit beside `install.sh`. `backup.sh` is the one you schedule. `restore.sh` is
the one you run once, under pressure, and it is the only script here that deletes data.

### Taking a backup

```sh
./backup.sh /var/backups/clickmonk
```

Each run writes one new directory, named for the moment it started, in UTC:

```
/var/backups/clickmonk/2026-10-01T041500Z/
    clickhouse.zip   the clicks and the hourly rollups
    postgres.dump    domains, links, click-cap counters, settings, the admin account,
                     its sessions and API keys
    spool.tar        clicks the redirect has accepted and the worker has not shipped yet
    caddy-data.tar   certificates, their private keys, and the certificate authority account
    env              a copy of .env
    MANIFEST         versions, row counts, and a SHA-256 of each file
```

**Your links keep answering while it runs.** The one container it stops is the worker, while
it copies the spool and ClickHouse, and it starts the worker again on every path it can, a
failed step included. A Ctrl-C that arrives while the worker is still stopping does not leave
it stopped: the script lets the stop finish, then starts it again. It tries the start three
times, so a second Ctrl-C that cuts one attempt short does not by itself leave the worker
stopped; if all three fail it says so and prints the command to run,
`docker compose start worker` with any `COMPOSE_*` variables in effect in front of it.
Meanwhile the redirect keeps sending visitors on
and writing their clicks to the spool, and the worker ships them when it is back: the
reports pause, and nothing is lost. A worker that was already stopped when you ran the
script is left stopped.

**The pause and the disk space grow with your data.** ClickHouse writes its own archive
beside its data before the script copies it out, so a backup needs free space about the size
of ClickHouse's data twice: once on the disk Docker keeps its volumes on, and once at the
destination — both on the same disk if the destination is on this server. `backup.sh`
measures the first before it stops anything, and refuses when there is not room for it plus
a tenth. It does not measure the destination: a copy that runs out of room there fails, and
the half-written directory is deleted. For scale, measured on an 8-core AMD EPYC virtual
machine with 6 GB of memory and ClickHouse 24.8 holding 2.2 GiB of ClickMonk's clicks and
rollups: the archive was 1.77 GB, and ClickHouse took 49 seconds to write it, all of which
the worker was stopped for. Take your own figures from the first backup you run, and
schedule it when a pause of the reports matters least.

**What the backup is a picture of.** The worker is the only thing that moves clicks from
the spool into ClickHouse, so with it stopped the two are copied at one instant: every click
the redirect had written before that instant is in the backup — in ClickHouse, in the spool,
or in both. Both is normal, and it is not counted twice. The worker deletes a batch of clicks
from the spool only after ClickHouse has accepted it, so a batch caught in between is in both
places, and after a restore it is shipped again; every count ClickMonk makes is of distinct
clicks, so the second copy adds nothing. Postgres is dumped after that, as one consistent
snapshot of its own: a link created in between is in the backup, and a click on it after the
spool was copied is not.

**One backup or restore at a time.** The two scripts share a lock, the directory
`.backup-restore-<project>.lock` in the checkout, where `<project>` is the install's Compose
project name (`clickmonk` unless you set `COMPOSE_PROJECT_NAME`), and a run that finds it
taken is refused. Two installs run from one checkout under different project names have a
lock each and do not block each other. A run that
is killed outright leaves the lock behind, and every run after it is refused, with the
command that removes it, until you remove it. Nothing removes a lock for being old: two runs
that both judged it stale would both go ahead.

**It refuses, before it stops anything,** while ClickHouse is still running a backup or a
restore that a killed run started (the server finishes one even when its client is gone),
and while a restore has not finished — see "If a restore is interrupted" below. A backup of
half-restored stores would be complete, checksummed, and a picture of a moment that never
existed.

A nightly entry for cron:

```
17 4 * * *  { /srv/clickmonk/backup.sh /var/backups/clickmonk || docker compose --project-directory /srv/clickmonk ps --all; } >>/var/log/clickmonk-backup.log 2>&1
```

The script changes into its own directory, so cron does not need to. The `|| … ps --all` is
not decoration: the script starts the worker again on every exit it can see, but a `SIGKILL`
— an out-of-memory kill, `docker kill`, a hard `systemctl stop` — runs nothing, and can
leave the worker stopped and the lock in place. The `ps --all` puts the first in your log,
as an exited worker, and the next night's refusal says the second. If you pipe the script
anywhere, test `${PIPESTATUS[0]}`, not `$?`.

**Encryption, rotation and copies off the server are yours to choose.** `find -mtime` for
old directories, `age` to encrypt one, `restic` or `rclone` to send it somewhere else all do
it better than a script here would, and `backup.sh` does none of them.

### The backup is a credential

A backup holds everything needed to be this install:

- `env` has the database passwords and `CLICKMONK_SECRET`, which signs visitor cookies and
  the proof a visitor holds after answering a link's password. With it and `postgres.dump`,
  which is beside it, anyone can make that proof for any password-protected link.
- `postgres.dump` has the admin password's hash, **the two-factor secret itself** — a server
  has to be able to read it to check a code — the hashes of the recovery codes, and the
  digests of every API key and session.
- `caddy-data.tar` has every certificate's private key, and the key of the account Caddy
  uses with the certificate authority.

`backup.sh` creates the directory readable by you alone (`0700`) and every file in it
`0600`, from the moment each exists. Treat the directory as you would the server itself, and
encrypt it before it leaves the server.

### Restoring

```sh
./restore.sh /var/backups/clickmonk/2026-10-01T041500Z
```

You are asked to type the backup's timestamp. There is no `--force`, and no answer within
two minutes is a refusal.

**Before anything is stopped or changed** it checks every file against its checksum, the
backup against the image this checkout builds, and that ClickHouse's disk has room for it;
then it asks. A refusal at any of those, or any answer but the timestamp, leaves the running
install as it was, not even stopped.

Then it stops Caddy, the redirect, the admin service and the worker — **your links answer
nothing until it finishes**, which is seconds on a small install and longer on a large one
— replaces ClickHouse, Postgres, the spool and Caddy's certificates with the backup's,
checks the restored schema version and row counts against the manifest, and starts
everything. **Everything recorded since the backup is gone**: clicks, links, domains,
settings.

**It restores more than data.** The admin account comes back as it was when the backup was
taken: its password, its two-factor setting, the sessions signed in then, and its API keys.
A key you revoked since, or a password you changed since, is back as it was. When a restore
finishes, check the keys and change the password if either has moved on. The script prints
this command with any `COMPOSE_*` variables in effect:

```sh
docker compose exec -T worker node packages/cli/dist/index.js apikey list
```

Click caps count from where the backup left them, and a restored backup older than your
retention periods loses what is past them as soon as the restore starts the worker, whose
first retention pass runs at once. To keep older clicks, lengthen the retention periods
before you restore.

**Into a newer release.** A backup from an older release restores into a newer one: the
worker applies the migrations the backup is missing when the restore starts it. A backup
from a newer release than your checkout is refused before anything is touched — check out
that release or a later one, and restore again.

**On a new server.** Clone the repository and check out the release the backup came from or
a later one. Copy the backup's `env` to `.env` **before** the first start, so that visitors
keep their cookies and nobody has to answer a link's password again. Then:

```sh
./install.sh
./restore.sh /path/to/the/backup/2026-10-01T041500Z
```

`install.sh` keeps a `.env` that is already there. `restore.sh` never writes `.env` itself —
the database passwords in it have to match the volumes already on this server — and if its
`CLICKMONK_SECRET` or `CLICKMONK_ADMIN_HOST` differs from the backup's it says so before it
asks you to confirm.

**Certificates come back too**, so the same names present the same certificates without the
certificate authority being asked again. One that has expired since the backup is renewed
the first time someone asks for it, as any expired certificate is.

**If a restore is interrupted part way,** it leaves Caddy, the redirect, the admin service
and the worker stopped and says which stores are in which state. It does not start them,
because a redirect running on a half-restored database serves whatever happens to be there
and looks healthy doing it. If it is interrupted while a step is still writing — ClickHouse's
restore, Postgres's, or the spool or Caddy's data — it waits for that step to finish before
it exits, and then says what state it left. Run it again with the same backup; it starts
from the beginning, and the command it prints for that carries any `COMPOSE_*` variables
in effect. A restore killed outright waits for nothing: ClickHouse finishes a restore it has
started even with the script gone, and running the script again is refused, changing
nothing, until it has. Until a restore has finished, `backup.sh` refuses to run; the file
`.restore-incomplete-<project>` in the checkout is what tells it.

**If the restored stores do not match the manifest** — a schema version or a row count that
differs from what the backup recorded — it lists the differences and leaves the same four
services stopped and `.restore-incomplete-<project>` in place. Restore a different backup,
or start on what was restored with `docker compose up -d`, which the script prints with any
`COMPOSE_*` variables in effect, and then delete `.restore-incomplete-<project>` yourself.

**A restore needs room too.** It copies the ClickHouse archive into ClickHouse's volume and
restores the database beside it there, so before anything is stopped it refuses unless that
disk has about two and a half times the archive's size free, counting the space the current
ClickHouse database gives up when it is replaced.

**Not in a backup:** the IP data, which a restore leaves where it is, and which the worker
downloads as soon as it starts on a server that has none (until then countries are unknown,
as on a new install); the redirect's own copy of its configuration, which a restore deletes
and the redirect rebuilds from Postgres; and Caddy's autosaved configuration.

## Upgrading

**Take a backup first.** Migrations run when the worker starts, and a database a newer
release has migrated is refused by an older one:

```sh
./backup.sh /var/backups/clickmonk
```

Then move the checkout to the release, build it, and start the worker before anything else:

```sh
git fetch --tags
git checkout vX.Y.Z
docker compose pull caddy postgres clickhouse
docker compose build
docker compose up -d worker
docker compose exec -T worker node packages/cli/dist/index.js migrate
docker compose up -d --wait
```

`migrate` is the wait: it takes the lock the worker's own migration holds, so it returns once
the migrations are done, and prints `up to date` or the versions it applied. `up -d worker`
also recreates Postgres or ClickHouse if the pull brought a newer image for either; links
keep answering meanwhile. The last line recreates the redirect and the admin service from
the new image, and any other container whose image or compose definition changed, which is a few
seconds in which links do not answer, as with any rebuild. A change to a file a container
mounts, such as the Caddyfile, is not one of those: the release notes say when to run
`docker compose restart caddy`. Read the release's notes before
you start: a release that needs anything more of you says so there, and under its own
heading below.

**Why the worker goes first.** Each release's redirect writes clicks in the record version it
knows, and a worker older than the redirect does not read a newer one: it leaves those spool
segments where they are, counting toward the spool's size bound, until a worker that reads
them is running. Nothing is lost if the order slips — the clicks wait — but the reports stop
moving until the worker catches up. Support for reading a record version always ships no
later than writing it, so the worker-first order is always enough.

**There is no published image.** A release is a tag, and the image is built from the checkout,
as `install.sh` builds it. If you have changed files in your checkout that the release also
changes, `git checkout` refuses and names them; commit or stash the change first.

**If the new version will not start,** read `docker compose logs worker`. `Database schema
version N is newer than this build understands (M)` means the checkout went backwards, to a
release older than the database. Check out the release you were on, or a later one — or
restore the backup you took before upgrading. It is refused on purpose: an older build would
write what the newer schema no longer expects.

**Nothing updates itself.** No part of ClickMonk checks for a release or installs one. To hear
about one, watch this repository's releases on GitHub (Watch, then Custom, then Releases).
Security fixes ship in the next release, and only the latest release is supported: see
[SECURITY.md](SECURITY.md).

### Upgrading a checkout from before 0.1.0

0.1.0 is the first release. Before it, this repository could be cloned and run from `main`.
Such a checkout has no `backup.sh`, so its backup is taken from 0.1.0's scripts against the
volumes you already have, before anything is built. Which commands depends on whether the
checkout already serves HTTPS.

**If it serves HTTPS:**

```sh
git fetch --tags
git checkout v0.1.0
docker compose up -d clickhouse
./backup.sh /var/backups/clickmonk
```

The third line recreates ClickHouse alone, with the disk 0.1.0's backups are written to; the
clicks in it are untouched, links keep answering, and the worker waits for it.

**If it is from before TLS** (nothing of yours listens on 443; see "If nothing of yours
listens on 443" below), that third line fails, because Compose cannot change the stack's
network in place while the other containers are on it. On Compose 5.1.4 it stops ClickHouse,
leaves it stopped and says the network `has active endpoints`. Take the backup with the stack
down instead, which means your links answer nothing from here until the upgrade's last step:

```sh
git fetch --tags
git checkout v0.1.0
docker compose down
docker compose up -d postgres clickhouse
./backup.sh /var/backups/clickmonk
```

`down` without `-v` removes the containers and the network and keeps every volume.

Either way the backup records the release it came from as `unknown`, because the image you
are running predates `clickmonk version`, or is not running at all; its schema version is
exact, and that is what a restore checks. A checkout from before the hourly rollups has none
to back up: the backup counts the clicks alone, and the worker creates the rollups when it
applies the migrations. They start empty, so reports read zeroes for the time before, as
"What does not work yet" says. Then continue from `docker compose pull` in the steps above.
Two older changes need more of you, depending on how old the checkout is.

**If `docker compose ps` shows no `admin` service,** the upgrade adds it, and it is off until
you name a host for it: `CLICKMONK_ADMIN_HOST` is optional and empty by default, so the `.env`
you have needs no edit and every name keeps going to the redirect. Naming a host is what turns
it on, and the first HTTPS request for that name makes Caddy ask a certificate authority for a
certificate in it. ["The admin API"](#the-admin-api) is how to set it up.

**If nothing of yours listens on 443** — the redirect answered on `127.0.0.1:8080` — four
things change, and two of them destroy something.

**Ports 80 and 443 on the host have to be free, and the redirect publishes nothing.**
Caddy binds both, so the stack does not start while something else holds either one —
and nothing answers on `127.0.0.1:8080` any more, so whatever you had in front of the
redirect (your own nginx, a tunnel, an uptime check) stops working either way. If that
was a proxy on port 80, it has to give the port up: retire it and let Caddy answer
directly, or leave it in place only if it can hand 80 and 443 through to Caddy
untouched. Certificates are obtained on those two ports, so a proxy that terminates TLS
itself breaks issuance rather than passing it on — that case needs a certificate you
already hold, which `caddy/tls.d/00-defaults.caddy` explains.

**Remove `CLICKMONK_TRUSTED_PROXIES` from `.env`.**
An earlier checkout's README told you to set it to the Docker network's gateway or subnet. A
value in `.env` overrides the `uniquelocal,loopback` the stack now sets. The old value
named the proxy you ran then — a gateway address, usually — and Caddy's container is not
that, so unless what you set covers the whole of the stack's own network the redirect
stops believing the address Caddy forwards. Every visitor is then recorded as Caddy's
container address: they share one request count, so all of them are classed as abusers
once it passes the threshold, and one country is looked up for the lot. A proxy of your
own in front of Caddy is not this variable's business any more: name its ranges in
`caddy/proxy.d/` instead. The one case left for a value here is publishing the
redirect's port yourself, which the "IP data" section above describes.

**Domains you added before TLS stay verified.** The migration deliberately
leaves the `verified` column alone — clearing it would 404 every live link on your
install until each domain published a TXT record. But verified is also what makes a
domain eligible for a certificate, so each of those domains gets one on its first HTTPS
request without ever having proved anything in DNS. `clickmonk domain list` shows them
as verified with no check recorded.

**The stack's own Docker network now has IPv6 on it**, with the unique-local subnet
`CLICKMONK_IPV6_SUBNET` names, so that IPv6 visitors arrive as themselves. Your existing
network does not have it, and Compose cannot change a network in place, which is why the
backup above is taken with the stack down: `docker compose down` removes `clickmonk_default`
and the next `docker compose up` creates it again, so the addresses on that network can come
back different. Two things can go wrong. If the range collides with a network this host
already has, set `CLICKMONK_IPV6_SUBNET` in `.env` to one that does not. If your Docker
daemon has no IPv6 support turned on, creating the network fails outright and nothing
starts: turn it on in the daemon — your distribution's Docker documentation covers it,
and it is the same setting the "Domains and TLS" section above asks for — or, if you
cannot, delete the `networks:` block at the end of `docker-compose.yml` and accept that
every IPv6 visitor is recorded as your Docker bridge's address rather than their own.

## License

Fair-code, under the [Sustainable Use License](LICENSE.md): free to use, self-host and
modify for your own business or for non-commercial use. It is source-available, not
open source, because it does not allow reselling ClickMonk as a hosted service.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending code, and [SECURITY.md](SECURITY.md)
to report a vulnerability.
