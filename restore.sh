#!/usr/bin/env bash
# Puts a ClickMonk install back to a backup taken by ./backup.sh.
#
# The only script in this repository that destroys data, and it destroys all
# of it: the ClickHouse database, the Postgres schema, the spool and Caddy's
# certificates are each emptied and refilled from the backup. Everything
# recorded since the backup was taken is gone. Every check runs before any of
# that, and a refusal leaves the install as it was -- not even stopped.
#
# Caddy, the redirect, the admin service and the worker are stopped for the
# whole restore, so links answer nothing until it finishes. The redirect
# cannot keep serving: it writes the spool this replaces, and a spool has one
# writer.
#
# ONE STORE IS NEVER PUT BACK ON ITS OWN, and no flag does it. Postgres holds
# the migration ledger for both stores, and the spool's clicks belong to links
# in Postgres: a Postgres from one moment beside a ClickHouse from another has
# a ledger describing tables that are not there, and the worker trusts it.
#
# AN INTERRUPTED RESTORE LEAVES THOSE FOUR STOPPED, deliberately. A redirect
# started on a half-restored Postgres serves whatever links happen to be there
# and looks healthy; a stopped one is loud. Running this again with the same
# backup starts from the beginning and finishes the job.
#
# bash for pipefail and the EXIT trap; written for bash 3.2, which macOS ships.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

trap "" PIPE

# How long the confirmation waits: long enough to read the warning, short
# enough that an unattended caller that will never answer is refused rather
# than hung.
CONFIRM_TIMEOUT=120
APP_SERVICES="caddy redirect admin worker"

usage() {
  cat >&2 <<'EOF'
usage: ./restore.sh <backup-directory>

Replaces everything this install holds -- clicks, links, domains, settings,
the admin account, API keys and certificates -- with the backup in
<backup-directory>, one of the timestamped directories ./backup.sh writes.

It checks every file against its checksum and the backup against this
checkout's image, then asks you to type the backup's timestamp. Nothing is
stopped or changed before you do.

Links answer nothing while it runs. If it is interrupted it leaves the stack
stopped and says what state each store is in; run it again with the same
backup to finish.
EOF
}

SRC="${1:-}"
case "$SRC" in
  -h | --help)
    usage
    exit 0
    ;;
  '')
    usage
    exit 2
    ;;
