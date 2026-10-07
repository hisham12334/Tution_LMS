import 'dotenv/config';
import { pool } from './db.js';
import { cancelMultipart, deleteObject } from './storage.js';

try {
  const result = await pool.query<{ lesson_id: string; object_key: string | null; multipart_upload_id: string | null }>(
    `select l.id lesson_id,fu.object_key,fu.multipart_upload_id from lessons l left join file_uploads fu on fu.lesson_id=l.id
     where l.status='draft' and l.created_at < now()-interval '24 hours'`);
  for (const row of result.rows) {
    if (row.object_key && row.multipart_upload_id) await cancelMultipart(row.object_key, row.multipart_upload_id).catch(() => undefined);
    if (row.object_key) {
      try { await deleteObject(row.object_key); }
      catch { continue; }
    }
    await pool.query("update file_uploads set status='abandoned',updated_at=now() where lesson_id=$1", [row.lesson_id]);
    await pool.query("delete from lessons where id=$1 and status='draft'", [row.lesson_id]);
  }
  console.info(`Cleaned ${result.rowCount || 0} abandoned uploads.`);
} finally { await pool.end(); }
