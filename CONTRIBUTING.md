# Contributing to ClickMonk

Thanks for your interest. ClickMonk is early: the redirect and the click pipeline run, but most of the product is not built yet (see the status section of the [README](README.md)). The most useful contributions right now are use cases, problems you hit with the link tracking you run today, and feedback via [issues](../../issues).

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

You need Node 22, Docker with Compose v2, and `corepack` (it ships with Node). Then:

    corepack enable
    pnpm install
    docker compose -f docker-compose.test.yml up -d --wait
    pnpm build
    pnpm test

`CLAUDE.md` explains why the build comes before the tests, and the order CI runs checks in.

### Working on the web interface

`packages/ui` is a React app the admin service serves. From the repo root:

    pnpm --filter @clickmonk/ui test    # unit suite
    pnpm --filter @clickmonk/ui build   # tsc -b, then the production build

The unit suite runs in `Australia/Adelaide` on purpose — a zone that is not a whole number of
hours from UTC and observes daylight saving — so time logic that is only right in UTC fails
here. It runs as part of the root `pnpm test` too.

The browser suite drives a real browser against the shipped stack over HTTPS, so it goes
through the stack suites (see "The stack suites" above), not `pnpm --filter @clickmonk/ui
test`. Set `CLICKMONK_SHOTS=1` to have that run also write a screenshot of every screen, in
both themes and at two widths, to `test/stack/tmp/e2e/shots/`.

Rules the source-rule tests enforce, each with its own reason:

- **No colour in `packages/ui/src`** — no hex, `rgb()`/`hsl()`/`oklch()`, named colour, or
  Tailwind palette class. A colour that bypasses the measured brand roles can pass contrast in
  one theme and fail in the other. Use a semantic class (`bg-primary`, `text-destructive`…) or,
  in SVG, `var(--color-…)`.
- **No Radix overlay primitive** (`Dialog`, `Select`, `Popover`…) — they inject a `<style>`
  element at runtime, which the content security policy refuses. Use the native `<dialog>` in
  `components/ui/modal.tsx`, or a native `<select>`.
- **No inline script or style in the built output** — the same policy has no exception for one,
  so it would be silently blocked rather than shown.
- **No runtime import from `@clickmonk/core`** (`import type` only) — a service package pulls in
  Node modules that throw when a browser bundle evaluates them, which is a blank page. Restate
  the value in `api/vocabulary.ts`, whose test checks it against the service's own.
- **Every screen has exactly one `<h1>`**, through `PageHeader`; a card or section title is an
  `<h2>`. Tests assert this by heading level, not by text, so a change that demotes a page's
  only heading is caught.

## Code of conduct

All participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
