import 'dotenv/config';

if (process.env.SEED_DEMO !== 'true') {
  throw new Error('Set SEED_DEMO=true to run demo account seeding.');
}

process.env.BOOTSTRAP_ADMIN = 'true';

type DemoRole = 'admin' | 'teacher' | 'student';

const password = process.env.SEED_PASSWORD ?? 'welcome@2026';
if (password.length < 10) throw new Error('SEED_PASSWORD must be at least 10 characters.');

const accounts: Array<{ email: string; name: string; role: DemoRole }> = [
  {
    email: (process.env.SEED_ADMIN_EMAIL ?? 'demo-admin@tutionlms.demo').trim().toLowerCase(),
    name: process.env.SEED_ADMIN_NAME?.trim() || 'Demo Admin',
    role: 'admin',
  },
  {
    email: (process.env.SEED_TEACHER_EMAIL ?? 'demo-teacher@tutionlms.demo').trim().toLowerCase(),
    name: process.env.SEED_TEACHER_NAME?.trim() || 'Demo Teacher',
    role: 'teacher',
  },
  {
    email: (process.env.SEED_STUDENT_EMAIL ?? 'demo-student@tutionlms.demo').trim().toLowerCase(),
    name: process.env.SEED_STUDENT_NAME?.trim() || 'Demo Student',
    role: 'student',
  },
];

const { auth } = await import('./auth.js');
const { pool } = await import('./db.js');

async function removeDemoUser(email: string) {
  await pool.query('delete from "user" where lower(email) = $1', [email]);
}

try {
  for (const account of accounts) {
    await removeDemoUser(account.email);
    const created = await auth.api.signUpEmail({
      body: { email: account.email, name: account.name, password },
    });
    if (!created?.user?.id) throw new Error(`Better Auth did not create ${account.email}.`);

    const client = await pool.connect();
    try {
      await client.query('begin');
      if (account.role === 'admin') {
        await client.query("update \"user\" set role = 'admin' where id = $1", [created.user.id]);
      }
      await client.query(
        `insert into profiles (id, display_name, role) values ($1, $2, $3)
         on conflict (id) do update set display_name = excluded.display_name, role = excluded.role`,
        [created.user.id, account.name, account.role],
      );
      await client.query('commit');
      console.info(`Seeded ${account.role}: ${account.email}`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  console.info('Demo accounts ready. Sign in at your APP_ORIGIN with the seeded emails and SEED_PASSWORD.');
} finally {
  await pool.end();
}
