create table if not exists chat_reads (
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  last_read_message_id bigint not null default 0,
  read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists chat_reads_user_idx on chat_reads(user_id);
