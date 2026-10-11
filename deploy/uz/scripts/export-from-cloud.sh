#!/bin/sh
# Export the production database from Supabase Cloud for the move to the Uzbekistan server.
# Runs on the owner's Mac, with the project linked once (npx supabase link --project-ref cpoiachyfozjnlguaykz in
# LINK_DIR). Writes roles, schema, data and the migration history into OUT_DIR, mode 600 (patient data inside).
#
#   sh deploy/uz/scripts/export-from-cloud.sh ~/HealthAI-backups/prod-link ~/HealthAI-backups/move-to-uz
set -eu
LINK_DIR="$1"
OUT_DIR="$2"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
npx supabase db dump --linked --workdir "$LINK_DIR" --role-only -f "$OUT_DIR/roles.sql"
npx supabase db dump --linked --workdir "$LINK_DIR" -f "$OUT_DIR/schema.sql"
npx supabase db dump --linked --workdir "$LINK_DIR" --data-only --use-copy -f "$OUT_DIR/data.sql"
npx supabase db dump --linked --workdir "$LINK_DIR" --data-only --use-copy --schema supabase_migrations -f "$OUT_DIR/history.sql"
chmod 600 "$OUT_DIR"/*.sql
ls -l "$OUT_DIR"
echo "Copy to the server: scp -r $OUT_DIR <user>@<server>:/opt/healthai/import"
