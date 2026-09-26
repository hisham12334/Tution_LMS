-- First working slice: teacher materials, student completion, teacher visibility.
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New learner',
  role text not null default 'student' check (role in ('student','teacher','admin')),
  created_at timestamptz not null default now()
);
create table public.cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  created_at timestamptz not null default now()
);
create table public.cohort_courses (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  unique (cohort_id, course_id)
);
create table public.cohort_members (
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  primary key (cohort_id, student_id)
);
create table public.teacher_assignments (
  cohort_course_id uuid not null references public.cohort_courses(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  primary key (cohort_course_id, teacher_id)
);
create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references public.cohort_courses(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 2 and 160),
  description text,
  kind text not null check (kind in ('recording','reading')),
  storage_path text,
  original_name text,
  status text not null default 'draft' check (status in ('draft','published')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  constraint published_has_file check (status = 'draft' or storage_path is not null),
  constraint path_matches_lesson check (storage_path is null or storage_path like cohort_course_id::text || '/' || id::text || '/%')
);
create table public.lesson_progress (
  student_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (student_id, lesson_id)
);
create index on public.cohort_members(student_id);
create index on public.teacher_assignments(teacher_id);
create index on public.lessons(cohort_course_id, status, created_at);
create index on public.lesson_progress(lesson_id);

create function public.new_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1)));
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.new_profile();

create function public.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
create function public.teaches(p_cohort_course_id uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teacher_assignments where cohort_course_id = p_cohort_course_id and teacher_id = (select auth.uid()));
$$;
create function public.enrolled(p_cohort_course_id uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.cohort_courses cc
    join public.cohort_members cm on cm.cohort_id = cc.cohort_id
    where cc.id = p_cohort_course_id and cm.student_id = (select auth.uid())
  );
$$;
create function public.teaches_cohort(p_cohort_id uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.cohort_courses cc
    join public.teacher_assignments ta on ta.cohort_course_id = cc.id
    where cc.cohort_id = p_cohort_id and ta.teacher_id = (select auth.uid())
  );
