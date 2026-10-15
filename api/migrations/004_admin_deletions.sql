-- Keep authored and audit records when a staff account is removed.
alter table lessons alter column created_by drop not null;
alter table lessons drop constraint lessons_created_by_fkey;
alter table lessons add constraint lessons_created_by_fkey foreign key (created_by) references profiles(id) on delete set null;
alter table class_sessions alter column created_by drop not null;
alter table class_sessions drop constraint class_sessions_created_by_fkey;
alter table class_sessions add constraint class_sessions_created_by_fkey foreign key (created_by) references profiles(id) on delete set null;
alter table package_plans alter column created_by drop not null;
alter table package_plans drop constraint package_plans_created_by_fkey;
alter table package_plans add constraint package_plans_created_by_fkey foreign key (created_by) references profiles(id) on delete set null;
alter table student_packages alter column created_by drop not null;
alter table student_packages drop constraint student_packages_created_by_fkey;
alter table student_packages add constraint student_packages_created_by_fkey foreign key (created_by) references profiles(id) on delete set null;
alter table attendance alter column marked_by drop not null;
alter table attendance drop constraint attendance_marked_by_fkey;
alter table attendance add constraint attendance_marked_by_fkey foreign key (marked_by) references profiles(id) on delete set null;
alter table package_payments alter column confirmed_by drop not null;
alter table package_payments drop constraint package_payments_confirmed_by_fkey;
alter table package_payments add constraint package_payments_confirmed_by_fkey foreign key (confirmed_by) references profiles(id) on delete set null;
alter table invitations alter column invited_by drop not null;
alter table invitations drop constraint invitations_invited_by_fkey;
alter table invitations add constraint invitations_invited_by_fkey foreign key (invited_by) references profiles(id) on delete set null;
alter table file_uploads alter column owner_id drop not null;
alter table file_uploads drop constraint file_uploads_owner_id_fkey;
alter table file_uploads add constraint file_uploads_owner_id_fkey foreign key (owner_id) references profiles(id) on delete set null;

-- R2 deletion can fail independently of the database transaction; retry from this queue.
create table if not exists deleted_file_cleanup (
  object_key text primary key,
  multipart_upload_id text,
  created_at timestamptz not null default now()
);
