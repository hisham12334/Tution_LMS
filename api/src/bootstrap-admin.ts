import 'dotenv/config';
import { auth } from './auth.js';
import { pool } from './db.js';

if (process.env.BOOTSTRAP_ADMIN !== 'true') throw new Error('Set BOOTSTRAP_ADMIN=true for this one-time command.');
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.ADMIN_NAME?.trim();
const password = process.env.ADMIN_PASSWORD;
if (!email || !name || !password || password.length < 10) throw new Error('Set ADMIN_EMAIL, ADMIN_NAME, and a 10+ character ADMIN_PASSWORD.');

try {
  const created = await auth.api.signUpEmail({ body: { email, name, password } });
  if (!created?.user) throw new Error('Better Auth did not create the admin identity.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("update \"user\" set role='admin' where id=$1", [created.user.id]);
    await client.query("insert into profiles(id,display_name,role) values($1,$2,'admin')", [created.user.id, name]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  console.info(`Created initial admin ${email}. Remove BOOTSTRAP_ADMIN and the ADMIN_* variables before starting the API.`);
} finally { await pool.end(); }
