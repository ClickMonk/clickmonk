<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup-light.svg" alt="ClickMonk" width="220">
  </picture>
</h1>

Self-hosted link tracking and reporting for affiliate and digital marketers. You run it
on your own infrastructure, and your click data stays yours.

## Status

**Early, and not ready for production.** There is no release yet. What runs today:

- **The redirect**, which answers links on your domains from an in-memory copy of the
  configuration: weighted rotation across destinations, click caps, expiry, backup URLs
  and query passthrough. It writes every click to a spool on
  local disk before it answers, and keeps redirecting while Postgres or ClickHouse is
  down.
- **The worker**, which ships spooled clicks into ClickHouse, runs the database
  migrations when it starts, and keeps the IP data up to date.
- **TLS on every link domain.** Caddy sits in front and obtains a certificate the first
  time someone asks for a domain over HTTPS, then renews it without anyone touching a
  file. It asks ClickMonk first, and ClickMonk says yes only for a domain you added and
  verified, and for the admin host name if you set one, so a host name somebody else
  points at your server never makes your install ask a certificate authority for anything.
- **Domain verification.** `clickmonk domain add` prints a TXT record to publish. The
  worker looks for it every five minutes, and `clickmonk domain verify` looks now. Until
  it is found, links on that domain answer 404 and it gets no certificate. A check that
  fails later is recorded and shown, and never takes a verified domain back down.
- **`./install.sh`**, which writes `.env` with fresh secrets the first time, builds the
  image and starts the stack. Running it again changes nothing that is already set.
- **An admin API.** One admin account, created on the server with `clickmonk admin
  create`, a session cookie for a browser and API keys for a script, two-factor
  authentication with recovery codes, and endpoints for domains, links and the
  install-wide settings. It answers on one host name of its own — set
  `CLICKMONK_ADMIN_HOST` — and Caddy gets it a certificate the first time you visit it.
- **Password-protected links.** Set a password on a link and visitors are asked for it on
  a ClickMonk page on your own domain before they are sent on. Attempts are counted per
  address per link, and the proof a visitor holds stops working the moment you change the
  password.
- **Traffic classification.** Every click is classed as human, bot, abuser, anonymous
  (a Tor exit), datacenter, or unknown when the IP checks could not run, from its
  user-agent, the number of requests from its address in the current one-minute window,
  and IP data held on your server. Each class other than human has an action: flag (the
  default), nothing, block, or send to a safe URL. A flagged click never uses up a click
  cap, but a cap that is used up closes the link to it like any other. A HEAD request,
  which link checkers and preview bots send, gets the same answer as a GET, is recorded
  as a bot unless another check gives it a class, and never uses up a click cap. Each
  click also records its country, network (ASN), operating system and browser.
- **Country rules** use the country looked up from the visitor's address.
- **The CLI**: `clickmonk migrate`, `clickmonk domain add|list|verify`, `clickmonk link add`,
  `clickmonk settings show|set`, `clickmonk ipdata status|update`, `clickmonk admin create`,
  `clickmonk admin passwd`, `clickmonk admin totp disable`, `clickmonk apikey create|list|revoke`.
  `settings set` covers the traffic actions, the safe URL and the abuser threshold.
  `admin create` and `admin passwd` read the password from standard input and from nowhere
  else; `admin totp disable` reads none, and is the way back in when both factors are lost.
- **A Docker Compose stack** that runs all of it, and a test that restarts each service
  under continuous traffic and requires every redirect the client received to arrive in
  ClickHouse as a click.

What does not work yet:

- **A web interface.** There is an admin API but no pages to drive it: a browser can sign
  in, and there is nothing to click. Driving it means `curl` or the CLI for now. Enrolling
  an authenticator app hands you the secret and an `otpauth:` URI to paste into it, because
  nothing here draws a QR code.
- **More than one admin account.** There is exactly one, and it is the whole of the access
  control: no second person, no roles, no record of which of you did something, and no way
  to let someone in and then out again except by changing the one password, which signs
  every browser out. An API key is the only credential you can hand over and revoke on its
  own, and a key is not a person — it cannot sign in, and nothing it does is attributed to
  anyone. The admin API also cannot be tried without a real domain name: see that section.
- **Reports and the click log over the API.** The API covers domains, links and settings.
  Clicks reach ClickHouse and nothing reads them back out yet.
- **Any notification.** Nothing is emailed, posted or pushed anywhere: there is no mail
  configuration and no secret for one. `GET /api/alerts` lists every domain whose last DNS
  check did not find its token, and every domain no check has reached, which is what an
  operator has instead.
- **Most link settings in the CLI.** `clickmonk link add` sets targets, a backup URL, a
  click cap, an expiry, passthrough and traffic action overrides only, and no command
  changes a link once it is added. Per-device destinations, a returning-visitor
  destination, country rules, a link name, a password and disabling a link are set
  through the admin API, or by hand in SQL without it.
  Returning-visitor routing also needs HTTPS to do anything: its cookie is marked
  `Secure`, so a browser drops it over plain HTTP.
