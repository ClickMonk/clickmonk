# shellcheck shell=bash
# shellcheck disable=SC2034 # the variables below are read by the scripts that source this file
#
# Shared by backup.sh and restore.sh, which source it. Never executed, so it
# has no shebang and is not executable.
#
# Written for bash 3.2, which is what macOS ships: no associative arrays, no
# `mapfile`, no `${var,,}`. Every docker call is plain `docker compose` with no
# `-f`, so COMPOSE_FILE, COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES select the
# install exactly as they do for any other compose command.

# The database and the role in each store, as docker-compose.yml creates them.
CH_DATABASE=clickmonk
PG_DATABASE=clickmonk
PG_USER=clickmonk

# Paths inside the containers. The first is the disk clickhouse/backup-disk.xml
# declares; the others are where docker-compose.yml mounts the volumes.
CH_BACKUP_DIR=/var/lib/clickhouse/backups
SPOOL_DIR=/var/lib/clickmonk/spool
STATE_DIR=/var/lib/clickmonk/state
CADDY_DATA_DIR=/data

# The layout of a backup directory. restore.sh refuses any other number.
BACKUP_FORMAT=1
# Every file a backup holds besides MANIFEST.
ARTEFACTS="spool.tar clickhouse.zip postgres.dump caddy-data.tar env"
# The ClickHouse tables whose rows a restore is checked against.
CH_COUNTED="clicks clicks_hourly clicks_hourly_dim"

# The archive's name on the backups disk, and whether this run has put one
# there, so the EXIT trap knows to delete it.
CH_FILE=''
CH_ARTEFACT_CREATED=0

# Output that cannot fail. A reader that went away (`| head`) turns a write
# into an error, and a message nobody reads must not end the run.
say() { echo "$@" 2>/dev/null || true; }
note() { echo "$@" >&2 2>/dev/null || true; }

# ch_query <sql> [database]
#
# The password is the container's own CLICKHOUSE_PASSWORD, referenced inside
# the single-quoted program, so the host shell never expands it and it is in
# no host process's arguments. `default` is the database to name while
# `clickmonk` does not exist, between restore.sh's DROP and its RESTORE:
# naming a missing database is itself an error. stdin is closed because
# `exec -T` would otherwise hand the container the caller's.
ch_query() {
  docker compose exec -T clickhouse sh -c \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$1" --query "$0"' \
    "$1" "${2:-$CH_DATABASE}" </dev/null
}

# pg_query <sql> -- one value per line, unaligned.
pg_query() {
  docker compose exec -T postgres sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$1" -d "$2" -At -v ON_ERROR_STOP=1 -c "$0"' \
    "$1" "$PG_USER" "$PG_DATABASE" </dev/null
}

# artefact_write <path> -- the one place either script creates a file by
# writing to it. Under the umask both scripts set first, every file is 0600
# from the moment it exists; nothing here ever widens it.
artefact_write() {
  cat >"$1"
}

service_running() {
  docker compose ps --status running --services 2>/dev/null | grep -qx "$1"
}

# wait_until_stopped <service> <seconds>
wait_until_stopped() {
  local i=0
  while [ "$i" -lt "$2" ]; do
    service_running "$1" || return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

have_sha256() {
  command -v sha256sum >/dev/null 2>&1 ||
    command -v shasum >/dev/null 2>&1 ||
    command -v openssl >/dev/null 2>&1
}

# sha256_stdin -- the hex digest of standard input, with whichever tool this
# host has: sha256sum on Linux, shasum on macOS, openssl as the last resort.
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

sha256_of() {
  sha256_stdin <"$1"
}

# env_file_path -- the file Compose reads this install's variables from:
# COMPOSE_ENV_FILES when it names one file, .env beside docker-compose.yml
# otherwise. More than one is refused by the caller rather than guessed at.
env_file_path() {
  case "${COMPOSE_ENV_FILES:-}" in
    '') echo ".env" ;;
    *,*) return 1 ;;
    *) echo "$COMPOSE_ENV_FILES" ;;
  esac
}

