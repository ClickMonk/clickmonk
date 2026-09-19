# Security policy

## Reporting a vulnerability

**Use [GitHub's private vulnerability reporting](../../security/advisories/new).**
It is the "Report a vulnerability" button on this repository's Security tab, it
needs no email address from you, and it opens a private thread that only you and
the maintainer can read.

**If you would rather use email, `hello@clickmonk.co` with `security` in the
subject line reaches the same person.** Either is fine; the advisory is easier to
keep track of.

**Please do not open a public issue.** Filing a vulnerability in a public tracker
publishes it to everyone running ClickMonk before there is anything for them to
upgrade to. ClickMonk is self-hosted, so those people cannot be patched centrally.
Each of them has to upgrade, and until they do, the report is a set of
instructions for attacking them.

Include, as far as you have it:

- the version you are running;
- what you did, in enough detail to reproduce;
- what happened, and what you expected;
- what an attacker gets out of it.

A proof of concept is welcome and is not required. A clear description of the
flaw is more useful than a working exploit.

## What to expect

ClickMonk is built by one person. That shapes everything below, and saying so is
more useful than a policy nobody is behind:

- **You will get a reply.** Usually within a few days.
- **There is no bug bounty**, and no payment of any kind.
- **There is no formal disclosure timetable.** Inventing "90 days" here would be
  a number with nothing behind it. What you will get instead is an honest
  estimate once the report has been read, and an update when the fix ships.
- **You will be credited in the release notes if you want to be**, under whatever
  name you give, and not at all if you would rather not.

Please give a reasonable window before publishing. If you have a deadline, say
so in the first message rather than at the end of it.

## Supported versions

There is no release yet. Once there is, only the latest release is supported and
a security fix ships in the next release; this table will say so.

## Scope

Everything in this repository, including the workflows in `.github/`.

Out of scope: anything about how you deployed it (your reverse proxy, host,
firewall or database passwords), and scanner output with no demonstrated impact.
The in-scope and documented-behaviour lists will grow with the product.

## Not a vulnerability?

Ordinary bugs, missing features and unclear documentation go in the
[issue tracker](../../issues), in public, where the answer helps the next person
who hits it. See [CONTRIBUTING.md](CONTRIBUTING.md).