- **Proxy and VPN detection beyond Tor.** The anonymous class covers Tor exit relays
  only. The well-known lists of VPN and proxy ranges publish no licence, so they are not
  used.
- **Cloud providers' published address ranges.** Datacenter traffic is recognised by its
  network (ASN) only. The providers' range files state no licence, so they are not used.
- **Region and city.** A click records its country only.
- **Backup and restore.**
- **Rejected clicks are not reported.** A batch of clicks ClickHouse refuses is set aside
  as a `.bad` file in the spool, and nothing tells you it is there.
- **More than one redirect process per spool directory.**
- **A full spool stops recording without stopping redirects.** Above its size bound the
  redirect keeps sending visitors on but drops the click; the running count of drops is
  in `/health` on the internal port, and nowhere else yet.
- **The redirect and the admin API are reachable from the whole compose network.** None of
  their ports is published on the host, but any other container on the stack's own Docker
  network can reach all of them, not only Caddy. On `redirect:9091` that means reading the
  `ask` check, which lists this install's verified domains. On `redirect:8080` it means
  more: the stack trusts a forwarded address from that network
  (`CLICKMONK_TRUSTED_PROXIES` is `uniquelocal,loopback`), so a container inside the
  install can set `X-Forwarded-For` and choose the address recorded, counted and looked up
  for every click it sends. On `admin:9100` a request still has to carry the admin host
  name in `Host` — a forwarded header will not do, and every route but `/health` is
  refused without it — and then it still needs a credential. Every container on that
  network is one you put there, which is what keeps this a limit rather than a way in.
- **IPv6 coverage depends on the host the tests run on.** The published-port IPv6 test
  is skipped when that host has no IPv6 address of its own — most CI runners — and is
  meant to be run by hand, on a host that has one, before a release. A second,
  always-run test proves the address Caddy passes on is the IPv6 client's own, but only
  on the stack's unique-local subnet.

If link tracking is a problem you have today, [open an issue](../../issues) describing
it. That is the most useful contribution at this stage.

## Installing

You need a Linux host with Docker and Docker Compose v2, and ports 80 and 443 free.

