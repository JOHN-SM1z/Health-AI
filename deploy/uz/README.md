# Health AI on a server in Uzbekistan (healthai.uz)

**Today:**
- the app runs on Vercel (USA): `health-ai-w1vc.vercel.app`;
- the database runs on Supabase Cloud (Tokyo).

**After this move, everything runs on one server in a data centre in Uzbekistan, behind `healthai.uz`:**

| Address | What |
|---|---|
| `https://healthai.uz` | Website for clinics, staff panels, patients' Telegram Mini App (one Next.js server) |
| `https://api.healthai.uz` | Supabase gateway for the browser: login, REST, files |
| — (SSH tunnel only) | Postgres, Supabase Studio. Never exposed to the internet. |

Patient data, staff accounts and audit records then never leave Uzbekistan. Telegram's own servers still deliver
messages, as with any Telegram bot.

**The production database is small:** 21 MB, and no stored files yet. The move itself takes about 30 minutes.

---

## 1. What to get

| Item | Minimum | Notes |
|---|---|---|
| **Server** (VPS or dedicated) | 4 vCPU, 8 GB RAM, 100 GB NVMe, Ubuntu 24.04 LTS, one public IPv4 | In a data centre physically in Uzbekistan. Ask the provider in writing where the data is stored. |
| **Second machine for backups** | 50 GB disk, any provider in Uzbekistan, SSH access | A different building or provider from the server. |
| **DNS access** for `healthai.uz` | At your .uz registrar or DNS host | |
| **SSH key login** to the server | — | Password login switched off. |

Send me the server's IP address and a sudo user (SSH key), and I can run every step below. Otherwise your
administrator follows them as written.

## 2. DNS (do this first, it takes time to spread)

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `healthai.uz` (@) | server IPv4 | 300 |
| A | `www` | server IPv4 | 300 |
| A | `api` | server IPv4 | 300 |
| CAA | `healthai.uz` | `0 issue "letsencrypt.org"` | 3600 |

Check with `dig +short healthai.uz api.healthai.uz` from your Mac before section 5.

## 3. Prepare the server (as root, once)

```bash
apt update && apt -y upgrade
apt -y install ca-certificates curl git ufw fail2ban unattended-upgrades postgresql-client rsync
timedatectl set-timezone Asia/Tashkent
# Firewall: SSH and web only. Postgres (5432), Kong (8000), Studio (3000) stay closed.
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable
# SSH: keys only
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl reload ssh
# Docker (official repository)
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/healthai/secrets && chmod 700 /opt/healthai/secrets
# The Health AI repository (its deploy/uz kit is used from here on)
git clone https://github.com/JOHN-SM1z/Health-AI /opt/healthai/app
```

## 4. Supabase (self-hosted, same versions as production)

```bash
cd /opt/healthai
git clone --depth 1 https://github.com/supabase/supabase supabase-src
cp -r supabase-src/docker supabase && cd supabase
cp .env.example .env && chmod 600 .env
```

**Pin the images to the versions production runs.** Then the login data and file metadata restore exactly. In
`docker-compose.yml`, set:

| Service | Image |
|---|---|
| `db` | `supabase/postgres:17.6.1.155` |
| `auth` | `supabase/gotrue:v2.197.0` |
| `rest` | `postgrest/postgrest:v14.5` |
| `storage` | `supabase/storage-api:v1.80.2` |

(Production's versions are in `~/HealthAI-backups/prod-link/supabase/.temp/*-version`. Re-check them on the day of
the move.)

**Remove services Health AI does not use** from `docker-compose.yml`: `realtime`, `functions`, `analytics`, `vector`,
`supavisor`. Also remove `analytics` from every other service's `depends_on`.

**Close the ports:**
- In the `kong` service, delete the `ports:` lines; Caddy reaches Kong inside the server.
- Studio: change its port mapping to `127.0.0.1:3000:3000`.

**Keys and settings.** Generate them with the kit's script. It runs in a throw-away Node container, so the
server needs no Node, and it never prints the keys:

```bash
docker run --rm -v /opt/healthai:/opt/healthai node:22-slim \
  node /opt/healthai/app/deploy/uz/scripts/generate-keys.mjs /opt/healthai/secrets/supabase-keys.env
```

Copy those values into `/opt/healthai/supabase/.env`:
- `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`;
- `POSTGRES_PASSWORD`, `DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`.

Then set:

```
SITE_URL=https://healthai.uz
API_EXTERNAL_URL=https://api.healthai.uz
SUPABASE_PUBLIC_URL=https://api.healthai.uz
DISABLE_SIGNUP=true                 # accounts are created by the server only
ENABLE_EMAIL_AUTOCONFIRM=true
DASHBOARD_USERNAME=healthai
GOTRUE_PASSWORD_MIN_LENGTH=12       # add to the auth service's environment if not in .env
```

Start it and wait until every container is healthy:

```bash
docker compose up -d && docker compose ps
```

## 5. The app

```bash
cd /opt/healthai/app/deploy/uz
cp app.env.example app.env && chmod 600 app.env
```

Fill in `app.env`:
- the anon and service keys from `/opt/healthai/secrets/supabase-keys.env`;
- new random values (`openssl rand -hex 32`) for `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET`;
- the owner and Telegram admin settings.

Then build and start:

```bash
docker compose --env-file app.env up -d --build
curl -s https://healthai.uz/api/health   # {"status":"ok",...} once DNS and the certificate are in place
```

The app refuses to start when a required secret is missing or a half configuration is set (`src/instrumentation.ts`).
`docker compose logs app` says which.

