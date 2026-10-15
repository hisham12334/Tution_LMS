# Tution LMS VPS deployment

This runbook deploys the existing React/Vite client, Express + Better Auth API, and PostgreSQL on one Ubuntu VPS. Nginx is the only public application service. PostgreSQL and the API have no published host ports. Uploaded objects stay in the private Cloudflare R2 bucket; only PostgreSQL is included in backups.

## Repository audit and deployment decisions

- Production client entry: `app/src/main.tsx`; `app/` builds with `npm ci && npm run build`. Node 22 is used for reproducible Docker builds (the packages do not declare an `engines` field).
- API entry: `api/src/server.ts`; TypeScript builds with `npm ci && npm run build`, then starts with `node dist/server.js`. It uses Express 5, `pg`, Better Auth, AWS SDK S3 client, and Nodemailer.
- The database schema is `api/migrations/001_initial.sql` through `006_chat.sql`; `api/src/migrate.ts` runs ordered SQL files with a transaction and advisory lock. Deployment deliberately invokes the compiled migration command explicitly before serving a release.
- Better Auth uses PostgreSQL sessions, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `APP_ORIGIN` as its trusted origin. Same-origin Nginx routing keeps cookies first-party. With HTTPS URLs, Better Auth should issue secure cookies; verify this in browser developer tools at cutover. No cookie domain override is configured, so cookies remain host-only. Keep the site on one canonical hostname.
- API writes reject requests whose `Origin` differs from `APP_ORIGIN`; Better Auth also receives its configured base URL and trusted origin. Use the exact public origin including `https://`, with no trailing slash. Reset and invitation links derive from `APP_ORIGIN`.
- R2 is implemented in `api/src/storage.ts` using short-lived signed URLs. Local disk fallback is development-only. R2 credentials and SMTP variables are server-side; `VITE_API_BASE_URL` remains empty for same-origin production.
- `GET /api/health` checks PostgreSQL. R2 CORS requirements are documented in `api/r2-cors.example.json`; change its origin to the final HTTPS site and permit `GET`, `HEAD`, and `PUT`, exposing `ETag`.
- The API runs hourly material retention cleanup. `db:cleanup-uploads` removes abandoned drafts but is not scheduled automatically here; enable it only after verifying it against the selected live data/retention policy. There are no other scheduled services in the repository.
- There are no tests configured in either package. Root `index.html` is an old prototype; deploy `app/` only. Netlify config is for existing hosting and is not used by this Compose setup.
- The brief says PostgreSQL is on Render, while repository migration history and docs mention Supabase. The live source provider, schema version, data, and account/file inventory cannot be established from this checkout. Treat source inventory and a verified export as a production blocker. Never point the migration commands at the old database.

The Compose configuration builds a static Nginx client and a non-root Node API image. PostgreSQL uses a named volume, health checks, and an internal-only database network shared only with the API; Nginx and the API share a separate frontend network. API migrations are not run on startup. The backup host script creates custom-format dumps, checks the archive, encrypts with `age`, uploads through a separately configured `rclone` remote, downloads/verifies the uploaded object, then applies 7-day daily and 28-day weekly retention. Keep the age private identity and rclone credentials out of the application `.env` and off the VPS where possible.

## 1. VPS prerequisites

Use an Ubuntu LTS VPS with a static public IPv4 address, at least 2 vCPU, 4 GB RAM, and enough disk for the database plus temporary restore/maintenance space. Choose an owner-controlled domain and determine the final canonical hostname before issuing certificates. Do not share the live VPS with untrusted workloads.

## 2. Ubuntu preparation

