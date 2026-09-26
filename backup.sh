#!/usr/bin/env bash
# Backs up a ClickMonk install -- ClickHouse, Postgres, the spool, Caddy's
# certificates and .env -- into one new directory.
#
# Links keep answering throughout. The one container stopped is the worker,
# and only while the spool and ClickHouse are copied: it is the only thing
# that moves clicks from the one into the other, so with it stopped the two
# copies describe one instant. A click in both is shipped again after a
# restore and counted once, because every count ClickMonk makes is of distinct
# click ids. Clicks the redirect accepts meanwhile wait in the spool.
#
# Every file this writes is a credential. The umask comes before anything is
# created, rather than a chmod afterwards, so no file ever exists with a
# looser mode, and every file is created by artefact_write in backup-lib.sh.
#
# bash for `set -o pipefail` -- a dump that fails half way through a pipe must
# fail the run -- and for the EXIT trap that starts the worker again. Written
# for bash 3.2, which macOS ships.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

# A reader that goes away turns a write into an error instead of ending the
# run half way through, with the worker stopped.
trap "" PIPE

usage() {
  cat >&2 <<'EOF'
usage: ./backup.sh <destination-directory>

Writes <destination>/<UTC timestamp>/ holding clickhouse.zip, postgres.dump,
spool.tar, caddy-data.tar, env and MANIFEST, readable by you alone.

Links keep answering while it runs. The worker is stopped while the spool and
ClickHouse are copied -- a pause that grows with the data -- and started again
afterwards; a worker that was already stopped is left stopped. ClickHouse
writes its archive beside its data first, so the disk Docker keeps its volumes
on needs about ClickHouse's size free; a backup that would not fit is refused.

Every file it writes is a credential: the database passwords, the secret that
signs visitor cookies, the admin account's two-factor secret and every
certificate's private key. Keep the destination private, and encrypt it before
it leaves this host.

If you pipe this anywhere, test ${PIPESTATUS[0]}, not $?.
EOF
}

DEST="${1:-}"
case "$DEST" in
  -h | --help)
    usage
    exit 0
    ;;
  '')
    usage
    exit 2
    ;;
