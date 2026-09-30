# Northstar Learning LMS — approval prototype

The system architecture, roles, data model, flows, and build order are in [ARCHITECTURE.md](ARCHITECTURE.md). The root `index.html` is the original approval prototype. The connected application is in `app/`.

## Connected learning slice

The first application slice supports email/password sign-in, teacher uploads of recorded classes and PDF/text reading materials, student completion, student progress, and teacher visibility into each student's progress and latest completion. Files are stored privately. Uploads use resumable chunks for large recordings. The teacher may only work in assigned cohort/course pairs; database policies protect records and files independently of the interface.

The app needs a Supabase project before live data can be used. No Supabase credentials or real student data are committed to this repository.

### Local setup

1. Create a Supabase project and apply [`supabase/migrations/202609260001_learning_slice.sql`](supabase/migrations/202609260001_learning_slice.sql) in the SQL Editor. Use a fresh project; the migration creates its own tables and bucket.
2. In Supabase Auth, create the first users using email/password. New users get a `student` profile automatically. Promote the staff accounts in SQL Editor: `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'ADMIN_EMAIL');` and similarly set `role = 'teacher'` for each teacher. This bootstrap SQL is performed by the project owner, never from the web app.
3. Deploy [`supabase/functions/invite-account/index.ts`](supabase/functions/invite-account/index.ts) as the `invite-account` Edge Function in the same Supabase project, keeping JWT verification enabled. The function uses Supabase's built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` server secrets. Never add the service-role key to Netlify or a `VITE_` variable.
4. Sign in as an admin and use **Manage centre** to invite student and teacher accounts, create cohorts and courses, pair them into learning spaces, assign teachers, and enroll students. New users receive an email invitation and choose their own password in the app. Existing accounts can still be assigned without another invitation.
5. Copy `app/.env.example` to `app/.env.local` and replace both placeholders with the project's URL and browser-safe **publishable/anon** key. The app accepts either `VITE_SUPABASE_PUBLISHABLE_KEY` or the older `VITE_SUPABASE_ANON_KEY` name. Never put a service-role key in a `VITE_` variable.
6. In `app/`, run `npm install` and `npm run dev`. Open the local URL shown by Vite.

Run `npm run build` from `app/` to check the TypeScript and production bundle. The root prototype can still be opened independently for visual review.

### Temporary client demo (Netlify)

The root [`netlify.toml`](netlify.toml) configures Netlify to build `app/` and publish its `dist/` output. Import this GitHub repository into Netlify with `main` as the production branch, then add these site environment variables before the first deploy:

- `VITE_SUPABASE_URL` — the Supabase project URL.
- `VITE_SUPABASE_ANON_KEY` — the browser-safe anon/publishable key (or use `VITE_SUPABASE_PUBLISHABLE_KEY`).

These Vite values are included in the public browser bundle; never use a service-role key. After Netlify creates the site URL, set it as the Supabase Auth Site URL and add the site URL to Auth Redirect URLs so invitation and password-reset links can return to the hosted app. Deploy the `invite-account` Edge Function to the Supabase project as well; Netlify only deploys the front end. For production invitations and password recovery, configure a custom SMTP provider in Supabase Auth because the built-in email service has strict sending limits. Use demo accounts and sample data for the client presentation.

### Current boundary

Assignments, grading, live-class links, notifications, and broader account management remain later slices in the architecture plan. Admin invitation of student and teacher accounts is implemented through a protected Edge Function.

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