esac
case "$SRC" in
  /*) ;;
  *) SRC="$PWD/$SRC" ;;
esac
cd "$SCRIPT_DIR"

STAMP=''
BACKUP_SCHEMA=''
RUNNING_BEFORE=''
APPS_STOPPED=0
DESTRUCTION_BEGUN=0
STORES_RESTORED=0
# Set when every store was restored and does not match the manifest: running
# the restore again would only reproduce the mismatch, so cleanup says so.
VERIFY_FAILED=0
# Set while this run's RESTORE statement may be running in ClickHouse. The
# server carries on with it after the client is gone, so an interrupted run
# says so only when it was interrupted there.
CH_RESTORE_SENT=0
# Set by refuse and abort, which say why the run ended; any other early end
# gets one line from cleanup.
EXPLAINED=0
# What has happened to the data, in words, for the message an interrupted run
# prints. Assigned BEFORE each destructive command, never after: a signal
# lands while a command runs and bash acts on it before the next statement, so
# an assignment after the command would describe the step before.
DATA_STATE="nothing has been changed"

# refuse <reason> <detail...> -- a guard declining. Only ever called before
# anything is stopped, so what it says at the end is true.
refuse() {
  local line
  EXPLAINED=1
  note ""
  note "Refused: $1"
  shift
  for line in "$@"; do
    note "  $line"
  done
  note ""
  note "Nothing was changed, and nothing was stopped."
  exit 1
}

# abort <step> <detail...> -- a failure after the stack was stopped. cleanup
# says what state that left the data in.
abort() {
  local step="$1" line
  EXPLAINED=1
  shift
  note ""
  note "ERROR: the restore failed during the ${step} step."
  for line in "$@"; do
    note "  ${line}"
  done
  exit 1
}

# THE SIGNALS ARE MASKED FIRST: an operator who presses Ctrl-C again while
# the services are being started would otherwise end the trap before the
# start, and before the archive is deleted and the lock released. Children
# inherit the mask. Then the services, then the archive, and the lock last:
# no backup may start, and sweep the backups disk, while this run's archive is
# still there.
cleanup() {
  trap '' INT TERM HUP
  local status="$1" start_failed=0
  if [ "$APPS_STOPPED" = 1 ] && [ "$DESTRUCTION_BEGUN" = 0 ] && [ -n "$RUNNING_BEFORE" ]; then
    note "Nothing was changed. Starting$RUNNING_BEFORE again..."
    # shellcheck disable=SC2086 # a list of service names, split on purpose
    docker compose start $RUNNING_BEFORE >/dev/null 2>&1 || start_failed=1
  fi
  remove_in_container_artefact ||
    note "WARNING: could not delete $CH_BACKUP_DIR/$CH_FILE inside the clickhouse container; delete it by hand."
  if [ "$VERIFY_FAILED" = 1 ]; then
    note ""
    note "Every store was restored and does not match the manifest; the differences"
    note "are listed above. Caddy, the redirect, the admin service and the worker have"
    note "been left stopped. Restore a different backup, or start on what was restored:"
    note "  docker compose up -d"
    note "and then remove $RESTORE_MARKER, which makes backup.sh refuse until you do."
    status=1
  elif [ "$DESTRUCTION_BEGUN" = 1 ] && [ "$STORES_RESTORED" = 0 ]; then
    note ""
    note "The restore stopped part way: $DATA_STATE."
    note "Caddy, the redirect, the admin service and the worker have been left"
    note "stopped, so nothing serves your links. Run the restore again with the same"
    note "backup; it starts from the beginning:"
    note "  $SCRIPT_DIR/restore.sh $SRC"
    note "Until it has finished, backup.sh refuses to run."
    if [ "$CH_RESTORE_SENT" = 1 ]; then
      note "ClickHouse may still be finishing the restore this run started. Until it"
      note "has, running this again is refused and changes nothing; wait a minute and"
      note "run it again."
    fi
    status=1
  elif [ "$start_failed" = 1 ]; then
    note "Could not start them. Run: docker compose start$RUNNING_BEFORE"
    status=1
  elif [ "$APPS_STOPPED" = 0 ] && [ "$EXPLAINED" = 0 ]; then
    # Ended before anything was stopped, and not by a refusal: a signal, most
    # likely Ctrl-C at the prompt. Say so, or the prompt is the last word.
    note ""
    note "Stopped before anything was changed."
  fi
  release_lock || note "Could not remove $LOCK_DIR; delete it by hand before the next backup or restore."
  exit "$status"
}
trap 'cleanup "$?"' EXIT

# One backup or restore at a time against this install. A backup's sweep of
# the backups disk would delete the archive this restores from, and a backup
# taken while this runs would copy half-restored stores.
acquire_lock ||
  refuse "Another backup or restore holds $LOCK_DIR (pid $(lock_pid))." \
    "If none is running, one was killed before it could clean up. Remove the lock," \
    "then run this again: rm -rf $LOCK_DIR"

# --- Checks. Nothing below this line and above the confirmation changes or
# --- stops anything.

[ -d "$SRC" ] || refuse "$SRC is not a directory."
[ -f "$SRC/MANIFEST" ] ||
  refuse "There is no MANIFEST in $SRC." \
    "Point this at one of the timestamped directories backup.sh writes, not at" \
    "the destination you gave it."

FORMAT="$(manifest_get "$SRC" clickmonk_backup_version)" || FORMAT=''
[ "$FORMAT" = "$BACKUP_FORMAT" ] ||
  refuse "This is not a backup this script can read." \
    "Its format is '${FORMAT:-missing}'; this script reads $BACKUP_FORMAT."

STAMP="$(manifest_get "$SRC" timestamp)" || STAMP=''
[ -n "$STAMP" ] || refuse "The manifest has no timestamp."
# It becomes part of a file name and of a ClickHouse statement, so it is only
# ever the shape backup.sh writes.
case "$STAMP" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) refuse "The manifest's timestamp is '$STAMP', which is not one backup.sh writes." ;;
esac
BACKUP_RELEASE="$(manifest_get "$SRC" clickmonk_version)" || BACKUP_RELEASE='unknown'
BACKUP_SCHEMA="$(manifest_get "$SRC" schema_version)" || BACKUP_SCHEMA=''
case "$BACKUP_SCHEMA" in
  '' | *[!0-9]*) refuse "The manifest's schema_version is '${BACKUP_SCHEMA:-missing}', which is not a number." ;;
esac
for table in $CH_COUNTED; do
  manifest_get "$SRC" "rows.clickhouse.$table" >/dev/null ||
    refuse "The manifest records no row count for $table, so the restore could not be checked."
done

have_sha256 ||
  refuse "No SHA-256 tool found (looked for sha256sum, shasum and openssl)." \
    "This script does not restore a file it cannot check."

say "Checking every file against the manifest..."
for artefact in $ARTEFACTS; do
  [ -s "$SRC/$artefact" ] || refuse "$SRC/$artefact is missing or empty."
  want="$(manifest_get "$SRC" "sha256.$artefact")" ||
    refuse "The manifest records no checksum for $artefact."
  got="$(sha256_of "$SRC/$artefact")" || got=''
  [ "$got" = "$want" ] ||
    refuse "$artefact does not match the checksum in the manifest." \
      "manifest: $want" \
      "on disk:  ${got:-could not be computed}" \
      "This backup is damaged. Do not restore it; find another copy."
done

# The env file before the services: a missing file that COMPOSE_ENV_FILES
# names makes every compose command fail, which would read as a stopped store.
ENV_FILE="$(env_file_path)" ||
  refuse "COMPOSE_ENV_FILES names more than one file." \
    "Name the one file that holds this install's passwords."
[ -r "$ENV_FILE" ] || refuse "Cannot read $ENV_FILE."

for service in postgres clickhouse; do
  service_running "$service" ||
    refuse "The '$service' service is not running." \
      "Both stores must be up to restore into: docker compose up -d postgres clickhouse"
done

# Asked of the `default` database, which always exists: after an interrupted
# restore, clickmonk may not. A BACKUP or RESTORE outlives the client that
# started it -- a restore killed part way, whose lock is gone -- and this
# restore's DROP would pull the database out from under it.
IN_PROGRESS="$(ch_query "SELECT concat(status, ' ', name) FROM system.backups WHERE status IN ('CREATING_BACKUP', 'RESTORING') LIMIT 1 FORMAT TSVRaw" default)" ||
  refuse "Could not ask ClickHouse whether a backup or restore is still running."
[ -z "$IN_PROGRESS" ] ||
  refuse "ClickHouse is still running an earlier backup or restore: $IN_PROGRESS." \
    "Its client has gone, but the server finishes it. Wait for it to finish, then run this again."

# The RESTORE reads its archive from this disk and runs after the DROP, so a
# ClickHouse without it would be emptied and not refilled. That is every
# install from before clickhouse/backup-disk.xml until ClickHouse is recreated.
BACKUPS_DISK="$(ch_query "SELECT name FROM system.disks WHERE name = 'backups'" default)" || BACKUPS_DISK=''
[ "$BACKUPS_DISK" = backups ] ||
  refuse "ClickHouse has no disk named 'backups': it was started before this checkout's" \
    "clickhouse/backup-disk.xml existed. Recreate it with the new configuration" \
    "(links keep answering): docker compose up -d clickhouse"

# The archive is copied onto that disk, and after the DROP the RESTORE writes
# the restored database beside it: about four thirds of the archive's size,
# measured. The DROP frees what ClickHouse holds now. A disk that fills there
# leaves ClickHouse partial with the stack stopped, so it is refused here.
ZIP_BYTES="$(wc -c <"$SRC/clickhouse.zip" | tr -d ' ')" || ZIP_BYTES=''
CH_FREE="$(ch_query "SELECT free_space FROM system.disks WHERE name = 'backups'" default)" || CH_FREE=''
CH_BYTES="$(ch_query "SELECT sum(bytes_on_disk) FROM system.parts WHERE active AND database = '$CH_DATABASE'" default)" || CH_BYTES=''
# Each on its own: an empty one inside a concatenation would still read as a
# number, and as zero in the sum below.
for value in "$ZIP_BYTES" "$CH_FREE" "$CH_BYTES"; do
  case "$value" in
    '' | *[!0-9]*)
      refuse "Could not read the archive's size and ClickHouse's size and free space: '${ZIP_BYTES:-nothing}', '${CH_BYTES:-nothing}', '${CH_FREE:-nothing}'."
      ;;
  esac
done
CH_NEED=$((ZIP_BYTES * 5 / 2))
[ $((CH_FREE + CH_BYTES)) -ge "$CH_NEED" ] ||
  refuse "The ClickHouse volume has $((CH_FREE / 1048576)) MiB free, and $((CH_BYTES / 1048576)) MiB more once its database is dropped; this restore needs about $((CH_NEED / 1048576)) MiB." \
    "The archive is copied beside ClickHouse's data and the database is restored from it there." \
    "Free space on the disk Docker keeps its volumes on, then run this again."

say "Checking the backup against this checkout's image..."
# The image `docker compose up` would start now, which is the one this script
# starts at the end -- not whatever container happens to be running, which
# can be older while an upgrade is half done.
VERSION_LINE="$(version_via_run)" || VERSION_LINE=''
IMAGE_SCHEMA="$(printf '%s\n' "$VERSION_LINE" | schema_of)"
[ -n "$IMAGE_SCHEMA" ] ||
  refuse "Could not read the schema version this checkout's image understands." \
    "It printed: '${VERSION_LINE:-nothing}'." \
    "Build it first: docker compose build"
# A backup of an install from before `clickmonk version` records its release
# as unknown; its schema version is still exact, and is what the advice names.
if [ "$BACKUP_RELEASE" = unknown ]; then
  NEWER_ADVICE="Check out a release whose schema version is at least $BACKUP_SCHEMA, build it, and run this again."
else
  NEWER_ADVICE="Check out ClickMonk $BACKUP_RELEASE or later, build it, and run this again."
fi
[ "$BACKUP_SCHEMA" -le "$IMAGE_SCHEMA" ] ||
  refuse "This backup is newer than this image." \
    "The backup is schema version $BACKUP_SCHEMA, from ClickMonk $BACKUP_RELEASE; this image understands $IMAGE_SCHEMA." \
    "$NEWER_ADVICE"

WARNINGS=''
BACKUP_FP="$(manifest_get "$SRC" secret_fingerprint)" || BACKUP_FP=''
if [ "$(secret_fingerprint "$(env_value "$ENV_FILE" CLICKMONK_SECRET)")" != "$BACKUP_FP" ]; then
  WARNINGS="${WARNINGS}
WARNING: CLICKMONK_SECRET in $ENV_FILE is not the one this backup was taken with.
  After the restore every returning visitor counts as new, and anyone who had
  answered a link's password is asked again. To keep them: answer anything
  but the timestamp, copy the CLICKMONK_SECRET line from $SRC/env into
  $ENV_FILE, run docker compose up -d, and restore again."
fi
BACKUP_ADMIN_HOST="$(manifest_get "$SRC" admin_host)" || BACKUP_ADMIN_HOST=''
LIVE_ADMIN_HOST="$(env_value "$ENV_FILE" CLICKMONK_ADMIN_HOST)"
if [ "$LIVE_ADMIN_HOST" != "$BACKUP_ADMIN_HOST" ]; then
  WARNINGS="${WARNINGS}
WARNING: CLICKMONK_ADMIN_HOST is '$LIVE_ADMIN_HOST' here and was '$BACKUP_ADMIN_HOST'
  when this backup was taken. After the restore the admin interface answers
  on '$LIVE_ADMIN_HOST'."
fi

note ""
note "About to REPLACE everything this install holds with the backup in"
note "  $SRC"
note "taken at $STAMP by ClickMonk $BACKUP_RELEASE, schema version $BACKUP_SCHEMA."
note "This image understands schema version $IMAGE_SCHEMA; the worker applies any"
note "migrations in between when it starts."
if [ -n "$WARNINGS" ]; then
  note "$WARNINGS"
fi
note ""
note "Caddy, the redirect, the admin service and the worker are stopped until it"
note "finishes: your links answer nothing meanwhile. Everything recorded since"
note "$STAMP is lost -- clicks, links, domains, settings and keys."
note ""
note "Type the backup’s timestamp to go ahead, or anything else to stop:"
CONFIRMATION=''
IFS= read -r -t "$CONFIRM_TIMEOUT" CONFIRMATION || CONFIRMATION=''
[ "$CONFIRMATION" = "$STAMP" ] ||
  refuse "That is not the backup’s timestamp." "Expected: $STAMP"

# --- Stop the four application services ----------------------------------

for service in $APP_SERVICES; do
  if service_running "$service"; then RUNNING_BEFORE="$RUNNING_BEFORE $service"; fi
done
say "Stopping Caddy, the redirect, the admin service and the worker..."
# Before the stop: `stop` can exit non-zero having stopped them.
APPS_STOPPED=1
# shellcheck disable=SC2086 # a list of service names, split on purpose
docker compose stop $APP_SERVICES >/dev/null 2>&1 ||
  abort "stop" "docker compose stop exited non-zero. Nothing has been changed yet."
for service in $APP_SERVICES; do
  wait_until_stopped "$service" 60 ||
    abort "stop" "$service did not stop within 60 seconds. Nothing has been changed yet."
done

# --- ClickHouse ----------------------------------------------------------

# Archives a killed run left behind. Under the lock, and after the check above
# that ClickHouse is running no backup or restore, so none is in use.
remove_orphan_archives ||
  note "WARNING: could not clear old archives from $CH_BACKUP_DIR inside the clickhouse container."

say "Restoring ClickHouse..."
# The process id too, so that a run started while an earlier run's RESTORE is
# still reading its archive never writes over it.
CH_FILE="clickmonk-restore-$STAMP-$$.zip"
# Before the copy, so a copy that dies half way is still deleted.
CH_ARTEFACT_CREATED=1
# As root inside the container, handing the directory to the server's own
# user: on an install that has never taken a backup it may not exist yet, and
# a directory root created would refuse the server's next BACKUP.
docker compose exec -T clickhouse sh -c \
  'mkdir -p "$0" && chown clickhouse:clickhouse "$0" && cat >"$0/$1"' \
  "$CH_BACKUP_DIR" "$CH_FILE" <"$SRC/clickhouse.zip" ||
  abort "ClickHouse" "Could not copy the archive into the clickhouse container. Nothing has been changed yet."

# Before the first change to any store: until every store is restored, the
# marker makes backup.sh refuse rather than copy a mix of two moments.
if ! printf '%s\n' "$SRC" | artefact_write "$RESTORE_MARKER"; then
  rm -f "$RESTORE_MARKER" 2>/dev/null || true
  abort "ClickHouse" "Could not write $RESTORE_MARKER. Nothing has been changed yet."
fi
DESTRUCTION_BEGUN=1
DATA_STATE="ClickHouse was being dropped and may be gone; Postgres, the spool and the certificates are as they were"
ch_query "DROP DATABASE IF EXISTS $CH_DATABASE SYNC" default >/dev/null ||
  abort "ClickHouse" "DROP DATABASE failed; the ClickHouse error is above."
DATA_STATE="ClickHouse was being restored and may be missing or partial; Postgres, the spool and the certificates are as they were"
CH_RESTORE_SENT=1
if ! ch_query "RESTORE DATABASE $CH_DATABASE FROM Disk('backups', '$CH_FILE')" default >/dev/null; then
  # The server answered with an error: it is not running this RESTORE.
  CH_RESTORE_SENT=0
  abort "ClickHouse" "RESTORE DATABASE failed; the ClickHouse error is above."
fi
CH_RESTORE_SENT=0
remove_in_container_artefact ||
  note "WARNING: could not delete $CH_BACKUP_DIR/$CH_FILE inside the clickhouse container; delete it by hand."

# --- Postgres ------------------------------------------------------------

say "Restoring Postgres..."
DATA_STATE="ClickHouse is restored; Postgres was being emptied and may be empty; the spool and the certificates are as they were"
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$0" -d "$1" -v ON_ERROR_STOP=1 -q -c "SET client_min_messages = warning; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public"' \
  "$PG_USER" "$PG_DATABASE" </dev/null >/dev/null ||
  abort "Postgres" "Could not empty the public schema; the Postgres error is above."
DATA_STATE="ClickHouse is restored; Postgres was being refilled and is either empty or complete; the spool and the certificates are as they were"
# One transaction: the dump is applied whole or not at all.
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$0" -d "$1" --clean --if-exists --no-owner --single-transaction' \
  "$PG_USER" "$PG_DATABASE" <"$SRC/postgres.dump" ||
  abort "Postgres" "pg_restore failed; its error is above. Nothing of the dump was applied."

# --- The spool, the redirect's state, Caddy's data -----------------------

say "Restoring the spool..."
DATA_STATE="ClickHouse and Postgres are restored; the spool was being replaced and may be partial; the certificates are as they were"
docker compose --progress quiet run --rm --no-deps -T worker sh -c \
  'find "$0" -mindepth 1 -delete && tar -xf - -C "$0"' "$SPOOL_DIR" <"$SRC/spool.tar" ||
  abort "spool" "Could not replace the spool."
# The redirect's copy of its configuration describes the install before the
# restore. It reads Postgres at start and writes this again; without the file,
# a stale configuration can never be served from it.
docker compose --progress quiet run --rm --no-deps -T redirect sh -c \
  'find "$0" -mindepth 1 -delete' "$STATE_DIR" </dev/null ||
  abort "spool" "Could not empty the redirect's state directory."

say "Restoring Caddy's certificates..."
DATA_STATE="ClickHouse, Postgres and the spool are restored; Caddy's certificates were being replaced and may be partial"
docker compose --progress quiet run --rm --no-deps -T caddy sh -c \
  'find "$0" -mindepth 1 -delete && tar -xf - -C "$0"' "$CADDY_DATA_DIR" <"$SRC/caddy-data.tar" ||
  abort "Caddy" "Could not replace Caddy's data."

# --- Check, then start -----------------------------------------------------

say "Checking what was restored against the manifest..."
DATA_STATE="every store was restored, and was being checked against the manifest"
verify_ok=1
restored_schema="$(ledger_version)" || restored_schema=''
if [ "$restored_schema" != "$BACKUP_SCHEMA" ]; then
  note "  schema_migrations: the backup recorded version $BACKUP_SCHEMA, the restored ledger says ${restored_schema:-nothing}"
  verify_ok=0
fi
for table in $CH_COUNTED; do
  want="$(manifest_get "$SRC" "rows.clickhouse.$table")" || want=''
  got="$(ch_query "SELECT count() FROM $table FINAL")" || got=''
  if [ "$got" != "$want" ]; then
    note "  $table: the backup recorded ${want:-nothing} rows, the restored table has ${got:-nothing}"
    verify_ok=0
  fi
done
if [ "$verify_ok" != 1 ]; then
  VERIFY_FAILED=1
  abort "verification" "The restored stores do not match the manifest."
fi
STORES_RESTORED=1
rm -f "$RESTORE_MARKER" ||
  note "WARNING: could not remove $RESTORE_MARKER; delete it by hand, or backup.sh refuses to run."

say "Starting the stack..."
# `up`, not `start`: a container whose image is older than the tag is
# recreated, so the image that runs is the one checked above.
docker compose up -d --wait --wait-timeout 300 ||
  abort "start" \
    "Every store is restored, but the stack did not start, or did not become healthy within five minutes." \
    "See: docker compose ps; docker compose logs"

say ""
say "Restored from $SRC, taken at $STAMP."
say "The worker is applying any migrations newer than the backup and shipping the"
say "clicks that were in its spool; the reports catch up within a minute or two."
say ""
say "The admin account is back as it was then: its password, its two-factor"
say "setting, its sessions and its API keys. A key revoked or a password changed"
say "since $STAMP is as it was. Check the keys with:"
say "  docker compose exec -T worker node packages/cli/dist/index.js apikey list"