Run on the Ubuntu VPS as an SSH user with sudo:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y ca-certificates curl git ufw fail2ban certbot age rclone postgresql-client util-linux
sudo timedatectl set-timezone UTC
```

Create a non-root deployment user if needed, install its SSH public key, and disable password SSH only after confirming key login works in a second session. Keep SSH restricted to trusted admin addresses where practical.

## 3. Docker installation

Install Docker Engine and the Compose plugin from Docker's official Ubuntu apt repository, following its current Ubuntu instructions. Then verify:

```bash
docker --version
docker compose version
sudo systemctl enable --now docker
```

Add the deployment user to the `docker` group only if you accept that Docker group membership grants root-equivalent control. Otherwise run Docker commands with `sudo`.

## 4. Firewall and SSH

On the VPS, substitute your SSH port if it is not 22:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Do not add firewall rules for 3001 or 5432. Those ports are private to the Compose network.

## 5. DNS and HTTPS

At your DNS provider, create an `A` record for the chosen hostname pointing at the VPS address. Wait until public DNS resolves correctly. On the VPS, temporarily stop any service bound to port 80, then issue a certificate:

```bash
sudo certbot certonly --standalone --agree-tos --no-eff-email --email ADMIN_EMAIL -d YOUR_DOMAIN
```

Replace `ADMIN_EMAIL` and `YOUR_DOMAIN` with values you control. Renewals use Certbot's systemd timer and standalone challenge, so Nginx must briefly release port 80. Install pre/post hooks to stop and restart only the web container around renewal:

```bash
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
sudo install -m 755 ops/certbot-pre-renew.sh /etc/letsencrypt/renewal-hooks/pre/stop-tution-lms
sudo install -m 755 ops/certbot-post-renew.sh /etc/letsencrypt/renewal-hooks/post/start-tution-lms
sudo certbot renew --dry-run
```

The post-hook starts Nginx with the renewed certificate mounted from `/etc/letsencrypt`. Nginx's port 80 listener redirects normal traffic to HTTPS.

## 6. Production environment

On the VPS, clone this repository to `/opt/tution-lms`, checkout the approved release commit, and create the root `.env` from the tracked example:

```bash
sudo mkdir -p /opt/tution-lms
sudo chown "$USER":"$USER" /opt/tution-lms
cd /opt/tution-lms
git clone YOUR_REPOSITORY_URL .
git checkout APPROVED_COMMIT
cp .env.example .env
chmod 600 .env
```

Set `DOMAIN`, `APP_ORIGIN=https://DOMAIN`, `BETTER_AUTH_URL=https://DOMAIN`, and all PostgreSQL, R2, SMTP, and backup values in `.env`. `DATABASE_URL` must match the PostgreSQL user/password/database. Generate URL-safe PostgreSQL credentials and the Better Auth secret on the VPS:

```bash
openssl rand -hex 32
openssl rand -base64 48
```

Use the first output as `POSTGRES_PASSWORD` (64 hex characters) and the identical password in `DATABASE_URL`; use the second output as `BETTER_AUTH_SECRET`. Never commit `.env` or paste secret values into logs or tickets. `SMTP_FROM` must use the verified sending domain. Keep backup destination credentials in root-owned `rclone` configuration, and use an age public recipient in `.env`; keep the matching private identity offline or in a separate secure location.

Check the placeholders are gone without printing their values:

```bash
grep -n 'REPLACE_WITH' .env
```

No output is expected. The Compose file requires `DOMAIN`, `POSTGRES_PASSWORD`, and the `.env` file. Server-only values are not compiled into Vite assets.

## 7. Initialize PostgreSQL schema

Start only PostgreSQL and wait for readiness:

```bash
docker compose up -d db
docker compose ps
```

Build the API image and deliberately apply the checked-in migrations before exposing the web service:

```bash
docker compose build api
docker compose run --rm api node dist/migrate.js
```

Migration execution is repeatable; inspect output and logs. It is not part of API startup. For an existing source database, follow section 8 instead of initializing an empty database blindly.

## 8. Safe migration from the existing database

First confirm whether the actual source is Render PostgreSQL, Supabase PostgreSQL, or another database. Record the source schema/migration state, table names, counts for `"user"`, `profiles`, cohorts, courses, enrollments, sessions, attendance, package plans, student packages, payments, and invitations; record constraints/indexes and sequence state. Inventory storage keys and R2 objects separately. Do not copy live environment files into Git.

On the Windows development machine (PowerShell), set the source URL in the current shell without writing it to a file, then create and inspect a custom-format dump using a locally installed PostgreSQL client:

```powershell
pg_dump --password --format=custom --no-owner --no-acl --dbname "postgresql://DB_USER@DB_HOST:5432/DB_NAME?sslmode=require" --file .\source-before-cutover.dump
pg_restore --list .\source-before-cutover.dump
```

Use the provider's secure connection guidance and TLS settings. Prefer a provider-native snapshot plus `pg_dump` if the database is large. Encrypt the export before transferring it; for example, with `age` and a public recipient kept separately from the off-server backup's private identity:

```powershell
age --encrypt --recipient age1YOUR_PUBLIC_RECIPIENT --output .\source-before-cutover.dump.age .\source-before-cutover.dump
```

Do not put database credentials directly on a command line.

Transfer the encrypted dump to the VPS over SSH/SCP and verify its checksum. Before restoring, take an independent source backup and confirm the VPS target is a fresh, separate database. Stop the new API/web services. Never restore into the existing source database. For a source dump that includes schema, first test it in a separate database:

```bash
docker compose stop web api
docker compose exec -T db createdb -U tution_lms tution_lms_import
age --decrypt --identity /secure/path/migration-age-identity.txt /secure/path/source-before-cutover.dump.age | docker compose exec -T db sh -ec 'pg_restore -U "$POSTGRES_USER" -d tution_lms_import --exit-on-error --no-owner --no-acl'
docker compose exec -T db psql -U tution_lms -d tution_lms_import -c 'select count(*) from profiles'
```

