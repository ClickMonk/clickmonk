#!/usr/bin/env bash
# Installs ClickMonk with Docker Compose on this host.
#
# Written for bash 3.2, which is what macOS ships: no associative arrays, no
# `mapfile`, no `${var,,}`. Run it again whenever you like — it writes .env
# only if there is none, never changes a value already there, and never prints
# a secret.
set -eu

usage() {
  cat <<'USAGE'
usage: ./install.sh [--no-start] [--help]

  --no-start   Write .env and stop, without pulling images or starting anything.
USAGE
}

START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) START=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

cd "$(dirname "$0")"

ours_running() {
  [ -n "$(docker compose ps -q caddy 2>/dev/null)" ]
}

# Everything about Docker is checked on the path that uses Docker. --no-start
# writes .env and stops, so it has to work on a host where Docker is not
# installed yet: writing the secrets first and installing Docker after is a
# normal order to do this in, and the usage text above promises it.
if [ "$START" = 1 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. See https://docs.docker.com/engine/install/" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "This Docker has no 'compose' command. Install Docker Compose v2." >&2
    exit 1
  fi
  # Fail before writing anything if the ports Caddy needs are taken. Skipped
  # when this install's own Caddy is what holds them, so re-running is not an
  # error. Best effort: `ss` is Linux-only, and no check at all is better than
  # refusing to install on a host that lacks it.
  if ! ours_running && command -v ss >/dev/null 2>&1; then
    for port in 80 443; do
      if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
        echo "Port $port is already in use, and ClickMonk needs it for TLS." >&2
        echo "Stop whatever holds it, then run this again." >&2
        exit 1
      fi
    done
  fi
fi

# 32 bytes of randomness as hex: a fixed length whatever the byte values are,
# and no characters that need quoting in a .env file.
secret() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

if [ -f .env ]; then
  echo ".env already exists; leaving every value in it alone."
else
  echo "Writing .env with fresh secrets..."
  # Built beside .env and renamed over it, so .env is either absent or whole.
  # A write that dies half way through would otherwise leave a .env that the
  # next run keeps as it is, while telling the operator it left every value
  # alone: an install missing a password nobody can recover.
  tmp=".env.tmp.$$"
  trap 'rm -f "$tmp"' EXIT INT TERM
  # umask before the redirect, not chmod after: chmod-after leaves a window in
  # which the file exists world-readable and already holds the passwords.
  (
    umask 077
    {
      echo "# Written by install.sh. These are the only copy of this install's"
      echo "# passwords: back this file up, and keep it out of version control."
      printf 'POSTGRES_PASSWORD=%s\n' "$(secret)"
      printf 'CLICKHOUSE_PASSWORD=%s\n' "$(secret)"
      printf 'CLICKMONK_SECRET=%s\n' "$(secret)"
    } >"$tmp"
  )
  # Every value is checked before the file is put in place, and nothing here
  # echoes what it read. A short or non-hex value means this host's random
  # source, or one of the two commands that format it, did something
  # unexpected; carrying on would install a password nobody can reproduce.
  for key in POSTGRES_PASSWORD CLICKHOUSE_PASSWORD CLICKMONK_SECRET; do
    if ! grep -Eq "^$key=[0-9a-f]{64}$" "$tmp"; then
      echo "Could not generate $key: /dev/urandom, od or tr on this host did" >&2
      echo "not give 32 bytes of hex. Nothing was written." >&2
      exit 1
    fi
  done
  mv "$tmp" .env
  trap - EXIT INT TERM
fi

if [ "$START" = 0 ]; then
  echo "Not starting (--no-start). When you are ready:"
  echo "  docker compose up -d --build --wait"
  exit 0
fi

echo "Pulling the images the stack does not build..."
docker compose pull caddy postgres clickhouse

echo "Building ClickMonk from this checkout..."
docker compose build

echo "Starting..."
if ! docker compose up -d --wait; then
  echo >&2
  echo "Startup failed: a container did not become healthy in time." >&2
  echo "Its log usually says why:" >&2
  echo "  docker compose logs" >&2
  exit 1
fi

cat <<'NEXT'

ClickMonk is running. Add your first link domain:

  docker compose exec worker node packages/cli/dist/index.js domain add links.example.com

The worker runs the database migrations when it starts, and nothing here
waited for them. If that command fails with a Postgres error about a missing
relation, wait a few seconds and run it again.

That prints a TXT record to publish. Point the domain at this server with an A
or AAAA record as well. Once the TXT record is found — within a few minutes,
or at once with `domain verify` — the domain is verified, its links start
answering, and it gets a certificate on its first HTTPS request.

Trying it out without a domain of your own? Add one with --verified, which
skips the DNS check. Its links answer at once, over plain HTTP on port 80:

  docker compose exec worker node packages/cli/dist/index.js \
    domain add links.example.com --verified

Then add a link:

  docker compose exec worker node packages/cli/dist/index.js \
    link add links.example.com spring --target https://example.com/offer

There is no admin interface yet; the CLI above is the whole of it.
NEXT
