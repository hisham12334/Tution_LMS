import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  pool.query<T>(text, values);
