create index if not exists lessons_retention_idx
  on lessons(published_at)
  where status = 'published' and published_at is not null;