# env_value <file> <key> -- the text after the first `=` on the last line that
# sets key, with one pair of matching surrounding quotes removed, as Compose
# reads it. install.sh writes no quotes; an operator may have added them.
env_value() {
  local line value=''
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$2="*) value="${line#*=}" ;;
    esac
  done <"$1"
  case "$value" in
    \"*\" | \'*\')
      if [ "${#value}" -ge 2 ]; then
        value="${value#?}"
        value="${value%?}"
      fi
      ;;
  esac
  printf '%s' "$value"
}

# read_dir_of <service> <dir> -- a tar of <dir> on standard output, from the
# service's running container, or from a one-off container of it when it is
# not running. Either way the volume is the one that service mounts.
read_dir_of() {
  if service_running "$1"; then
    docker compose exec -T "$1" tar -cf - -C "$2" . </dev/null
  else
    docker compose --progress quiet run --rm --no-deps -T "$1" tar -cf - -C "$2" . </dev/null
  fi
}

# secret_fingerprint <secret> -- 16 hex characters that tell whether two
# installs share a CLICKMONK_SECRET without being it. The prefix keeps it from
# being the plain digest of the secret, which some other tool might also print.
secret_fingerprint() {
  printf 'clickmonk-secret:%s' "$1" | sha256_stdin | cut -c1-16
}

# The line `clickmonk version` prints, from a running container of <service>,
# or from a one-off container of the image `docker compose up` would start now.
version_via_exec() {
  docker compose exec -T "$1" node packages/cli/dist/index.js version </dev/null
}
version_via_run() {
  docker compose --progress quiet run --rm --no-deps -T worker \
    node packages/cli/dist/index.js version </dev/null
}

# release_of / schema_of -- the two numbers in that line, read from stdin;
# empty when the line is not the one expected.
release_of() {
  sed -n 's/^clickmonk \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\) (schema version [0-9][0-9]*)$/\1/p'
}
schema_of() {
  sed -n 's/^clickmonk [0-9][0-9.]* (schema version \([0-9][0-9]*\))$/\1/p'
}

# ledger_version -- the newest migration applied to this install. Postgres
# holds the one ledger for both stores.
ledger_version() {
  pg_query 'SELECT COALESCE(max(version), 0) FROM schema_migrations'
}

# ch_counts -- `rows.clickhouse.<table>=<n>` for each counted table. FINAL,
# because both engines merge rows that share a key when ClickHouse chooses to:
# counted FINAL, the same parts give the same number whenever they are read.
ch_counts() {
  local t n
  for t in $CH_COUNTED; do
    n="$(ch_query "SELECT count() FROM $t FINAL")" || return 1
    case "$n" in
      '' | *[!0-9]*) return 1 ;;
    esac
    echo "rows.clickhouse.$t=$n"
  done
}

# manifest_get <dir> <key> -- the text after the FIRST `=` on the line for key.
# Keys never contain `=`; a value might.
manifest_get() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$2="*)
        printf '%s' "${line#*=}"
        return 0
        ;;
    esac
  done <"$1/MANIFEST"
  return 1
}

# remove_in_container_artefact -- deletes this run's archive from the
# backups disk. The disk is inside the clickhouse-data volume, so an archive
# left there is a whole backup's worth of that volume, every night.
remove_in_container_artefact() {
  [ "$CH_ARTEFACT_CREATED" = 1 ] || return 0
  docker compose exec -T clickhouse rm -f "$CH_BACKUP_DIR/$CH_FILE" "$CH_BACKUP_DIR/$CH_FILE.lock" \
    </dev/null >/dev/null 2>&1 || return 1
  CH_ARTEFACT_CREATED=0
}

# remove_orphan_archives -- deletes every archive either script leaves on the
# backups disk (clickmonk-*.zip) and their lock files. Called only while the
# lock below is held, so no run of either script is using one. A client that
# was killed can still reach the server after its trap's rm, and that BACKUP
# then finishes and leaves a whole archive; the next run removes it here. An
# orphan still being written fails once its lock file is gone, and ClickHouse
# removes what it had written.
remove_orphan_archives() {
  docker compose exec -T clickhouse sh -c 'rm -f "$0"/clickmonk-*.zip "$0"/clickmonk-*.zip.lock' \
    "$CH_BACKUP_DIR" </dev/null >/dev/null 2>&1
}

# The one lock backup.sh and restore.sh share: a directory beside this file,
# so every run against this install takes the same one whatever its
# destination. mkdir, because it is atomic everywhere and macOS has no flock.
LOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.backup-restore.lock"
LOCK_HELD=0

# RESTORE_MARKER -- a file beside the lock that restore.sh writes, holding the
# backup it is restoring, before it changes any store, and removes once every
# store is restored. While it exists the stores may be half restored:
# backup.sh refuses, and restore.sh, run again, finishes the job.
RESTORE_MARKER="$(dirname "$LOCK_DIR")/.restore-incomplete"

# acquire_lock -- creates LOCK_DIR and writes this shell's pid into it, or
# returns 1 and leaves an existing lock exactly as it is. A lock is never
# removed for being stale: two runs that both judged it stale would both go
# on to hold it. The caller refuses, naming LOCK_DIR and lock_pid.
acquire_lock() {
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  LOCK_HELD=1
  echo "$$" | artefact_write "$LOCK_DIR/pid" || true
}

# lock_pid -- the pid recorded in the lock, or `unknown`.
lock_pid() {
  local pid
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null)" || pid=''
  printf '%s' "${pid:-unknown}"
}

# release_lock -- removes the lock only if this run took it. The last thing
# either script's EXIT trap does, so another run can start only once this
# one has finished with the stores.
release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  rm -rf "$LOCK_DIR" 2>/dev/null || return 1
  LOCK_HELD=0
}