$$;
revoke all on function public.is_admin(), public.teaches(uuid), public.enrolled(uuid), public.teaches_cohort(uuid) from public;
grant execute on function public.is_admin(), public.teaches(uuid), public.enrolled(uuid), public.teaches_cohort(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.cohorts enable row level security;
alter table public.courses enable row level security;
alter table public.cohort_courses enable row level security;
alter table public.cohort_members enable row level security;
alter table public.teacher_assignments enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_progress enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.cohorts, public.courses, public.cohort_courses, public.cohort_members, public.teacher_assignments, public.lessons, public.lesson_progress to authenticated;
grant insert, update, delete on public.cohorts, public.courses, public.cohort_courses, public.cohort_members, public.teacher_assignments to authenticated;
grant insert, update, delete on public.lessons to authenticated;
grant insert, delete on public.lesson_progress to authenticated;

create policy profiles_read on public.profiles for select to authenticated using (
  id = (select auth.uid()) or (select public.is_admin()) or exists (
    select 1 from public.cohort_members cm
    where cm.student_id = profiles.id and (select public.teaches_cohort(cm.cohort_id))
  )
);
create policy cohorts_read on public.cohorts for select to authenticated using (
  (select public.is_admin()) or exists (
    select 1 from public.cohort_members cm where cm.cohort_id = cohorts.id and cm.student_id = (select auth.uid())
  ) or (select public.teaches_cohort(id))
);
create policy courses_read on public.courses for select to authenticated using (
  (select public.is_admin()) or exists (
    select 1 from public.cohort_courses cc where cc.course_id = courses.id
    and (public.enrolled(cc.id) or public.teaches(cc.id))
  )
);
create policy cohort_courses_read on public.cohort_courses for select to authenticated using (
  (select public.is_admin()) or public.enrolled(id) or public.teaches(id)
);
create policy cohort_members_read on public.cohort_members for select to authenticated using (
  (select public.is_admin()) or student_id = (select auth.uid()) or public.teaches_cohort(cohort_id)
);
create policy teacher_assignments_read on public.teacher_assignments for select to authenticated using (
  (select public.is_admin()) or teacher_id = (select auth.uid())
);

create policy cohorts_admin_insert on public.cohorts for insert to authenticated with check ((select public.is_admin()));
create policy cohorts_admin_update on public.cohorts for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy cohorts_admin_delete on public.cohorts for delete to authenticated using ((select public.is_admin()));
create policy courses_admin_insert on public.courses for insert to authenticated with check ((select public.is_admin()));
create policy courses_admin_update on public.courses for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy courses_admin_delete on public.courses for delete to authenticated using ((select public.is_admin()));
create policy cc_admin_insert on public.cohort_courses for insert to authenticated with check ((select public.is_admin()));
create policy cc_admin_update on public.cohort_courses for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy cc_admin_delete on public.cohort_courses for delete to authenticated using ((select public.is_admin()));
create policy cm_admin_insert on public.cohort_members for insert to authenticated with check ((select public.is_admin()));
create policy cm_admin_update on public.cohort_members for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy cm_admin_delete on public.cohort_members for delete to authenticated using ((select public.is_admin()));
create policy ta_admin_insert on public.teacher_assignments for insert to authenticated with check ((select public.is_admin()));
create policy ta_admin_update on public.teacher_assignments for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy ta_admin_delete on public.teacher_assignments for delete to authenticated using ((select public.is_admin()));

create policy lessons_read on public.lessons for select to authenticated using (
  (select public.is_admin()) or public.teaches(cohort_course_id) or (status = 'published' and public.enrolled(cohort_course_id))
);
create policy lessons_insert on public.lessons for insert to authenticated with check (
  (created_by = (select auth.uid())) and (status = 'draft') and (storage_path is null)
  and ((select public.is_admin()) or public.teaches(cohort_course_id))
);
create policy lessons_update on public.lessons for update to authenticated using (
  (select public.is_admin()) or public.teaches(cohort_course_id)
) with check ((select public.is_admin()) or public.teaches(cohort_course_id));
create policy lessons_delete on public.lessons for delete to authenticated using (
  (select public.is_admin()) or public.teaches(cohort_course_id)
);
create policy progress_read on public.lesson_progress for select to authenticated using (
  student_id = (select auth.uid()) or (select public.is_admin()) or exists (
    select 1 from public.lessons l where l.id = lesson_id and public.teaches(l.cohort_course_id)
  )
);
create policy progress_insert on public.lesson_progress for insert to authenticated with check (
  student_id = (select auth.uid()) and exists (
    select 1 from public.lessons l where l.id = lesson_id and l.status = 'published' and public.enrolled(l.cohort_course_id)
  )
);
create policy progress_delete on public.lesson_progress for delete to authenticated using (student_id = (select auth.uid()));

-- Keep progress immutable once marked complete; update access is intentionally absent.
insert into storage.buckets (id, name, public, allowed_mime_types)
values ('lesson-materials', 'lesson-materials', false, array['video/mp4','video/webm','video/quicktime','application/pdf','text/plain'])
on conflict (id) do nothing;
create policy lesson_files_read on storage.objects for select to authenticated using (
  bucket_id = 'lesson-materials' and exists (
    select 1 from public.lessons l where l.storage_path = name and (
      (select public.is_admin()) or public.teaches(l.cohort_course_id)
      or (l.status = 'published' and public.enrolled(l.cohort_course_id))
    )
  )
);
create policy lesson_files_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'lesson-materials' and exists (
    select 1 from public.lessons l where l.id::text = (storage.foldername(name))[2]
    and l.cohort_course_id::text = (storage.foldername(name))[1]
    and l.status = 'draft' and ((select public.is_admin()) or public.teaches(l.cohort_course_id))
  )
);