Use the configured PostgreSQL role names instead of the examples. `age` must be installed on the VPS. Reconcile the restored schema against `api/migrations/` and application expectations, then compare counts for the important tables listed above, constraints/indexes, and related UUIDs. Repeat count queries against the source and restored target. The migration runner's `CREATE TABLE IF NOT EXISTS` behavior does not prove that an existing table has compatible columns or constraints; inspect every pending SQL change first. If source schema is compatible and validation passes, update the private `.env` `DATABASE_URL` database component to `tution_lms_import`, then run `docker compose run --rm api node dist/migrate.js` against that new target. Run the application only against the validated target. If the schemas differ, write and review a data mapping/import plan before touching the target. Never drop tables or use `--clean` against a live database.

Compare important record counts, UUID relationships, orphan rows, unique constraints, indexes, and sequence/default behavior between source and restored target. Run application acceptance checks with separate admin, teacher, and student accounts. Keep the old database available and unchanged through validation and the rollback window. Do not dual-write. Only change DNS/traffic after explicit operator cutover approval. This repository has no live database credentials, so no migration or live record count has been run here.

## 9. Initial application deployment

After TLS certificate, environment, and schema are ready:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 api web
curl --fail https://YOUR_DOMAIN/api/health
```

The health response must be HTTP 200 with `database: ready`. Confirm the API and PostgreSQL have no host-published ports (`docker compose ps` lists only the web service ports).

## 10. Administrator bootstrap

For a brand-new, empty database only, the existing one-time mechanism is `api/src/bootstrap-admin.ts`. If migration already brought over administrator accounts, do not bootstrap a second one. For an empty database, temporarily add `BOOTSTRAP_ADMIN=true`, `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` to the private `.env`, then:

```bash
docker compose run --rm api node dist/bootstrap-admin.js
```

Immediately remove all four bootstrap/admin variables from `.env`, then recreate the API container so its environment is clean:

```bash
docker compose up -d --force-recreate api
```

Confirm `BOOTSTRAP_ADMIN` is absent and `NODE_ENV=production`. Normal production signup is disabled when that variable is absent. Never leave bootstrap mode enabled. Do not use `db:seed-demo` in production.

## 11. Mailtrap configuration

Configure the Mailtrap sending domain, verify ownership, and publish the exact SPF and DKIM DNS records shown by Mailtrap; add a DMARC record appropriate to your domain policy. Wait for Mailtrap to mark the domain verified. Set the Mailtrap production SMTP host, port, username, password, and a `SMTP_FROM` address on that domain. This application sends invite/reset links through the existing Better Auth email callback. Send a real test invitation and password reset only after the domain is verified; ensure links use the canonical HTTPS hostname. SMTP and DNS were not tested from this environment.

## 12. Cloudflare R2 configuration

Create a private bucket and scoped S3 credentials with only required bucket/object permissions. Set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the VPS `.env`. Do not configure a public bucket URL. Set bucket CORS to the final site origin; use `api/r2-cors.example.json` as the basis, replacing `http://localhost:5173` with `https://YOUR_DOMAIN`. Allow `PUT`, `GET`, and `HEAD` as needed by signed upload/download operations and expose `ETag` for multipart upload completion. Test authorized upload, unauthorized access denial, and signed download expiry. The app checks authorization before issuing signed links; R2 URLs are short-lived. No R2 account or object was tested here.

## 13. Automated database backups

Configure the host's separate `rclone` remote and age encryption recipient. Keep the age private key offline or in a separate secure system. Put `BACKUP_RCLONE_REMOTE` and `BACKUP_AGE_RECIPIENT` in `/etc/tution-lms-backup.conf`, owned by root with mode 600; configure `rclone` in `/etc/rclone/tution-lms.conf`, also root-only. The systemd service points to that file. These credentials are separate from application credentials. Create protected backup storage:

```bash
sudo install -d -m 700 /var/backups/tution-lms
sudo install -m 750 ops/backup-postgres.sh /usr/local/sbin/tution-lms-backup
sudo install -m 600 ops/tution-lms-backup.conf.example /etc/tution-lms-backup.conf
sudoedit /etc/tution-lms-backup.conf
sudo install -d -m 700 /etc/rclone
sudo rclone config --config /etc/rclone/tution-lms.conf
sudo chmod 600 /etc/rclone/tution-lms.conf
sudo install -m 644 ops/tution-lms-backup.service /etc/systemd/system/tution-lms-backup.service
sudo install -m 644 ops/tution-lms-backup.timer /etc/systemd/system/tution-lms-backup.timer
```

