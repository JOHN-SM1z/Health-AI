#!/bin/bash
# Stream database and storage backups into encrypted files on the Uzbekistan host.
# Install and provision the recovery certificate using deploy/uz/README.md.
set -euo pipefail
umask 077

backup_dir=${HEALTHAI_BACKUP_DIR:-/var/backups/healthai}
storage_dir=${HEALTHAI_STORAGE_DIR:-/opt/healthai/supabase/volumes/storage}
recipient=${BACKUP_RECIPIENT_CERT:-/opt/healthai/secrets/backup-recipient.pem}

if [[ ! -r "$recipient" ]] || ! openssl x509 -in "$recipient" -checkend 0 -noout >/dev/null 2>&1; then
  echo "A valid backup recipient certificate is required." >&2
  exit 1
fi
if [[ ! -d "$storage_dir" ]]; then
  echo "Backup storage directory is missing." >&2
  exit 1
fi

mkdir -p -- "$backup_dir"
staging=$(mktemp -d "$backup_dir/.incomplete-XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
trap 'exit 1' HUP INT TERM

encrypt() {
  openssl cms -encrypt -binary -stream -outform DER -aes-256-gcm \
    -recip "$recipient" -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 -out "$1"
}

# pipefail prevents publishing or copying a set after a failed dump or archive.
docker exec supabase-db pg_dump -U postgres -d postgres -Fc | encrypt "$staging/database.dump.cms"
tar -C "$(dirname -- "$storage_dir")" -czf - -- "$(basename -- "$storage_dir")" | encrypt "$staging/storage.tar.gz.cms"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
published="$backup_dir/backup-$stamp-${staging##*-}"
mv -- "$staging" "$published"

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  # Copy this encrypted set only. Older plaintext backups may still be present.
  rsync -a -- "$published" "${BACKUP_REMOTE%/}/"
fi

# Consumers only use completed sets. Publish the marker after both archives.
touch "$published/.complete"
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rsync -a -- "$published/.complete" "${BACKUP_REMOTE%/}/${published##*/}/"
fi

find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name 'backup-????????T??????Z-*' \
  -mtime +14 -exec rm -rf -- {} +
printf '%s encrypted backup complete\n' "$stamp"
