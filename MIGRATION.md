# Backend migration acceptance criteria

This document records the behavior that must remain true while the connected app moves from Supabase Auth, direct browser database access, and Supabase Storage to an authenticated API. The app in `app/` is the production frontend; the root `index.html` is a visual prototype.

## Product scope

Keep the current admin, teacher, and student screens and workflows. Preserve invitation-only accounts, email/password sign-in, and the current package/payment behavior. Assignments, submissions, grading, and notifications remain outside this migration because they are not implemented in the current app or schema.

## Acceptance criteria

### Authentication and sessions

- An invited student or teacher can use the emailed setup link to set a password and then sign in with email and password.
- Admin invitation creates no open registration path. Only an authenticated admin can invite student and teacher accounts.
- Password reset returns a non-enumerating response and allows the account owner to set a replacement password through a single-use, expiring link.
- Session renewal and logout use server-managed sessions. An unauthenticated request cannot access the centre API.
- The server resolves the acting user from the session on every request. Client-supplied `adminId`, `teacherId`, or `studentId` values never establish identity.

### Centre setup and learning spaces

- An admin can list accounts, cohorts, courses, and learning spaces; invite a user; create a cohort or course; offer a course to a cohort; assign a teacher; and enroll a student.
- A teacher can list only learning spaces assigned to them. A student can list only spaces for cohorts in which they are enrolled.
- A teacher cannot read or change another teacher's assignments or access an unassigned cohort/course pair by changing request parameters.
- Only an admin can change centre structure, enrollments, teacher assignments, roles, package plans, package assignments, or payment confirmations.

### Lessons, progress, and private materials

- Admins can read all lessons. Teachers can read and manage lessons in assigned learning spaces. Students can read published lessons only in their enrolled learning spaces.
- A student can mark only their own completion of a published lesson in an enrolled space. A student cannot read another student's completion record.
- Teachers can view completion for students in their assigned space; admins can view centre progress.
- Reading materials and recordings remain private. Each request for a file link rechecks the session and the caller's access to the specific lesson; expired links stop working.
- A teacher can create a draft, upload its file through a short-lived authorization, and publish only after upload completion. Local development uses private disk storage without cloud credentials; production uses R2 direct uploads. Interrupted R2 uploads can resume; failed or abandoned drafts remain unpublished and can be cleaned up safely.
- An assigned teacher or admin can permanently delete a material and its private file. The API automatically removes published materials and their completion rows 20 days after publication, retrying failed storage deletions on its next hourly pass.
- Production video bytes do not pass through the API server. Local-development storage is private to the machine running the API. The database stores provider and object identifiers, not public file URLs.

### Schedule and attendance

- Admins and teachers can list sessions for spaces they manage; students can list sessions for their enrolled spaces. Meeting links are visible only to those authorized users.
- Only an assigned teacher can schedule a session. The server records the acting user as creator regardless of any submitted user ID. A student sees a Join control only from the scheduled start until the end time (or later if no end time was set).
- Only an admin or an assigned teacher can record attendance for students enrolled in the session's cohort.
- Every student row must have an attendance status before saving. The teacher's explicit `counts_toward_package` choice is preserved.
- Saving attendance and recalculating package usage is atomic. Retries or edits do not double-count a session.

### Packages, payments, and receipts

- An admin can create plans and assign a plan to an enrolled student in a learning space. A teacher can see package status for their assigned students; a student can see only their own status.
- Chargeable attendance increments the active package cycle. Non-chargeable attendance does not. Repeated saves do not increment usage twice.
- Only an admin can upload, view, or delete a receipt. Receipt links are short-lived and each request verifies admin authorization.
- Confirming a payment requires a package awaiting payment and, if provided, an uploaded receipt belonging to that package. In one database transaction the server creates exactly one confirmation record, resets usage, advances the package cycle, and clears payment due status.
- Duplicate or concurrent confirmation attempts cannot create partial or duplicate payment records. Payment due remains informational and does not block lessons or scheduled classes.

### Compatibility and cutover

- The existing screen workflows continue to call service methods in `app/src/data.ts`; backend changes stay behind that boundary.
- Staging is configured and exercised before production points at the replacement backend. Admin, teacher, and student accounts are tested separately, including cross-user and cross-cohort denial.
- The migration inventory records the actual source accounts, UUIDs, centre records, and files before any production cutover. Preserve UUIDs and relationships where possible.
- If a live Supabase project contains data, take a verified backup, migrate and reconcile records/files, and keep the old project available for rollback during a controlled cutover. Do not dual-write.
- No production cutover is considered complete until auth, data, private-file access, resumable uploads, attendance, and payment confirmation pass the staging acceptance checks.

## Migration order

1. Implement the selected PostgreSQL, Better Auth, Node API, and R2 stack in staging; supply service credentials outside the repository.
2. Replace the `data.ts` implementation and Auth calls with API/session calls while keeping the current screens.
3. Port schema and authorization, preserving UUIDs and business transactions.
4. Add private file adapters and resumable video upload authorization; exercise resume, failure, and abandoned-draft cleanup.
5. Run the acceptance checks above with separate admin, teacher, and student accounts.
6. Inventory live Supabase state, back up, migrate, reconcile, and cut over with rollback available.

## Decisions and external state still required

- PostgreSQL/API staging connection details.
- R2 account credentials and bucket configuration; the app's storage interface keeps this provider replaceable.
- SMTP delivery configuration.
- The live Supabase project and confirmation of whether it contains production accounts, records, or files.

The selected default is Better Auth + PostgreSQL + a Node API, with Cloudflare R2 for private receipts, reading files, and resumable video uploads. R2 has a monthly free allowance; usage above its included amounts is billed. It stores and serves the source video as a file and does not provide video transcoding. No live project credentials or production inventory are present in this repository, so the source data and cutover state cannot be inferred from code or migrations alone.
