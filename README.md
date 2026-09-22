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
  configuration: weighted rotation across destinations, per-device destinations, click
  caps, expiry, backup URLs and query passthrough. It writes every click to a spool on
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
- **Reports.** Clicks are stored in ClickHouse, but there are no reports or exports.
- **IP lookup and traffic classification.** A click's country is always empty, so a link
  limited to a list of countries sends every visitor to its backup URL.
- **Password-protected links, and backup and restore.**
- **Rejected clicks are not reported.** A batch of clicks ClickHouse refuses is set aside
  as a `.bad` file in the spool, and nothing tells you it is there.
- **More than one redirect process per spool directory.**

If link tracking is a problem you have today, [open an issue](../../issues) describing
it. That is the most useful contribution at this stage.

## License

Fair-code, under the [Sustainable Use License](LICENSE.md): free to use, self-host and
modify for your own business or for non-commercial use. It is source-available, not
open source, because it does not allow reselling ClickMonk as a hosted service.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending code, and [SECURITY.md](SECURITY.md)
to report a vulnerability.
