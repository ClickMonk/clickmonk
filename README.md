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
- **The worker**, which ships spooled clicks into ClickHouse and runs the database
  migrations when it starts.
- **The CLI**: `clickmonk migrate`, `clickmonk domain add` and `clickmonk link add`.
- **A Docker Compose stack** that runs all of it, and a test that restarts each service
  under continuous traffic and requires every redirect the client received to arrive in
  ClickHouse as a click.

What does not work yet:

- **TLS.** The redirect serves plain HTTP on port 8080. Its visitor cookies are marked
  `Secure`, so browsers drop them over plain HTTP, and sending returning visitors to a
  different destination does not work until TLS does.
- **An admin API or UI.** Domains and links are added with the CLI, and `domain add`
  marks a domain verified without checking its DNS.
- **Most link settings.** `clickmonk link add` sets targets, a backup URL, a click cap,
  an expiry and passthrough only. The redirect supports per-device destinations, a
  returning-visitor destination, country rules, a link name and disabling a link, but
  the CLI cannot set any of them yet, so they need SQL written by hand.
- **Reports.** Clicks are stored in ClickHouse, but there are no reports or exports.
- **IP lookup and traffic classification.** A click's country is always empty, so a link
  limited to a list of countries sends every visitor to its backup URL.
- **Password-protected links, and backup and restore.**
- **Rejected clicks are not reported.** A batch of clicks ClickHouse refuses is set aside
  as a `.bad` file in the spool, and nothing tells you it is there.
- **More than one redirect process per spool directory.**

If link tracking is a problem you have today, [open an issue](../../issues) describing
it. That is the most useful contribution at this stage.

## IP data

The worker downloads four lists to your server, and `clickmonk ipdata update` fetches
them on demand. Nothing uses them to route or classify clicks yet.

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

On a server without internet access, set `CLICKMONK_IPDATA_UPDATE=off`.

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

## License

Fair-code, under the [Sustainable Use License](LICENSE.md): free to use, self-host and
modify for your own business or for non-commercial use. It is source-available, not
open source, because it does not allow reselling ClickMonk as a hosted service.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending code, and [SECURITY.md](SECURITY.md)
to report a vulnerability.
