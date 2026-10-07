import 'dotenv/config';
import { pool } from './db.js';
import { cleanupExpiredMaterials } from './retention.js';

try {
  console.info(`Permanently deleted ${await cleanupExpiredMaterials()} materials older than 20 days.`);
} finally {
  await pool.end();
}
