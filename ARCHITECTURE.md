# Tuition LMS architecture and implementation plan

Status: proposed foundation, before application code migration. The current `index.html` remains the approval prototype.

## Product boundary

One tuition centre with three actual roles: student, teacher, and admin. The prototype's role switch is a preview control; the production role comes from the signed-in user's account and cannot be changed in the browser. A teacher may manage only cohorts assigned to them. An admin manages the centre. Payments, parent accounts, and native video conferencing are outside the first release unless the client adds them.

## Stack and deployment

- **Web app:** React + TypeScript + Vite. Reuse the existing visual language while replacing hard-coded HTML values with components and queries. Vite can produce a static client bundle for a preview site.
- **Backend:** Supabase Auth, PostgreSQL, and private Storage. The browser uses the Supabase publishable key; PostgreSQL row-level security (RLS) enforces ownership and cohort permissions. No service-role key is shipped to the browser.
- **Privileged operations:** Small server-side Edge Functions only for staff invitations, role assignment, and other operations that need elevated credentials. Each function checks the caller's admin role.
- **Hosting:** Keep this GitHub repository as the source. A static host can serve the Vite build, while Supabase runs the backend. Configure preview and production environments separately; the current local `file://` prototype does not become the production app automatically.
- **Time:** Store timestamps in UTC and display class times in `Asia/Kolkata` by default. The centre can choose a different timezone during setup.

This keeps the first release to one web app and one managed backend. A separate custom API service is unnecessary for the initial flows, but can be added behind the same data model if complex integrations arrive later.

## Data model

| Entity | Key relationship or purpose |
| --- | --- |
| `profiles` | One row per Auth user; name and `student` / `teacher` / `admin` role. Role writes are admin-only. |
| `cohorts` | A named batch with dates and status. |
| `cohort_members` | Student enrollment in a cohort. |
| `courses` | Subject or course details. |
| `cohort_courses` | Courses offered to each cohort. |
| `teacher_assignments` | Teacher access to a cohort/course pair. |
| `lessons` | Ordered recorded lesson, resource, or live-class reference; draft/published state. |
| `lesson_progress` | One student/lesson completion record; supports dashboard progress. |
| `live_sessions` | Scheduled time, location or meeting URL, and owning cohort/course. |
| `assignments` | Prompt, due time, points, and publishing state. |
| `submissions` | One student's work for an assignment, status, submitted time, and private file path. |
| `grades` | Teacher score and feedback for a submission. |
| `notifications` | User-specific in-app announcements and read state. |

Store file paths and metadata in PostgreSQL, with the actual files in private Storage buckets. Add indexes for cohort/course membership, assignment due dates, and review queues.

## Access rules

| Action | Student | Teacher | Admin |
| --- | --- | --- | --- |
| View course, lesson, and schedule | Enrolled cohorts, published items only | Assigned cohorts | All |
| Mark lesson complete | Own progress only | No | No |
| Submit assignment | Own work for enrolled published assignment | No | No |
| Create or publish lesson/assignment | No | Assigned cohort/course | All |
| View and grade submissions | Own submission/grade | Assigned cohort/course | All |
| Manage accounts, roles, enrollments | No | No | Yes |

These checks belong in database policies and privileged functions, not just hidden buttons. Test a student against another student's records and a teacher against an unassigned cohort before launch.

## Main flows

1. **Admin setup:** create cohort and course → invite teachers and students → assign teachers → enroll students.
2. **Teacher teaching:** create lesson, resource, live session, or assignment in an assigned course → publish → review submissions → release marks and feedback.
3. **Student learning:** sign in → dashboard queries enrolled, published content → watch lesson or download resource → complete lesson → submit assignment → see grade and feedback.
4. **Dashboard data:** derive “next lesson,” progress, upcoming deadlines, and review counts from saved records. Do not persist these as editable summary numbers.

## Build order and acceptance checks

1. **Foundation:** migrate the prototype to React/TypeScript, set up environment variables, routing, Supabase client, Auth screens, and role-based layouts. Check that an unauthenticated visitor cannot enter either workspace and a student cannot open staff views.
2. **Schema and security:** versioned SQL migrations, RLS, private buckets, and a repeatable dev seed with non-sensitive sample data. Check cross-user and cross-cohort denial with automated policy tests.
3. **First complete slice:** admin creates a cohort/course and enrolls a student; teacher publishes a lesson; student sees and completes it; progress updates on both dashboards. Check the flow across two browser accounts.
4. **Assignments and live classes:** publish assignment, upload submission, grade, feedback, schedule and join link. Check file privacy, deadlines, and role access.
5. **Release:** notifications, analytics, accessibility/mobile pass, error states, backups, deployment, and client acceptance testing.

## Decisions needed before connecting live services

- The centre's real name/branding and initial course/cohort names.
- Whether students sign in by email/password or email magic link. Recommend invite-only email/password for the first release; no open self-registration.
- Whether recorded videos are uploaded privately or linked from an existing video service, and where live classes are held (room, Zoom, Google Meet, etc.).
- Who owns the Supabase project and the hosting account. Do not put credentials in Git; use environment secrets.

Until these are answered, build with configuration points and sample data. No production student records should be added to the repository.
