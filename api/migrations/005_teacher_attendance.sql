create table space_working_hours (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  effective_from date not null,
  starts_at time not null,
  ends_at time not null,
  check (ends_at > starts_at),
  unique (cohort_course_id, effective_from)
);

create table teacher_class_links (
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  teacher_id text not null references profiles(id) on delete cascade,
  class_date date not null,
  session_id uuid not null unique references class_sessions(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  primary key (cohort_course_id, teacher_id, class_date)
);

create table teacher_attendance_overrides (
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  teacher_id text not null references profiles(id) on delete cascade,
  class_date date not null,
  attendance_status text not null check (attendance_status in ('attended','missed')),
  marked_by text references profiles(id) on delete set null,
  marked_at timestamptz not null default now(),
  primary key (cohort_course_id, teacher_id, class_date)
);
