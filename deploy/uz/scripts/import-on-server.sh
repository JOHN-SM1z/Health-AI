#!/bin/sh
# Import the exported production database into the self-hosted Supabase on the Uzbekistan server, then point the
# scheduler at healthai.uz. Run on the server, AFTER the Supabase stack is up (same service versions as production:
# README.md) and BEFORE the app takes traffic.
#
#   sh deploy/uz/scripts/import-on-server.sh /opt/healthai/import /opt/healthai/app/deploy/uz/app.env
#
# Stops at the first error. Prints counts only, never data or secrets.
set -eu
IN="$1"
APP_ENV="$2"
DB=supabase-db
psql_db() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "1/6 roles";   psql_db < "$IN/roles.sql" > /dev/null 2>&1 || true   # roles that already exist are fine
echo "2/6 schema";  psql_db < "$IN/schema.sql" > /dev/null
echo "3/6 data"
{ echo "set session_replication_role = replica;"; cat "$IN/data.sql"; } | psql_db > /dev/null
echo "4/6 migration history"
{
  echo "create schema if not exists supabase_migrations;"
  echo "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
  echo "set session_replication_role = replica;"
  cat "$IN/history.sql"
} | psql_db > /dev/null

echo "5/6 scheduler → https://healthai.uz"
CRON_SECRET=$(grep '^CRON_SECRET=' "$APP_ENV" | cut -d= -f2-)
[ -n "$CRON_SECRET" ] || { echo "CRON_SECRET is empty in $APP_ENV"; exit 1; }
# The secret goes into Vault through stdin, never on a command line. A secret copied from the cloud is encrypted
# with the cloud's key and unreadable here: it is replaced.
printf "delete from vault.secrets where name = 'health_ai_cron_secret';\nselect vault.create_secret('%s', 'health_ai_cron_secret', 'CRON_SECRET of the app on healthai.uz');\n" "$CRON_SECRET" | psql_db > /dev/null
sed "s#v_app_url constant text := '[^']*';#v_app_url constant text := 'https://healthai.uz';#" "$(dirname "$0")/../../../supabase/ops/scheduled-jobs.sql" | psql_db > /dev/null

echo "6/6 checks"
docker exec "$DB" psql -U postgres -d postgres -At -c "
  select 'clinics=' || (select count(*) from public.clinics)
      || ' patients=' || (select count(*) from public.patients)
      || ' appointments=' || (select count(*) from public.appointments)
      || ' payments=' || (select count(*) from public.payments)
      || ' staff_accounts=' || (select count(*) from auth.users)
      || ' migrations=' || (select count(*) from supabase_migrations.schema_migrations)
      || ' retention_override=' || (select count(*) from internal.retention_override)
      || ' cron_jobs=' || (select count(*) from cron.job where jobname like 'health-ai-%');"
echo "Compare the counts with production before switching (README.md, cut-over step 5)."
