#!/bin/bash
# Exercise encryption and failure handling with synthetic files and no Docker daemon.
set -euo pipefail
umask 077

script_dir=$(cd "$(dirname -- "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/storage" "$fixture/offsite"

export HEALTHAI_BACKUP_DIR="$fixture/backups"
export HEALTHAI_STORAGE_DIR="$fixture/storage"
export BACKUP_RECIPIENT_CERT="$fixture/recipient.pem"
export BACKUP_REMOTE="$fixture/offsite"
export BACKUP_FIXTURE_RSYNC
BACKUP_FIXTURE_RSYNC=$(command -v rsync)
export PATH="$fixture/bin:$PATH"
export BACKUP_FIXTURE="$fixture"

cat > "$fixture/bin/docker" <<'DOCKER'
#!/bin/bash
set -eu
[[ "$*" == "exec supabase-db pg_dump -U postgres -d postgres -Fc" ]]
cat "$BACKUP_FIXTURE/mock.dump"
[[ "${FAIL_SYNTHETIC_DUMP:-0}" == 0 ]]
DOCKER
chmod 700 "$fixture/bin/docker"

cat > "$fixture/bin/rsync" <<'RSYNC'
#!/bin/bash
set -eu
if [[ "${FAIL_SYNTHETIC_COPY:-0}" == 1 ]]; then
  destination="$BACKUP_REMOTE/$(basename -- "$3")"
  mkdir "$destination"
  cp "$3/database.dump.cms" "$destination/"
  exit 1
fi
exec "$BACKUP_FIXTURE_RSYNC" "$@"
RSYNC
chmod 700 "$fixture/bin/rsync"

printf 'Synthetic database data\n' > "$fixture/mock.dump"
printf 'Synthetic private-storage data\n' > "$fixture/storage/mock.txt"
openssl req -x509 -newkey rsa:3072 -sha256 -noenc -days 1 -subj '/CN=Synthetic backup fixture' \
  -keyout "$fixture/recovery-key.pem" -out "$BACKUP_RECIPIENT_CERT" >/dev/null 2>&1

if BACKUP_RECIPIENT_CERT="$fixture/missing.pem" bash "$script_dir/backup.sh" >/dev/null 2>&1; then
  echo "Backup succeeded without a recipient certificate." >&2
  exit 1
fi
[[ ! -e "$HEALTHAI_BACKUP_DIR" ]]

# A legacy plaintext file present on the host must not reach the off-site copy.
mkdir "$HEALTHAI_BACKUP_DIR"
cp "$fixture/mock.dump" "$HEALTHAI_BACKUP_DIR/old-plaintext.dump"

bash "$script_dir/backup.sh"
shopt -s nullglob
local_sets=("$HEALTHAI_BACKUP_DIR"/backup-*)
offsite_sets=("$BACKUP_REMOTE"/backup-*)
[[ "${#local_sets[@]}" == 1 && "${#offsite_sets[@]}" == 1 ]]
[[ ! -e "$BACKUP_REMOTE/old-plaintext.dump" ]]
[[ -f "${offsite_sets[0]}/.complete" ]]
[[ "$(find "${offsite_sets[0]}" -type f -name '*.cms' | wc -l | tr -d ' ')" == 2 ]]

decrypt() {
  openssl cms -decrypt -binary -inform DER -in "$1" -out "$2" \
    -recip "$BACKUP_RECIPIENT_CERT" -inkey "$fixture/recovery-key.pem"
}

decrypt "${offsite_sets[0]}/database.dump.cms" "$fixture/recovered.dump"
cmp "$fixture/mock.dump" "$fixture/recovered.dump"
decrypt "${offsite_sets[0]}/storage.tar.gz.cms" "$fixture/recovered-storage.tar.gz"
mkdir "$fixture/recovered"
tar -xzf "$fixture/recovered-storage.tar.gz" -C "$fixture/recovered"
cmp "$fixture/storage/mock.txt" "$fixture/recovered/storage/mock.txt"

# A producer can fail after writing data even if encryption exits successfully.
if FAIL_SYNTHETIC_DUMP=1 bash "$script_dir/backup.sh" >/dev/null 2>&1; then
  echo "Backup accepted a failed dump." >&2
  exit 1
fi
local_sets=("$HEALTHAI_BACKUP_DIR"/backup-*)
offsite_sets=("$BACKUP_REMOTE"/backup-*)
incomplete_sets=("$HEALTHAI_BACKUP_DIR"/.incomplete-*)
[[ "${#local_sets[@]}" == 1 && "${#offsite_sets[@]}" == 1 && "${#incomplete_sets[@]}" == 0 ]]
if FAIL_SYNTHETIC_COPY=1 bash "$script_dir/backup.sh" >/dev/null 2>&1; then
  echo "Backup accepted a failed off-site transfer." >&2
  exit 1
fi
offsite_sets=("$BACKUP_REMOTE"/backup-*)
complete_markers=("$BACKUP_REMOTE"/backup-*/.complete)
[[ "${#offsite_sets[@]}" == 2 && "${#complete_markers[@]}" == 1 ]]
echo "Encrypted backup round trip and fail-closed checks passed."
