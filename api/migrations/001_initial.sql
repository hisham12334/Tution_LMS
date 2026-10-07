-- Better Auth identity tables. User IDs remain UUID strings to preserve existing profile IDs.
create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  role text not null default 'user',
  banned boolean not null default false,
  "banReason" text,
  "banExpires" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists "session" (
  id text primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "impersonatedBy" text references "user"(id) on delete set null,
  "userId" text not null references "user"(id) on delete cascade
);
create index if not exists session_user_id_idx on "session"("userId");

create table if not exists "account" (
  id text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("accountId","providerId")
);
create index if not exists account_user_id_idx on "account"("userId");

create table if not exists verification (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists verification_identifier_idx on verification(identifier);

-- Centre model. IDs for domain records remain UUIDs; profile identity is a UUID string.
create table if not exists profiles (
  id text primary key references "user"(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 2 and 100),
  role text not null check (role in ('student','teacher','admin'))
);

create table if not exists cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 100),
  created_at timestamptz not null default now()
);
create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 2 and 120),
  created_at timestamptz not null default now()
);
create table if not exists cohort_courses (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (cohort_id, course_id)
);
create table if not exists cohort_members (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts(id) on delete cascade,
  student_id text not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (cohort_id, student_id)
);
create table if not exists teacher_assignments (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  teacher_id text not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (cohort_course_id, teacher_id)
);
create table if not exists lessons (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 2 and 160),
  description text,
  kind text not null check (kind in ('recording','reading')),
  storage_provider text,
  storage_key text,
  original_name text,
  status text not null default 'draft' check (status in ('draft','published')),
  created_by text not null references profiles(id),
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists lessons_space_status_created_idx on lessons(cohort_course_id,status,created_at);

create table if not exists lesson_progress (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  student_id text not null references profiles(id) on delete cascade,
  completed_at timestamptz not null default now(),
  unique (lesson_id, student_id)
);
create index if not exists lesson_progress_lesson_idx on lesson_progress(lesson_id);

create table if not exists class_sessions (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 2 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz,
  meeting_url text check (meeting_url is null or meeting_url ~ '^https://'),
  created_by text not null references profiles(id),
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists sessions_space_starts_idx on class_sessions(cohort_course_id,starts_at);

create table if not exists package_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 100),
  class_count integer not null check (class_count > 0),
  amount numeric(12,2) not null check (amount >= 0),
  active boolean not null default true,
  created_by text not null references profiles(id),
  created_at timestamptz not null default now()
);
create table if not exists student_packages (
  id uuid primary key default gen_random_uuid(),
  student_id text not null references profiles(id) on delete cascade,
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  plan_id uuid not null references package_plans(id),
  sessions_attended integer not null default 0 check (sessions_attended >= 0),
  current_cycle integer not null default 1 check (current_cycle > 0),
  status text not null default 'active' check (status in ('active','payment_due','locked_future')),
  created_by text not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, cohort_course_id)
);
create index if not exists student_packages_student_space_idx on student_packages(student_id,cohort_course_id);
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references class_sessions(id) on delete cascade,
  student_id text not null references profiles(id) on delete cascade,
  attendance_status text not null check (attendance_status in ('attended','missed','cancelled')),
  counts_toward_package boolean not null default false,
  package_cycle integer not null default 1 check (package_cycle > 0),
  marked_by text not null references profiles(id),
  marked_at timestamptz not null default now(),
  unique (session_id,student_id)
);
create index if not exists attendance_session_student_idx on attendance(session_id,student_id);
create table if not exists package_payments (
  id uuid primary key default gen_random_uuid(),
  student_package_id uuid not null references student_packages(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  paid_at timestamptz not null default now(),
  reference text,
  receipt_provider text,
  receipt_key text,
  confirmed_by text not null references profiles(id),
  confirmed_at timestamptz not null default now()
);
create index if not exists payments_package_paid_idx on package_payments(student_package_id,paid_at desc);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references "user"(id) on delete cascade,
  invited_by text not null references profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create table if not exists file_uploads (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null unique references lessons(id) on delete cascade,
  owner_id text not null references profiles(id) on delete cascade,
  object_key text not null unique,
  multipart_upload_id text,
  status text not null default 'pending' check (status in ('pending','uploaded','published','abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists file_uploads_cleanup_idx on file_uploads(status,created_at);