## 6. Rehearsal (a day before; nothing changes for patients)

1. On the Mac, export production:

   ```bash
   sh deploy/uz/scripts/export-from-cloud.sh ~/HealthAI-backups/prod-link ~/HealthAI-backups/move-rehearsal
   ```

   Then copy it to the server: `scp -r ~/HealthAI-backups/move-rehearsal <user>@<ip>:/opt/healthai/import`.
2. On the server:

   ```bash
   sh /opt/healthai/app/deploy/uz/scripts/import-on-server.sh /opt/healthai/import /opt/healthai/app/deploy/uz/app.env
   ```

   Compare the printed counts with production.
3. Check `https://healthai.uz`:
   - landing page, `/login` with a staff login, `/platform`, reception;
   - the Mini App with a **separate test bot** (BotFather → new bot), never `@Health_AI_uz_bot` during the rehearsal.
4. Reset for the real move (`docker compose down -v` in `/opt/healthai/supabase`, then section 4's `up -d`).
   Delete `/opt/healthai/import`.

## 7. The move (one evening, about 30 minutes)

| Step | Where | Action |
|---|---|---|
| 1 | — | Tell the clinics: 30 minutes, e.g. 22:00–22:30, no bookings. |
| 2 | Supabase Cloud SQL editor | Stop the cloud scheduler so it can no longer send reminders: `select cron.unschedule(jobname) from cron.job where jobname like 'health-ai-%';` |
| 3 | Mac | Export (section 6, step 1) into `~/HealthAI-backups/move-final`, then scp it to the server. |
| 4 | Server | Import (section 6, step 2). |
| 5 | Server | Compare the counts with production. **They must be equal.** |
| 6 | Server | `cd /opt/healthai/app/deploy/uz && docker compose --env-file app.env exec app node scripts/sync-telegram-bots.mjs` — every clinic bot's webhook and menu button now point at healthai.uz. |
| 7 | BotFather | For `@Health_AI_uz_bot` → Bot Settings → Configure Mini App: set the URL to `https://healthai.uz/book`. |
| 8 | Phone | Open the bot. The passport/ID screen comes first; book a test visit; reception sees it on `https://healthai.uz/admin/reception`. |
| 9 | Vercel | Pause project health-ai-w1vc (Settings → General → Pause), so no second copy of the app can reach the cloud database. Keep it paused for 2 weeks as the rollback, then delete it. |
| 10 | Server | Install the nightly backup (section 8). |

**Rollback** (if step 5 or 8 fails):
1. Unpause Vercel.
2. In the cloud SQL editor, re-run `supabase/ops/scheduled-jobs.sql`.
3. On the Mac, run `npm run sync-telegram-bots` with `NEXT_PUBLIC_APP_URL=https://health-ai-w1vc.vercel.app` and the cloud settings in `.env`. The webhook secret must be Vercel's `TELEGRAM_WEBHOOK_SECRET`; if it isn't known, set a new one in Vercel first and use that.
4. Change the BotFather Mini App URL back.

Nothing is lost: the cloud database was not changed after step 2.

**After the move, update the addresses registered elsewhere:**
- OneID callback: `https://healthai.uz/api/oneid/callback` (`docs/oneid-ariza.md`);
- Eskiz delivery reports;
- the privacy policy's contact page.

## 8. Backups (non-negotiable on your own server)

```bash
install -m 700 /opt/healthai/app/deploy/uz/scripts/backup.sh /usr/local/bin/healthai-backup
( crontab -l 2>/dev/null; echo '17 2 * * * BACKUP_REMOTE=backup@<second-machine>:/srv/healthai /usr/local/bin/healthai-backup >> /var/log/healthai-backup.log 2>&1' ) | crontab -
```

- Every night at 02:17: a full database dump and the stored files.
- 14 days are kept on the server and copied to the second machine.

**Once a month, test a restore:**
- create a scratch database with `docker exec supabase-db createdb -U postgres restore_check`;
- run `pg_restore -d restore_check` on the latest dump;
- count patients;
- drop the database.

## 9. Running it

| Task | How |
|---|---|
| **Update the app** | `cd /opt/healthai/app && git pull && docker compose -f deploy/uz/docker-compose.yml --env-file deploy/uz/app.env up -d --build`. Database migrations go first, following `docs/PILOT_RUNBOOK.md` (backup, rehearsal, apply by name). |
| **Studio** (database browser) | From the Mac: `ssh -L 3000:127.0.0.1:3000 <user>@<ip>`, then open `http://localhost:3000`. |
| **Logs** | `docker compose logs -f app`; Caddy and Supabase the same way in their directories. |
| **Uptime** | An external monitor (e.g. UptimeRobot) on `https://healthai.uz/api/health` every minute, alerting by Telegram/SMS. |
| **OS updates** | `unattended-upgrades` applies security fixes. Reboot monthly in a quiet hour. |
| **Certificates** | Caddy renews them by itself. |

## 10. Security checklist

- [ ] Only ports 22, 80 and 443 are open (`ufw status`); SSH by key only; fail2ban running.
- [ ] `app.env`, `supabase/.env` and `/opt/healthai/secrets/*` are mode 600, owned by root, and not in git.
- [ ] Postgres, Kong and Studio are not reachable from outside: `nc -vz <ip> 5432 8000 3000` from the Mac must fail.
- [ ] `select count(*) from internal.retention_override` is **0** (the history guard is on).
- [ ] Backups run, reach the second machine, and the monthly restore test passes.
- [ ] Vercel is paused and the cloud scheduler is unscheduled, so no second copy of the app is running.