esac
# Absolute before the cd below, so a relative destination is relative to
# where it was typed.
case "$DEST" in
  /*) ;;
  *) DEST="$PWD/$DEST" ;;
esac
# docker-compose.yml and .env are found from here, so cron need not cd first.
cd "$SCRIPT_DIR"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="$DEST/$STAMP"
# The process id too: two runs started in the same second into different
# destinations share a timestamp, and the archive name is what the EXIT trap
# deletes.
CH_FILE="clickmonk-$STAMP-$$.zip"
OUT_CREATED=0
BACKUP_COMPLETE=0
WORKER_STOPPED_BY_US=0

# fail <step> <detail...> -- every failure of this script, before or after the
# worker was stopped. The last sentence is true on every path: nothing here
# writes to either store.
fail() {
  local step="$1" line
  shift
  note ""
  note "ERROR: the backup failed during the ${step} step."
  for line in "$@"; do
    note "  ${line}"
  done
  note ""
  note "No data was changed: this script only reads from Postgres, ClickHouse,"
  note "the spool and Caddy's data."
  exit 1
}

start_worker_if_we_stopped_it() {
  [ "$WORKER_STOPPED_BY_US" = 1 ] || return 0
  local attempt
  for attempt in 1 2 3; do
    if docker compose start worker >/dev/null 2>&1 && service_running worker; then
      WORKER_STOPPED_BY_US=0
      return 0
    fi
    [ "$attempt" = 3 ] && break
    say "Could not start the worker (attempt $attempt of 3); trying again..."
    sleep 2
  done
  return 1
}

remove_incomplete_output() {
  [ "$OUT_CREATED" = 1 ] || return 0
  [ "$BACKUP_COMPLETE" = 1 ] && return 0
  rm -rf "$OUT" 2>/dev/null || note "Could not remove the incomplete backup at $OUT; delete it by hand."
  return 0
}

# THE RESTART COMES FIRST, once the signals that could end the trap are
# masked: an operator who presses Ctrl-C again while the worker is being
# started would otherwise kill the trap before the restart, leaving the
# reports frozen with nothing saying why. Children inherit the mask, so the
# restart cannot be interrupted either; the trap ends in about ten seconds at
# most. Each tidy-up after the restart cannot fail, and the lock goes last, so
# no other run starts until this one is done with the stores.
cleanup() {
  trap '' INT TERM HUP
  local restart_ok=1
  start_worker_if_we_stopped_it || restart_ok=0
  remove_in_container_artefact ||
    note "WARNING: could not delete $CH_BACKUP_DIR/$CH_FILE inside the clickhouse container; delete it by hand."
  remove_incomplete_output || true
  if [ "$restart_ok" = 0 ]; then
    note ""
    note "ERROR: the worker is stopped and this script could not start it again."
    note "  Run: docker compose start worker"
    note "Links are still answering and their clicks are waiting in the spool,"
    note "but nothing reaches the reports until the worker is running."
    release_lock || true
    exit 1
  fi
  release_lock || note "Could not remove $LOCK_DIR; delete it by hand before the next backup or restore."
}
trap cleanup EXIT

# One backup or restore at a time against this install: a second run would
# see the worker the first one stopped as already stopped, and copy while the
# first starts it again.
acquire_lock ||
  fail "validation" \
    "Another backup or restore holds $LOCK_DIR (pid $(lock_pid))." \
    "If none is running, one was killed before it could clean up. Remove the lock," \
    "then run this again: rm -rf $LOCK_DIR"

# --- Every check first, before anything is stopped ---------------------

# The env file before the services: a missing file that COMPOSE_ENV_FILES
# names makes every compose command fail, which would read as a stopped store.
ENV_FILE="$(env_file_path)" ||
  fail "validation" \
    "COMPOSE_ENV_FILES names more than one file, and a backup copies exactly one." \
    "Name the one file that holds this install's passwords."
[ -r "$ENV_FILE" ] ||
  fail "validation" \
    "Cannot read $ENV_FILE, which holds this install's passwords and is part of every backup."

# Only the two stores have to be running. The spool and Caddy's data are read
# through a running container when there is one and a one-off container
# otherwise, so a crash-looping Caddy -- the likeliest broken service -- does
# not make the backup impossible at the moment it is most wanted.
for service in postgres clickhouse; do
  service_running "$service" ||
    fail "validation" \
      "The '$service' service is not running." \
      "Start it first: docker compose up -d $service"
done

have_sha256 ||
  fail "validation" \
    "No SHA-256 tool found (looked for sha256sum, shasum and openssl)." \
    "The manifest records one per file so that a damaged copy is refused."

# The release is informational: restore.sh checks the schema version, which
# comes from the ledger below. An image from before `clickmonk version` existed
# prints its usage instead -- every install upgrading to the first release
# runs one -- and its backup must still be taken, before the upgrade.
# Asked of the redirect, or of the worker when the redirect is down, before
# the worker is stopped: either runs the image that wrote the data.
VERSION_LINE=''
VERSION_ASKED=0
for service in redirect worker; do
  if service_running "$service"; then
    VERSION_ASKED=1
    VERSION_LINE="$(version_via_exec "$service" 2>/dev/null)" || VERSION_LINE=''
    break
  fi
done
RELEASE="$(printf '%s\n' "$VERSION_LINE" | release_of)"
if [ -z "$RELEASE" ]; then
  RELEASE=unknown
  if [ "$VERSION_ASKED" = 1 ]; then
    note "The running image predates 'clickmonk version'; the manifest records the release as unknown."
  else
    note "Neither the redirect nor the worker is running; the manifest records the release as unknown."
  fi
fi

SCHEMA="$(ledger_version)" || SCHEMA=''
case "$SCHEMA" in
  '' | *[!0-9]*)
    fail "validation" "Could not read the schema version from Postgres: '${SCHEMA:-nothing}'."
    ;;
esac

# A BACKUP or RESTORE the server is still running outlives the client that
# started it: a backup or restore killed part way, whose lock is gone. Its
# archive is what the sweep below would delete, and a RESTORE still running
# means ClickHouse holds half a database. This run has started neither yet.
IN_PROGRESS="$(ch_query "SELECT concat(status, ' ', name) FROM system.backups WHERE status IN ('CREATING_BACKUP', 'RESTORING') LIMIT 1")" ||
  fail "validation" "Could not ask ClickHouse whether a backup or restore is still running."
[ -z "$IN_PROGRESS" ] ||
  fail "validation" \
    "ClickHouse is still running an earlier backup or restore: $IN_PROGRESS." \
    "Its client has gone, but the server finishes it. Wait for it to finish, then run this again."

remove_orphan_archives ||
  note "WARNING: could not clear old archives from $CH_BACKUP_DIR inside the clickhouse container."

# ClickHouse writes its archive onto the disk its data is on, and keeps taking
# inserts beside it once the worker is back. A disk that fills stops inserts
# and merges, so a backup that would not fit is refused before anything stops.
CH_BYTES="$(ch_query "SELECT sum(bytes_on_disk) FROM system.parts WHERE active AND database = '$CH_DATABASE'")" || CH_BYTES=''
CH_FREE="$(ch_query "SELECT free_space FROM system.disks WHERE name = 'backups'")" || CH_FREE=''
# No row at all: ClickHouse was started without clickhouse/backup-disk.xml,
# which is every install from before this script existed until ClickHouse is
# recreated with the new configuration. Nothing else here would say why.
[ -n "$CH_FREE" ] ||
  fail "validation" \
    "ClickHouse has no disk named 'backups': it was started before this checkout's" \
    "clickhouse/backup-disk.xml existed. Recreate it with the new configuration" \
    "(links keep answering; the worker waits for it): docker compose up -d clickhouse"
case "$CH_BYTES$CH_FREE" in
  '' | *[!0-9]*)
    fail "validation" "Could not read ClickHouse's size and free space: '${CH_BYTES:-nothing}', '${CH_FREE:-nothing}'."
    ;;
esac
# bash's arithmetic is 64-bit, so byte counts of any real disk fit.
CH_NEED=$((CH_BYTES + CH_BYTES / 10))
[ "$CH_FREE" -ge "$CH_NEED" ] ||
  fail "validation" \
    "The ClickHouse volume has $((CH_FREE / 1048576)) MiB free and a backup needs about $((CH_NEED / 1048576)) MiB." \
    "ClickHouse writes its archive beside its data before this script copies it out." \
    "Free space on the disk Docker keeps its volumes on, then run this again."

SECRET_FP="$(secret_fingerprint "$(env_value "$ENV_FILE" CLICKMONK_SECRET)")"
ADMIN_HOST="$(env_value "$ENV_FILE" CLICKMONK_ADMIN_HOST)"

mkdir -p "$DEST" 2>/dev/null ||
  fail "destination" "Could not create $DEST." "Check that the path is a directory you can write to."
# Not -p: this mkdir fails if the directory exists, so of two runs started in
# the same second exactly one owns it, and the other cannot delete it on its
# way out.
mkdir "$OUT" 2>/dev/null ||
  fail "destination" \
    "Could not create $OUT." \
    "Another backup started in the same second, or the destination is not writable."
OUT_CREATED=1

# --- The spool and ClickHouse, at one instant ----------------------------

if service_running worker; then
  say "Stopping the worker while the spool and ClickHouse are copied..."
  # Set before the stop, not after: `stop` can stop the container and still
  # exit non-zero (Ctrl-C during its drain), and the trap must then know to
  # start it again.
  WORKER_STOPPED_BY_US=1
  docker compose stop worker >/dev/null 2>&1 ||
    fail "quiesce" "docker compose stop worker exited non-zero." "It is being started again either way."
  wait_until_stopped worker 60 ||
    fail "quiesce" "The worker did not stop within 60 seconds."
else
  say "The worker is not running; it is left that way."
fi

say "Copying the spool..."
read_dir_of redirect "$SPOOL_DIR" | artefact_write "$OUT/spool.tar" ||
  fail "spool" "Could not copy the spool out of the redirect's volume."

say "Backing up ClickHouse..."
# Before the BACKUP, not after: a client that is killed does not stop a BACKUP,
# which the server finishes and leaves behind. The trap deletes the name
# (and its lock file) whether or not the archive has appeared yet; a BACKUP
# still running then writes into an unlinked file whose space is freed when
# it ends. Removing a name that never appeared is harmless.
CH_ARTEFACT_CREATED=1
ch_query "BACKUP DATABASE $CH_DATABASE TO Disk('backups', '$CH_FILE')" >/dev/null ||
  fail "ClickHouse" "BACKUP DATABASE failed or was interrupted; any error is above."
CH_COUNTS="$(ch_counts)" ||
  fail "ClickHouse" "Counting the rows the manifest records failed or was interrupted; any error is above."

# The spool and ClickHouse are copied: the worker may ship again. A failure
# here is retried by the trap, which also makes the run fail if it cannot.
start_worker_if_we_stopped_it || note "WARNING: the worker did not start yet; trying again at the end."

docker compose exec -T clickhouse cat "$CH_BACKUP_DIR/$CH_FILE" </dev/null |
  artefact_write "$OUT/clickhouse.zip" ||
  fail "ClickHouse" "Could not copy the archive out of the clickhouse container."
remove_in_container_artefact ||
  note "WARNING: could not delete $CH_BACKUP_DIR/$CH_FILE inside the clickhouse container; delete it by hand."

# --- Postgres, Caddy's certificates, .env --------------------------------

say "Backing up Postgres..."
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$0" -d "$1" -Fc' \
  "$PG_USER" "$PG_DATABASE" </dev/null |
  artefact_write "$OUT/postgres.dump" ||
  fail "Postgres" "pg_dump, or writing postgres.dump, failed; the error is above."

say "Copying Caddy's certificates..."
read_dir_of caddy "$CADDY_DATA_DIR" | artefact_write "$OUT/caddy-data.tar" ||
  fail "Caddy" "Could not copy $CADDY_DATA_DIR out of Caddy's volume."

say "Copying $ENV_FILE..."
artefact_write "$OUT/env" <"$ENV_FILE" ||
  fail "env" "Could not copy $ENV_FILE."

# --- The manifest --------------------------------------------------------

SUMS=''
for artefact in $ARTEFACTS; do
  [ -s "$OUT/$artefact" ] || fail "manifest" "$artefact is empty."
  sum="$(sha256_of "$OUT/$artefact")" || sum=''
  [ -n "$sum" ] || fail "manifest" "Could not compute the checksum of $artefact."
  SUMS="${SUMS}sha256.$artefact=$sum
"
done

say "Writing the manifest..."
{
  echo "clickmonk_backup_version=$BACKUP_FORMAT"
  echo "timestamp=$STAMP"
  echo "clickmonk_version=$RELEASE"
  echo "schema_version=$SCHEMA"
  printf '%s' "$SUMS"
  echo "secret_fingerprint=$SECRET_FP"
  echo "admin_host=$ADMIN_HOST"
  echo "$CH_COUNTS"
} | artefact_write "$OUT/MANIFEST.partial" ||
  fail "manifest" "Could not write the manifest."
# A rename, so MANIFEST is either absent or whole: restore.sh refuses a
# directory without one.
mv "$OUT/MANIFEST.partial" "$OUT/MANIFEST" ||
  fail "manifest" "Could not write the manifest."

# The success line below is a claim about the disk, not the page cache.
sync 2>/dev/null || note "WARNING: sync failed; the files may not all be on disk yet."
BACKUP_COMPLETE=1

start_worker_if_we_stopped_it || true
say "Backup written to $OUT"