Set up a systemd service and timer (recommended over cron) that runs `/usr/local/sbin/tution-lms-backup` daily, after Docker is available. Enable and inspect it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tution-lms-backup.timer
systemctl list-timers tution-lms-backup.timer
sudo systemctl start tution-lms-backup.service
sudo journalctl -u tution-lms-backup.service --since today
```

The service needs access to Docker and `/opt/tution-lms/.env`; use a dedicated root-owned systemd unit with restrictive permissions. Schedule at a quiet time. The script uses `flock`, custom-format `pg_dump`, `pg_restore --list`, `age`, `rclone copyto`, and `rclone check --download`. It logs failure to syslog/journal and supports an optional root-managed `BACKUP_ALERT_COMMAND`; connect that hook to your monitoring/alert channel. Do not place alert credentials in the application environment. Daily remote backups older than 7 days and weekly Sunday backups older than 28 days are pruned only after the new daily upload is read back successfully. Monitor the timer's last success and off-server capacity. A dump succeeding is not proof of recovery.

For future point-in-time recovery, add WAL archiving and base backup tooling to a separate off-server destination with retention and restore testing; this setup currently provides logical dumps only.

## 14. Restore test

Periodically download an encrypted backup from the off-server destination, decrypt it with the separately held age identity, and restore it into a new test database using `ops/restore-test-postgres.sh`. The helper never targets the live database; it creates `tution_lms_restore_test` and leaves it for review. Inspect table counts, core relationship queries, and application startup against that test database. Drop the test database only after recording the result and confirming the live database was not selected. Test recovery from a backup copied off the VPS, not only a local artifact.

## 15. Updating after a Git commit

On the VPS, preserve the currently deployed commit and check for migrations before rollout:

```bash
cd /opt/tution-lms
git fetch --prune
git checkout APPROVED_COMMIT
docker compose build
docker compose run --rm api node dist/migrate.js
docker compose up -d
docker compose ps
curl --fail https://YOUR_DOMAIN/api/health
```

Review pending migration SQL and take/verify a fresh off-server backup before applying any schema change. The app has no multi-version orchestration; this is a brief single-VPS maintenance rollout.

## 16. Application rollback

Checkout the previous known-good application commit, rebuild and restart. Do not roll back a database migration automatically. Confirm that the previous code remains compatible with the current schema; restore a database snapshot only after a deliberate recovery decision and into a separate validation database first.

## 17. Troubleshooting

- **Web container will not start:** verify `DOMAIN` is set and `/etc/letsencrypt/live/DOMAIN/fullchain.pem` and `privkey.pem` exist and are readable.
- **API unhealthy:** check `docker compose logs api db`, `.env` presence, `DATABASE_URL`, PostgreSQL health, and that migrations were applied deliberately.
- **Login/cookie loops:** use the same canonical HTTPS host for `APP_ORIGIN` and `BETTER_AUTH_URL`; inspect cookie `Secure`, `HttpOnly`, `SameSite`, domain, and browser console/network requests. Avoid mixing IP, www, and apex names.
- **403 on API writes:** confirm the browser Origin exactly matches `APP_ORIGIN` including scheme and hostname.
- **Invitation/reset emails fail:** verify Mailtrap domain state, SMTP endpoint/credentials/from address, and DNS SPF/DKIM/DMARC. Logs intentionally return generic API errors; inspect protected server logs.
- **R2 upload/download fails:** verify account ID, bucket, scoped key permissions, CORS origin/methods/ETag exposure, server time, and signed URL expiry.
- **Backup service fails:** inspect `journalctl -u tution-lms-backup.service`, Docker availability, age recipient validity, rclone remote configuration, network access, and remote free space. Never delete the last good remote backup to make room before a new verified copy exists.

## 18. VPS loss and disaster recovery

Provision a clean Ubuntu VPS, secure SSH/firewall, install Docker and the required host tools, restore the repository at the approved commit, configure DNS/TLS and private `.env`, then create PostgreSQL. Retrieve the latest verified off-server encrypted backup and the separately stored age private key. Decrypt and restore into a new database, validate counts, indexes/constraints, relationships and sequences, then run application checks. Restore R2 credentials separately; R2 objects are intentionally outside the backup scope and must remain available in the original account. Perform the documented restore test before pointing DNS to the replacement VPS. If R2 objects or the off-server backup/key are unavailable, the corresponding data cannot be recovered from this deployment.

## Local validation limitations

Run `npm ci && npm run build` in `app/` and `api/` on a development machine with Node 22. Run `docker compose config` and Docker builds only after Docker Engine is available. This repository does not configure automated tests. No Docker daemon, live source database, R2 bucket, Mailtrap account, or production VPS is assumed available to this runbook, so those integrations require operator validation.
