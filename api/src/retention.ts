import { query } from './db.js';
import { cancelMultipart, deleteObject } from './storage.js';

const RETENTION_BATCH_SIZE = 100;

export async function cleanupExpiredMaterials() {
  const expired = await query<{ id: string; storage_key: string | null; multipart_upload_id: string | null; upload_status: string | null }>(
    `select l.id,coalesce(l.storage_key,fu.object_key) storage_key,fu.multipart_upload_id,fu.status upload_status
     from lessons l left join file_uploads fu on fu.lesson_id=l.id
     where (l.status='published' and l.published_at < now()-interval '20 days')
        or (l.status='draft' and coalesce(fu.created_at,l.created_at) < now()-interval '20 days')
     order by coalesce(l.published_at,fu.created_at,l.created_at) limit $1`,
    [RETENTION_BATCH_SIZE],
  );
  let removed = 0;
  for (const lesson of expired.rows) {
    try {
      if (lesson.multipart_upload_id && lesson.upload_status === 'pending') await cancelMultipart(lesson.storage_key!, lesson.multipart_upload_id);
      if (lesson.storage_key) await deleteObject(lesson.storage_key);
      const result = await query(
        `delete from lessons l where l.id=$1 and (
          (l.status='published' and l.published_at < now()-interval '20 days') or
          (l.status='draft' and not exists(select 1 from file_uploads fu where fu.lesson_id=l.id and fu.created_at >= now()-interval '20 days')
            and l.created_at < now()-interval '20 days')
        ) returning l.id`,
        [lesson.id],
      );
      removed += result.rowCount || 0;
    } catch (error) {
      console.error(`Could not expire material ${lesson.id}; it will be retried.`, error);
    }
  }
  return removed;
}
