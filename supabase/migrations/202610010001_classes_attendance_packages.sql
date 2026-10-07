-- Classes, teacher-recorded attendance, and manually reconciled class packages.
create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references public.cohort_courses(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 2 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz,
  meeting_url text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (meeting_url ~ '^https://')
);

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  attendance_status text not null check (attendance_status in ('attended','missed','cancelled')),
  counts_toward_package boolean not null default false,
  package_cycle integer not null default 1 check (package_cycle > 0),
  marked_by uuid not null references public.profiles(id),
  marked_at timestamptz not null default now(),
  unique (session_id, student_id)
);

create table public.package_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 100),
  class_count integer not null check (class_count > 0),
  amount numeric(12,2) not null check (amount >= 0),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.student_packages (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  cohort_course_id uuid not null references public.cohort_courses(id) on delete cascade,
  plan_id uuid not null references public.package_plans(id),
  sessions_attended integer not null default 0 check (sessions_attended >= 0),
  current_cycle integer not null default 1 check (current_cycle > 0),
  status text not null default 'active' check (status in ('active','payment_due','locked_future')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, cohort_course_id)
);

create table public.package_payments (
  id uuid primary key default gen_random_uuid(),
  student_package_id uuid not null references public.student_packages(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  paid_at timestamptz not null default now(),
  reference text,
  receipt_path text,
  confirmed_by uuid not null references public.profiles(id),
  confirmed_at timestamptz not null default now(),
  check (receipt_path is null or receipt_path like student_package_id::text || '/%')
);

create index on public.class_sessions(cohort_course_id, starts_at);
create index on public.attendance(session_id, student_id);
create index on public.student_packages(student_id, cohort_course_id);
create index on public.package_payments(student_package_id, paid_at desc);

alter table public.class_sessions enable row level security;
alter table public.attendance enable row level security;
alter table public.package_plans enable row level security;
alter table public.student_packages enable row level security;
alter table public.package_payments enable row level security;

revoke all on public.class_sessions, public.attendance, public.package_plans, public.student_packages, public.package_payments from anon, authenticated;
grant select on public.class_sessions, public.attendance, public.package_plans, public.student_packages, public.package_payments to authenticated;
grant insert, update on public.class_sessions, public.attendance to authenticated;
grant insert, update on public.package_plans, public.student_packages to authenticated;

create policy sessions_read on public.class_sessions for select to authenticated using (
  (select public.is_admin()) or public.teaches(cohort_course_id) or public.enrolled(cohort_course_id)
);
create policy sessions_insert on public.class_sessions for insert to authenticated with check (
  created_by = (select auth.uid()) and ((select public.is_admin()) or public.teaches(cohort_course_id))
);
create policy sessions_update on public.class_sessions for update to authenticated using (
  (select public.is_admin()) or public.teaches(cohort_course_id)
) with check ((select public.is_admin()) or public.teaches(cohort_course_id));

create policy attendance_read on public.attendance for select to authenticated using (
  student_id = (select auth.uid()) or (select public.is_admin()) or exists (
    select 1 from public.class_sessions s where s.id = session_id and public.teaches(s.cohort_course_id)
  )
);
create policy attendance_insert on public.attendance for insert to authenticated with check (
  marked_by = (select auth.uid()) and exists (
    select 1 from public.class_sessions s where s.id = session_id and (
      (select public.is_admin()) or public.teaches(s.cohort_course_id)
    )
    and exists (select 1 from public.cohort_courses cc join public.cohort_members cm on cm.cohort_id = cc.cohort_id
      where cc.id = s.cohort_course_id and cm.student_id = attendance.student_id)
  )
);
create policy attendance_update on public.attendance for update to authenticated using (
  (select public.is_admin()) or exists (
    select 1 from public.class_sessions s where s.id = session_id and public.teaches(s.cohort_course_id)
  )
) with check (
  marked_by = (select auth.uid()) and exists (
    select 1 from public.class_sessions s where s.id = session_id and (
      (select public.is_admin()) or public.teaches(s.cohort_course_id)
    ) and exists (select 1 from public.cohort_courses cc join public.cohort_members cm on cm.cohort_id = cc.cohort_id
      where cc.id = s.cohort_course_id and cm.student_id = attendance.student_id)
  )
);

create policy package_plans_read on public.package_plans for select to authenticated using (active or (select public.is_admin()));
create policy package_plans_admin_insert on public.package_plans for insert to authenticated with check (
  created_by = (select auth.uid()) and (select public.is_admin())
);
create policy package_plans_admin_update on public.package_plans for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy student_packages_read on public.student_packages for select to authenticated using (
  student_id = (select auth.uid()) or (select public.is_admin()) or public.teaches(cohort_course_id)
);
create policy student_packages_admin_insert on public.student_packages for insert to authenticated with check (
  created_by = (select auth.uid()) and (select public.is_admin()) and exists (
    select 1 from public.cohort_courses cc join public.cohort_members cm on cm.cohort_id = cc.cohort_id
    where cc.id = student_packages.cohort_course_id and cm.student_id = student_packages.student_id
  )
);
create policy student_packages_admin_update on public.student_packages for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy package_payments_read on public.package_payments for select to authenticated using (
  (select public.is_admin()) or exists (
    select 1 from public.student_packages p where p.id = student_package_id and p.student_id = (select auth.uid())
  )
);

create function public.refresh_package_attendance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_session_id uuid := coalesce(new.session_id, old.session_id);
  v_student_id uuid := coalesce(new.student_id, old.student_id);
  v_space_id uuid;
  v_count integer;
  v_cycle integer;
begin
  select cohort_course_id into v_space_id from public.class_sessions where id = v_session_id;
  select current_cycle into v_cycle from public.student_packages p
    where p.student_id = v_student_id and p.cohort_course_id = v_space_id;
  select count(*) into v_count from public.attendance a
    join public.class_sessions s on s.id = a.session_id
    where a.student_id = v_student_id and s.cohort_course_id = v_space_id
      and a.package_cycle = v_cycle and a.counts_toward_package;
  update public.student_packages p set
    sessions_attended = v_count,
    status = case when p.status = 'locked_future' then p.status
      when v_count >= (select class_count from public.package_plans where id = p.plan_id) then 'payment_due'
      else 'active' end,
    updated_at = now()
  where p.student_id = v_student_id and p.cohort_course_id = v_space_id;
  return new;
end; $$;
revoke all on function public.refresh_package_attendance() from public, anon, authenticated;
create trigger attendance_refresh_package after insert or update on public.attendance
  for each row execute function public.refresh_package_attendance();

create function public.set_attendance_package_cycle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    select p.current_cycle into new.package_cycle
      from public.class_sessions s join public.student_packages p
        on p.cohort_course_id = s.cohort_course_id and p.student_id = new.student_id
      where s.id = new.session_id;
    new.package_cycle := coalesce(new.package_cycle, 1);
  else
    if new.session_id <> old.session_id or new.student_id <> old.student_id or new.package_cycle <> old.package_cycle then
      raise exception 'Attendance cannot be moved to another student, class, or package cycle.';
    end if;
  end if;
  new.marked_by := auth.uid();
  new.marked_at := now();
  return new;
end; $$;
revoke all on function public.set_attendance_package_cycle() from public, anon, authenticated;
create trigger attendance_set_package_cycle before insert or update on public.attendance
  for each row execute function public.set_attendance_package_cycle();

create function public.confirm_package_payment(
  p_student_package_id uuid,
  p_amount numeric,
  p_paid_at timestamptz,
  p_reference text,
  p_receipt_path text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_payment_id uuid;
begin
  if not (select public.is_admin()) then raise exception 'Only an admin can confirm a payment.'; end if;
  if p_amount < 0 or (p_receipt_path is not null and p_receipt_path not like p_student_package_id::text || '/%') then raise exception 'Invalid payment details.'; end if;
  perform 1 from public.student_packages where id = p_student_package_id and status = 'payment_due' for update;
  if not found then raise exception 'This package is not awaiting payment.'; end if;
  if p_receipt_path is not null and not exists (select 1 from storage.objects where bucket_id = 'payment-receipts' and name = p_receipt_path) then
    raise exception 'Upload the receipt before confirming payment.';
  end if;
  insert into public.package_payments(student_package_id, amount, paid_at, reference, receipt_path, confirmed_by)
  values (p_student_package_id, p_amount, coalesce(p_paid_at, now()), nullif(trim(p_reference), ''), p_receipt_path, auth.uid())
  returning id into v_payment_id;
  update public.student_packages set sessions_attended = 0, current_cycle = current_cycle + 1, status = 'active', updated_at = now()
    where id = p_student_package_id;
  if not found then raise exception 'Package assignment not found.'; end if;
  return v_payment_id;
end; $$;
revoke all on function public.confirm_package_payment(uuid, numeric, timestamptz, text, text) from public, anon;
grant execute on function public.confirm_package_payment(uuid, numeric, timestamptz, text, text) to authenticated;

insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('payment-receipts', 'payment-receipts', false, array['image/jpeg','image/png','image/webp','application/pdf'], 10485760)
on conflict (id) do nothing;
create policy payment_receipts_admin_read on storage.objects for select to authenticated using (
  bucket_id = 'payment-receipts' and (select public.is_admin())
);
create policy payment_receipts_admin_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'payment-receipts' and (select public.is_admin())
  and exists (select 1 from public.student_packages p where p.id::text = (storage.foldername(name))[1])
);
create policy payment_receipts_admin_delete on storage.objects for delete to authenticated using (
  bucket_id = 'payment-receipts' and (select public.is_admin())
);

notify pgrst, 'reload schema';
