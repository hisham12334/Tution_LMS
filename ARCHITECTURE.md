# Tuition LMS architecture and implementation plan

Status: backend migration foundation in progress. The connected application is in `app/`; the root `index.html` remains the older visual prototype.

## Product boundary

One tuition centre with three actual roles: student, teacher, and admin. The prototype's role switch is a preview control; the production role comes from the signed-in user's account and cannot be changed in the browser. A teacher may manage only cohorts assigned to them. An admin manages the centre. The first release uses saved class times and teacher-provided meeting links, teacher-recorded attendance, admin-assigned class packages, and manual payment confirmation with a private receipt. Payment status is visible, while access restrictions, payment gateways, parent accounts, and native video conferencing remain later work.

## Stack and deployment

- **Web app:** React + TypeScript + Vite. Reuse the existing visual language while replacing hard-coded HTML values with components and queries. Vite can produce a static client bundle for a preview site.
- **Backend:** Node.js API, PostgreSQL, and Better Auth. Better Auth manages email/password credentials, reset/setup tokens, and server-side cookie sessions. PostgreSQL is accessible only to the API; API handlers derive identity from the session and enforce role and learning-space rules.
- **Files:** Cloudflare R2 through its S3-compatible API. The bucket stays private; the API grants short-lived file-specific access and direct multipart upload permissions. Video is stored and served as a file; transcoding is outside this slice.
- **Hosting:** Keep this repository as the source. The Vite client and API should share a site origin through a reverse proxy so session cookies remain first-party. Configure preview and production separately; the root local prototype is not the production app.
- **Time:** Store timestamps in UTC and display class times in `Asia/Kolkata` by default. The centre can choose a different timezone during setup.

Keep API calls behind the service methods in `app/src/data.ts`. This keeps the screens independent of database and file-provider details.

## Data model

| Entity | Key relationship or purpose |
| --- | --- |
| `profiles` | One row per Better Auth user; name and `student` / `teacher` / `admin` role. Role writes are admin-only. |
| `cohorts` | A named batch with dates and status. |
| `cohort_members` | Student enrollment in a cohort. |
| `courses` | Subject or course details. |
| `cohort_courses` | Courses offered to each cohort. |
| `teacher_assignments` | Teacher access to a cohort/course pair. |
| `lessons` | Ordered recorded lesson or reading material with type, private file path, draft/published state, and owning cohort/course. |
| `lesson_progress` | One student/lesson completion record with completion time; supports student and teacher progress. |
| `class_sessions` | Scheduled time, optional external meeting link, and owning cohort/course. |
| `attendance` | One teacher-marked student/session record, including the teacher's explicit decision about whether it counts toward a package. |
| `package_plans` | Admin-defined class count and fee. |
| `student_packages` | The plan assigned to a student in a learning space, current class count, payment status, and future-ready access state. |
| `package_payments` | Admin-confirmed payments, reference, private receipt path, and package cycle history. |
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
| Upload recording or reading material | No | Assigned cohort/course | All |
| View progress and activity by student | Own progress | Students in assigned cohorts | All |
| View schedule and package status | Enrolled cohorts | Assigned cohorts | All |
| Schedule class and mark attendance | No | Assigned cohorts | All |
| Manage package plans, assignments, payment confirmations | No | No | Yes |
| Submit assignment | Own work for enrolled published assignment | No | No |
| Create or publish lesson/assignment | No | Assigned cohort/course | All |
| View and grade submissions | Own submission/grade | Assigned cohort/course | All |
| Manage accounts, roles, enrollments | No | No | Yes |

These checks belong in database policies and privileged functions, not just hidden buttons. Test a student against another student's records and a teacher against an unassigned cohort before launch.

## Main flows

1. **Admin setup:** create cohort and course → invite teachers and students → assign teachers → enroll students.
2. **Teacher teaching:** select an assigned cohort/course → schedule a class with an existing Meet/Zoom link → mark each student's attendance and decide whether it counts toward the package → upload and publish course materials.
3. **Student learning:** sign in → view schedule and join link → open and complete published material → see progress and package balance/payment due state. Access remains available when payment is due.
4. **Dashboard data:** derive “next lesson,” completed/total lessons, completion percentage, and each student's last completion time from saved records. Completion is a student action; opening a file alone does not count as completion. Do not persist editable summary numbers.

## Build order and acceptance checks

1. **Migration foundation:** versioned PostgreSQL schema, Better Auth sessions, Node API, and the frontend service boundary. Check that unauthenticated visitors cannot enter a workspace and students cannot access staff actions.
2. **Authorization:** enforce admin, assigned-teacher, and enrolled-student scopes on every API request and every private-file link. Check cross-user and cross-cohort denials.
3. **First complete slice:** admin creates a cohort/course and enrolls a student; teacher uploads and publishes a recording or reading material; student opens and marks it complete; progress updates on the student dashboard and that student's row in the teacher dashboard. Exercise separate accounts in staging.
4. **Assignments:** publish assignment, upload submission, grade, and provide feedback. Check file privacy, deadlines, and role access.
5. **Release:** notifications, analytics, access restrictions for overdue packages, accessibility/mobile pass, error states, backups, deployment, and client acceptance testing.

## Decisions needed before connecting live services

- Set the allowed video size and expected upload volume before production; R2 multipart supports resumable source-file uploads.
- Provide staging/production database, API, R2, SMTP, and hosting accounts. Keep credentials in environment secrets.

No production student records or credentials should be added to the repository.
