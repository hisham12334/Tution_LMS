# Northstar Learning LMS — approval prototype

The system architecture, roles, data model, flows, and build order are in [ARCHITECTURE.md](ARCHITECTURE.md). The root `index.html` is the original approval prototype. The connected application is in `app/`.

## Connected learning slice

The first application slice supports email/password sign-in, teacher uploads of recorded classes and PDF/text reading materials, student completion, student progress, and teacher visibility into each student's progress and latest completion. Files are stored privately. Uploads use resumable chunks for large recordings. The teacher may only work in assigned cohort/course pairs; database policies protect records and files independently of the interface.

The app needs a Supabase project before live data can be used. No Supabase credentials or real student data are committed to this repository.

### Local setup

1. Create a Supabase project and apply [`supabase/migrations/202609260001_learning_slice.sql`](supabase/migrations/202609260001_learning_slice.sql) in the SQL Editor. Use a fresh project; the migration creates its own tables and bucket.
2. In Supabase Auth, create the first users using email/password. New users get a `student` profile automatically. Promote the staff accounts in SQL Editor: `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'ADMIN_EMAIL');` and similarly set `role = 'teacher'` for each teacher. This bootstrap SQL is performed by the project owner, never from the web app.
3. Create at least one cohort and course in the Supabase Table Editor, then a `cohort_courses` row linking them. Add student IDs to `cohort_members` and teacher IDs to `teacher_assignments` for that cohort/course. Admin setup screens and invitations are the next implementation slice.
4. Copy `app/.env.example` to `app/.env.local` and replace both placeholders with the project's URL and browser-safe **publishable/anon** key. The app accepts either `VITE_SUPABASE_PUBLISHABLE_KEY` or the older `VITE_SUPABASE_ANON_KEY` name. Never put a service-role key in a `VITE_` variable.
5. In `app/`, run `npm install` and `npm run dev`. Open the local URL shown by Vite.

Run `npm run build` from `app/` to check the TypeScript and production bundle. The root prototype can still be opened independently for visual review.

### Current boundary

The connected code is ready for a Supabase project, but live sign-in, upload, and progress cannot be tested end-to-end until that project and two test accounts exist. Assignments, grading, live-class links, notifications, and admin onboarding remain later slices in the architecture plan.

Open `index.html` in a browser to review the front-end concept.

## What this prototype demonstrates

- **Student dashboard:** next lesson, weekly learning plan, progress, upcoming live classes, and assignment deadlines.
- **Teacher / admin dashboard:** student overview, marking queue, course health, and class schedule.
- **Role preview:** use the Student / Teacher / Admin switch at the top to move between the two experiences.

## Suggested delivery plan

1. **Approval and visual direction** — confirm branding, course categories, and the exact student navigation.
2. **Foundation** — authentication, roles, student profiles, cohorts, and a secure admin workspace.
3. **Teaching operations** — lesson/content management, class timetable, recordings, assignments, submissions, marking, and feedback.
4. **Student experience** — real lesson player, progress tracking, notifications, calendar, and downloadable resources.
5. **Finish and launch** — analytics, reports, QA, mobile tuning, data migration, and staff training.

## Data model to connect next

`users` → `roles` → `cohorts` → `courses` → `lessons` → `enrolments` → `progress` → `assignments` → `submissions` → `feedback`

The current controls are intentionally prototype interactions; they clearly identify where the live flows will attach once the stack is selected.
