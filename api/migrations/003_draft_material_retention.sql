create index if not exists lessons_draft_retention_idx
  on lessons(created_at)
  where status = 'draft';

create index if not exists file_uploads_retention_idx
  on file_uploads(created_at, lesson_id);