```sh
git clone https://github.com/ClickMonk/clickmonk.git
cd clickmonk
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

It prints the TXT record to publish, at `_clickmonk.links.example.com`, and reminds you
to point `links.example.com` at this server yourself — an A or AAAA record, or a CNAME,
whichever your DNS provider gives you. Publish both, then wait: the worker checks every
five minutes, `domain verify links.example.com` checks at once, and `domain list` shows
where each domain stands.

**Until the TXT record is found the domain serves nothing.** Over plain HTTP, links on it
answer 404. Over HTTPS there is no certificate to present, so the connection never gets
that far: the TLS handshake itself fails, an SSL error with no page behind it. That is
what stops somebody else's hostname, pointed at your server, from getting a certificate
out of your install. `domain add --verified` is the way round it, for a trial or for a
domain you proved some other way; it says on screen that no DNS check was made.

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

Certificates live in the `caddy-data` volume. Back it up with the rest.

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
standing lock to a signed-in browser, before the lock bites. Separately, each address gets
ten failed sign-ins per fifteen minutes, counted in the process rather than in the
database. Two commands on the server are the way back, and both work while the account is
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
properly, with `limit` and `cursor`.

The install-wide traffic settings are `GET /api/settings` and `PUT /api/settings` — the
same three things `clickmonk settings set` covers. The `PUT` takes the whole object rather
than the fields you want to change, because the safe action and the safe URL depend on each
other and a half-written pair is how a link ends up sent to nowhere.

For a script, mint an API key and send it as `Authorization: Bearer …`:

```sh
docker compose exec -T worker node packages/cli/dist/index.js apikey create reporting
```

A key can read and write domains, links and settings, and nothing else. Every route that
touches a credential wants a session instead: listing or ending sessions, changing the
password, anything to do with two-factor authentication, and minting or revoking a key. So
a key that leaks cannot lock you out of your own install, and cannot make itself a second
key.

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
answers are counted per address per link and refused after five in a minute. Changing the
password invalidates every cookie issued under the old one.

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
stand in front of them: a link blocked by its traffic class answers 403, and one that has
expired or used up its click cap goes to its backup URL or answers 410, all without the
password being asked for at all. A country rule is applied after it, so answering the
password does not get a visitor past one. Use it to keep a link out of casual
hands, not to protect something that matters if it gets out.

## IP data

The worker downloads four lists to your server, and `clickmonk ipdata update` fetches
them on demand. The redirect looks each visitor's address up in memory: no lookup
leaves your server, and no request waits for a download. The lists take about 25 MB of
the redirect's memory, and each has a fixed ceiling.

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
own lookup format.

A download replaces the list in use only when it parses whole and holds at least a
minimum number of entries (about a fifth of a current edition; for country, half the
IPv4 space); otherwise the previous one stays. `clickmonk ipdata status` shows each
list's version and when it was fetched, and `clickmonk ipdata update` fetches them now.

On a server without internet access, set `CLICKMONK_IPDATA_UPDATE=off`. The redirect then
runs without IP data: countries are unknown, so a link limited to a list of countries
sends every visitor to its backup URL, and clicks that no other check marks are classed
unknown rather than human.

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

## Upgrading

Each release that needs anything of you has its own heading here. Read the one you are
coming from, and every one after it.

### Upgrading to the admin API

**`docker compose up -d --build` adds one container and restarts most of the others.** The
new `admin` service starts beside them. The redirect and the worker are rebuilt from the
same image, so they are recreated too, and Caddy is recreated because it reads the new
setting — which makes this a brief outage for your links, as any rebuild is. Postgres and
ClickHouse are left alone. Caddy still binds 80 and 443 and is still the only service with
a published port.

**There is nothing to run by hand:** the worker applies the schema change when it starts,
as it does for every release, and `up -d --wait` waits for the new container, which becomes
healthy whether or not you have configured it. Clicks are written at record version 3 from
here on, which "Every release: upgrade the worker before the redirect" below covers.

**The admin API is off until you name a host for it, and your existing `.env` names
none.** `CLICKMONK_ADMIN_HOST` is optional and defaults to empty, so an `.env` written by
an earlier `install.sh` needs no edit, Compose warns about nothing, and the upgraded
install behaves exactly as it did: every name goes to the redirect, and the admin
container answers 503 to everything but its own healthcheck. Naming a host is what turns
it on, and that has one consequence to decide before you do it rather than after: the
first HTTPS request for that name makes Caddy ask a certificate authority for a
certificate in it. ["The admin API"](#the-admin-api) above is how to set it up, and
[Password-protected links](#password-protected-links) is the other half of what this
release adds.

### Upgrading from before TLS

Four things change, and two of them destroy something. **Nothing in this heading applies to
an install that was already serving HTTPS.**

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
The previous release told you to set it to the Docker network's gateway or subnet. A
value in `.env` overrides the `uniquelocal,loopback` the stack now sets. The old value
named the proxy you ran then — a gateway address, usually — and Caddy's container is not
that, so unless what you set covers the whole of the stack's own network the redirect
stops believing the address Caddy forwards. Every visitor is then recorded as Caddy's
container address: they share one request count, so all of them are classed as abusers
once it passes the threshold, and one country is looked up for the lot. A proxy of your
own in front of Caddy is not this variable's business any more: name its ranges in
`caddy/proxy.d/` instead. The one case left for a value here is publishing the
redirect's port yourself, which the "IP data" section above describes.

**Domains you added before this release stay verified.** The migration deliberately
leaves the `verified` column alone — clearing it would 404 every live link on your
install until each domain published a TXT record. But verified is also what makes a
domain eligible for a certificate, so each of those domains gets one on its first HTTPS
request without ever having proved anything in DNS. `clickmonk domain list` shows them
as verified with no check recorded.

**The stack's own Docker network now has IPv6 on it**, with the unique-local subnet
`CLICKMONK_IPV6_SUBNET` names, so that IPv6 visitors arrive as themselves. Your existing
network does not have it, and Compose cannot change a network in place: `docker compose
up -d --build` stops the containers, removes `clickmonk_default`, creates it again and
starts them, so that step is a short outage and the addresses on that network can come
back different. Two things can go wrong. If the range collides with a network this host
already has, set `CLICKMONK_IPV6_SUBNET` in `.env` to one that does not. If your Docker
daemon has no IPv6 support turned on, creating the network fails outright and nothing
starts: turn it on in the daemon — your distribution's Docker documentation covers it,
and it is the same setting the "Domains and TLS" section above asks for — or, if you
cannot, delete the `networks:` block at the end of `docker-compose.yml` and accept that
every IPv6 visitor is recorded as your Docker bridge's address rather than their own.

### Every release: upgrade the worker before the redirect

Each release's redirect writes clicks in the record version it knows, and a worker older
than the redirect does not read a newer version: it leaves those spool segments where they
are, and they count toward the spool's size bound until a worker that reads them is
running. The Compose stack builds both from one image, so `docker compose up -d --build`
upgrades them together and this takes care of itself.

## License

Fair-code, under the [Sustainable Use License](LICENSE.md): free to use, self-host and
modify for your own business or for non-commercial use. It is source-available, not
open source, because it does not allow reselling ClickMonk as a hosted service.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending code, and [SECURITY.md](SECURITY.md)
to report a vulnerability.
