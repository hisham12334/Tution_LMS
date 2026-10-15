create table if not exists chat_conversations (
  id uuid primary key default gen_random_uuid(),
  cohort_course_id uuid not null references cohort_courses(id) on delete cascade,
  student_id text not null references profiles(id) on delete cascade,
  teacher_id text not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (cohort_course_id, student_id, teacher_id)
);
create index if not exists chat_conversations_student_idx on chat_conversations(student_id);
create index if not exists chat_conversations_teacher_idx on chat_conversations(teacher_id);

create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  sender_id text not null references profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_conversation_id_idx on chat_messages(conversation_id, id desc);
