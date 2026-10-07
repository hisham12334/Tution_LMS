import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './db.js';

try {
  const directory = resolve(import.meta.dirname, '../migrations');
  const migrations = (await readdir(directory)).filter(name => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  try {
    for (const name of migrations) {
      await client.query('begin');
      try {
        await client.query('select pg_advisory_xact_lock(7730142026)');
        await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
        const found = await client.query('select 1 from schema_migrations where name=$1', [name]);
        if (!found.rowCount) {
          await client.query(await readFile(resolve(directory, name), 'utf8'));
          await client.query('insert into schema_migrations(name) values ($1)', [name]);
          console.info(`Applied ${name}.`);
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally { client.release(); }
} finally { await pool.end(); }
