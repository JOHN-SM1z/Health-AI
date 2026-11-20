#!/bin/sh
# Nightly backup of the Health AI database and stored files on the Uzbekistan server.
# Keeps 14 daily copies locally (mode 600) and, when BACKUP_REMOTE is set (an rsync target on a SECOND machine,
# e.g. backup@10.0.0.5:/srv/healthai), copies each one there too: a backup on the same disk is not a backup.
#
# Install (as root):  install -m 700 backup.sh /usr/local/bin/healthai-backup
#   crontab:          17 2 * * * BACKUP_REMOTE=backup@host:/srv/healthai /usr/local/bin/healthai-backup >> /var/log/healthai-backup.log 2>&1
# Restore test monthly (README.md, "Backups").
set -eu
DIR=/var/backups/healthai
STAMP=$(date -u +%Y%m%dT%H%MZ)
umask 077
mkdir -p "$DIR"

# The whole database (public, auth, storage metadata, vault, cron) in pg_dump's custom format.
docker exec supabase-db pg_dump -U postgres -d postgres -Fc > "$DIR/db-$STAMP.dump"
# Stored files (voice messages, lab PDFs), if any.
if [ -d /opt/healthai/supabase/volumes/storage ]; then
  tar -C /opt/healthai/supabase/volumes -czf "$DIR/storage-$STAMP.tar.gz" storage
fi

# A dump that cannot be listed is not a backup.
docker exec -i supabase-db pg_restore --list < "$DIR/db-$STAMP.dump" > /dev/null

find "$DIR" -type f -mtime +14 -delete
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rsync -a --chmod=F600 "$DIR/" "$BACKUP_REMOTE/"
fi
echo "$STAMP ok $(du -sh "$DIR/db-$STAMP.dump" | cut -f1)"
