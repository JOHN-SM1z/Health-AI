#!/usr/bin/env bash
# Local upgrade rehearsal: rebuild the schema as it is IN PRODUCTION, load realistic volume,
# then apply every pending migration in order — each in its own transaction, timed — and run
# the structural checks. LOCAL Supabase (Docker) only; never touches a remote project.
#
#   scripts/rehearse-upgrade.sh [PRODUCTION_VERSION]
#
# PRODUCTION_VERSION is the last migration the remote project has applied (default
# 20260930000006 — read it from the project's migration list, do not guess). Re-run
# `npm run db:reset-local` afterwards to get the normal development database back.
set -euo pipefail

PROD_VERSION="${1:-20260930000006}"
DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1 || true)"
[ -n "$DB_CONTAINER" ] || { echo "local Supabase is not running (supabase start)"; exit 1; }
cd "$(dirname "$0")/.."

psql_local() { docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

echo "== 1. schema as in production ($PROD_VERSION)"
npx supabase db reset --local --version "$PROD_VERSION" >/dev/null 2>&1

echo "== 2. synthetic volume"
psql_local < scripts/rehearsal/volume.sql | grep -E "^ +[0-9]|ERROR" || true

echo "== 3. pending migrations, in order (seconds = time the tables are locked)"
for file in $(ls supabase/migrations | awk -F_ -v v="$PROD_VERSION" '$1 > v'); do
  version="${file%%_*}"; name="${file#*_}"; name="${name%.sql}"
  start=$(date +%s)
  if ! { printf 'begin;\n'; cat "supabase/migrations/$file"; printf "insert into supabase_migrations.schema_migrations (version, name) values ('%s','%s');\ncommit;\n" "$version" "$name"; } | psql_local >/dev/null 2>/private/tmp/rehearsal-error.txt; then
    echo "FAILED  $file"; cat /private/tmp/rehearsal-error.txt; exit 1
  fi
  printf '%-62s %4ss\n' "$file" "$(( $(date +%s) - start ))"
done

echo "== 4. structural checks (every count must be 0)"
psql_local < scripts/rehearsal/verify.sql | grep -v '^$\|rows)\|Output format'
echo "== done — now: npm run db:reset-local && npm run create-owner, or run the suite against this populated database"
