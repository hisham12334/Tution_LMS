# Astute Academy — tuition and classroom platform

The connected application is in `app/`; the root `index.html` is an older visual prototype. Current roles, workflows, and data model are described in [ARCHITECTURE.md](ARCHITECTURE.md). The backend migration acceptance criteria are in [MIGRATION.md](MIGRATION.md).

## Current app behavior

Admins invite students and teachers, configure cohorts/courses, assign teachers, enroll students, define class packages, and confirm payments. Teachers schedule classes, record attendance, upload and publish recordings or reading material, and review student progress. Students see published material and scheduled classes, mark lessons complete, and see progress and package status. Payment due does not block access.

The frontend now uses an HTTP service boundary in `app/src/data.ts`. The API lives in `api/` and uses Better Auth cookie sessions and PostgreSQL. Production files use private Cloudflare R2 storage; local development automatically uses private files under `api/private-storage/` when R2 credentials are absent. Published materials and their completion history are permanently removed 20 days after publication; teachers and admins can permanently delete materials sooner. API routes derive the actor from the server-validated session. Assignments, grading, and notifications are outside this migration.

## Local staging setup

1. Create a PostgreSQL database and copy `api/.env.example` to `api/.env`. Configure `DATABASE_URL`, a random 32+ character `BETTER_AUTH_SECRET`, and `APP_ORIGIN`. Keep these secrets on the API server.
2. For local development, file uploads work without a cloud account and are stored privately under `api/private-storage/`. For production, configure a private R2 bucket and its CORS rules for the app origin to permit `PUT` and expose the `ETag` response header; the API issues short-lived upload and download URLs.
3. From `api/`, install dependencies, run `npm run db:migrate`, then create the first admin with `BOOTSTRAP_ADMIN=true`, `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` set for the one-time `npm run db:bootstrap-admin` command. Remove those environment variables before starting the API. The bootstrap uses Better Auth password handling; it does not create passwords or hashes itself.
4. Start the API with `npm run dev` in `api/`. In another terminal, run `npm install` and `npm run dev` in `app/`; Vite proxies `/api` to `http://localhost:3001`.
5. The running API checks for published materials past the 20-day retention period every hour and deletes their files and database records. Run `npm run db:cleanup-materials` from `api/` for an immediate cleanup. Schedule `npm run db:cleanup-uploads` to remove draft uploads older than 24 hours; configure an R2 lifecycle rule to abort old incomplete multipart uploads in production.

For a production deployment, put the frontend and API behind the same site origin (or a reverse proxy) so the Better Auth HttpOnly cookie remains first-party. Configure SMTP for invitation and password reset emails, set the R2 bucket CORS origin to the deployed site, and keep database/R2/Auth secrets server-side. The repository does not contain staging or production credentials.

## Migration and cutover

The API schema is versioned in `api/migrations/`. Existing Supabase migrations are retained as source schema/history. No live Supabase project or credentials are present, so this repository cannot establish whether production data exists. Before production cutover, inventory the source accounts, UUIDs, records, and files; back up and reconcile any live data; validate the workflows in staging with distinct roles; then cut over with the old project available for rollback. Do not dual-write.

See [MIGRATION.md](MIGRATION.md) for acceptance checks and [ARCHITECTURE.md](ARCHITECTURE.md) for the original product architecture.

## Prototype

The root `index.html` can still be opened independently for visual review. Its role switch and sample values are prototype interactions, not production authorization.
