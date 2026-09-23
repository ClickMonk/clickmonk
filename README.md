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
  verified, so a host name somebody else points at your server never makes your install
  ask a certificate authority for anything.
- **Domain verification.** `clickmonk domain add` prints a TXT record to publish. The
  worker looks for it every five minutes, and `clickmonk domain verify` looks now. Until
  it is found, links on that domain answer 404 and it gets no certificate. A check that
  fails later is recorded and shown, and never takes a verified domain back down.
- **`./install.sh`**, which writes `.env` with fresh secrets the first time, builds the
  image and starts the stack. Running it again changes nothing that is already set.
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
  `clickmonk settings show|set` for the traffic actions, the safe URL and the abuser
  threshold, and `clickmonk ipdata status|update`.
- **A Docker Compose stack** that runs all of it, and a test that restarts each service
  under continuous traffic and requires every redirect the client received to arrive in
  ClickHouse as a click.

What does not work yet:

- **An admin hostname.** Caddy serves link domains. There is nothing to serve on the
  hostname you would run the admin interface on, because there is no admin interface.
- **An admin API or UI.** Domains and links are added with the CLI.
- **Most link settings.** `clickmonk link add` sets targets, a backup URL, a click cap,
  an expiry, passthrough and traffic action overrides only, and there is no command to
  change a link once it is added. The redirect supports per-device destinations, a
  returning-visitor destination, country rules, a link name and disabling a link, but
  the CLI cannot set any of them yet, so they need SQL written by hand.
  Returning-visitor routing also needs HTTPS to do anything: its cookie is marked
  `Secure`, so a browser drops it over plain HTTP.
- **Reports.** Clicks are stored in ClickHouse, but there are no reports or exports.
- **Proxy and VPN detection beyond Tor.** The anonymous class covers Tor exit relays
  only. The well-known lists of VPN and proxy ranges publish no licence, so they are not
  used.
- **Cloud providers' published address ranges.** Datacenter traffic is recognised by its
  network (ASN) only. The providers' range files state no licence, so they are not used.
- **Region and city.** A click records its country only.
- **Password-protected links, and backup and restore.**
- **Rejected clicks are not reported.** A batch of clicks ClickHouse refuses is set aside
  as a `.bad` file in the spool, and nothing tells you it is there.
- **More than one redirect process per spool directory.**
- **A full spool stops recording without stopping redirects.** Above its size bound the
  redirect keeps sending visitors on but drops the click; the running count of drops is
  in `/health` on the internal port, and nowhere else yet.
- **The redirect is reachable from the whole compose network.** Neither of its ports is
  published on the host, but any other container on the stack's own Docker network can
  reach both, not only Caddy. On `redirect:9091` that means reading the `ask` check,
  which lists this install's verified domains. On `redirect:8080` it means more: the
  stack trusts a forwarded address from that network (`CLICKMONK_TRUSTED_PROXIES` is
  `uniquelocal,loopback`), so a container inside the install can set `X-Forwarded-For`
  and choose the address recorded, counted and looked up for every click it sends. Every
  container on that network is one you put there, which is what keeps this a limit
  rather than a way in.
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
`domain add` run right after it fails with a Postgres error naming a missing relation
(`domains` does not exist yet), that is why: wait a few seconds and try again.

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
down yourself — there is no command for it yet, so that means deleting its row or
setting `verified` back to false in Postgres — the certificate it already has stays in
the `caddy-data` volume and Caddy keeps presenting it until it expires. What stops is
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

Four things change for an install that was running before TLS was added.

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

Upgrade the worker before the redirect. Each release's redirect writes clicks in the
record version it knows, and a worker older than the redirect does not read a newer
version: it leaves those spool segments where they are, and they count toward the
spool's size bound until a worker that reads them is running. The Compose stack builds
both from one image, so `docker compose up -d --build` upgrades them together.

## License

Fair-code, under the [Sustainable Use License](LICENSE.md): free to use, self-host and
modify for your own business or for non-commercial use. It is source-available, not
open source, because it does not allow reselling ClickMonk as a hosted service.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending code, and [SECURITY.md](SECURITY.md)
to report a vulnerability.
