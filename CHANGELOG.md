# Changelog

ClickMonk is versioned as one product: every package in the repository carries the same
version, and a release tags the whole repository. `clickmonk version` prints the version an
image was built from.

**Releases are git tags, and there is no published image.** An install builds its image from
the checkout, as `install.sh` does; upgrading is checking out the next tag and building it —
see "Upgrading" in the README.

## 0.1.0 — 2026-09-26

The first release. Everything below is new in it; the list of what it does not do is part of
the release, not a footnote to it.

### Added

- **The redirect.** Links on your own domains, answered from an in-memory copy of the
  configuration: weighted rotation across targets, click caps, expiry, backup URLs, query
  passthrough, destination tokens, per-device and returning-visitor destinations, and country
  rules. Every click is written to a spool on local disk before the visitor is answered, and
  links keep answering while Postgres, ClickHouse or the worker is down.
- **Traffic classification.** Every click is classed as human, bot, abuser, anonymous (a Tor
  exit), datacenter or unknown, from its user-agent, the client's request rate and IP data
  held on your server, with an action per class: flag, nothing, block, or send to a safe URL.
- **IP data**: country and network from DB-IP's Lite databases (CC BY 4.0), hosting networks
  from bad-asn-list, Tor exits from the Tor Project, downloaded and updated by the worker.
- **Domain verification** by a TXT record, which the worker looks for every five minutes and
  `clickmonk domain verify` looks for at once. Links on a domain answer 404 until it verifies.
- **TLS for every link domain**, obtained by Caddy on the first HTTPS request and renewed
  without anyone touching a file, for the domains you have verified and for the admin host you
  name — and for nothing else.
- **Password-protected links**, with attempts counted per client per link.
- **The admin API**: one account, a session for a browser and API keys for scripts, two-factor
  authentication with recovery codes, and endpoints for domains, links and the install-wide
  settings.
- **Reports**: a summary, a chart by hour or by day, and a breakdown by country, device,
  operating system, browser, referring host, target, traffic class, action, outcome or link,
  read from hourly rollups; the click log, newest first, and a streamed CSV of it with a
  stated row cap.
- **The web interface**, on the admin host: an overview, links and their reports, the click
  log with its export, domains, settings and the account. Every screen is built on the admin
  API. It serves Adobe's own static WOFF2 builds of Source Sans 3, Source Serif 4 and Source
  Code Pro, unmodified, under the SIL Open Font License, so a browser using it asks no third
  party for a font.
- **Retention**: raw clicks kept 90 days and the address on them 30 by default, each a floor
  rather than a deadline, checked hourly by the worker; the rollups are kept for ever.
- **The CLI**: `migrate`, `domain add|list|verify`, `link add`, `settings show|set`,
  `ipdata status|update`, `admin create|passwd`, `admin totp disable`,
  `apikey create|list|revoke` and `version`.
- **`install.sh`**, which writes `.env` with fresh secrets once, builds the image and starts
  the stack.
- **`backup.sh` and `restore.sh`.** A backup copies ClickHouse, Postgres, the spool, Caddy's
  certificates and `.env` while links keep answering; a restore checks the backup before
  touching anything, replaces all of it, and brings the install up on the same release or a
  newer one.

### What 0.1.0 does not do

- One admin account, and no roles or second person. Neither the API nor the interface can be
  tried without a real host name for the admin service.
- No time zone setting for the install. The API works in UTC; the interface uses the
  browser's zone.
- No bulk operations: one link, one domain, one setting at a time. Most link settings are
  the API's and the interface's, not the CLI's, and returning-visitor routing needs HTTPS.
- No notifications: `GET /api/alerts` is what there is instead. A domain verified by hand is
  listed only once a check has passed for it and a later one has failed.
- Reports: one breakdown dimension at a time, no CSV of a report from the API (the interface
  makes that file in the browser), zeroes for any window before this install had its
  rollups, and no click in any of it until the worker has shipped it. While ClickHouse is
  down the reports, the click log and its export answer 503, and `GET /api/status` says so.
- An export that fails part way through ends the connection rather than finishing the file.
- Proxy and VPN detection covers Tor exits only; datacenter traffic is recognised by network
  only; region and city are never filled.
- Backups are not encrypted, rotated or copied off the server by ClickMonk, and a restore is
  of everything, with links down while it runs.
- Clicks ClickHouse rejects are set aside in the spool and nothing reports them.
- One redirect process per spool directory; a full spool keeps redirecting and drops clicks,
  and the count is on the internal `/health` only.
- The containers on the stack's own network can reach the redirect's internal port and the
  admin service.
- The IPv6 test on the published ports runs only on a host with an IPv6 address of its own,
  which most CI runners lack.
- No published container image.
