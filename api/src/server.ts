import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { auth, takeDevelopmentResetLink } from './auth.js';
import { pool, query } from './db.js';
import { cleanupExpiredMaterials } from './retention.js';
import { beginMultipart, cancelMultipart, deleteObject, finishMultipart, listParts, objectExists, objectMetadata, receiveLocalUpload, sendLocalFile, signGet, signPart, signPut, storageProvider } from './storage.js';

const app = express();
const origin = process.env.APP_ORIGIN;
if (!origin) throw new Error('APP_ORIGIN is required.');

app.use(cors({ origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], exposedHeaders: ['ETag'] }));
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.get('origin') !== origin) return res.status(403).json({ error: 'Request origin is not allowed.' });
  next();
});
app.put('/api/local-storage/upload', async (req, res, next) => {
  try { await receiveLocalUpload(req, res); } catch (error) { next(error); }
});
app.get('/api/local-storage/file', async (req, res, next) => {
  try { await sendLocalFile(req, res); } catch (error) { next(error); }
});

type Role = 'admin' | 'teacher' | 'student';
type SessionUser = { id: string; email: string; name: string };
type RequestWithUser = express.Request & { user?: SessionUser; role?: Role };

const session = async (req: RequestWithUser, res: express.Response, next: express.NextFunction) => {
  try {
    const current = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!current?.user) return res.status(401).json({ error: 'Sign in to continue.' });
    req.user = current.user;
    const result = await query<{ role: Role }>('select role from profiles where id = $1', [current.user.id]);
    if (!result.rowCount) return res.status(403).json({ error: 'This account is not set up for the centre.' });
    req.role = result.rows[0].role;
    await query('update invitations set accepted_at=now() where user_id=$1 and accepted_at is null', [current.user.id]);
    next();
  } catch (error) { next(error); }
};

const allow = (...roles: Role[]) => (req: RequestWithUser, res: express.Response, next: express.NextFunction) => {
  if (!req.role || !roles.includes(req.role)) return res.status(403).json({ error: 'You do not have access to this action.' });
  next();
};

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/me', session, async (req: RequestWithUser, res, next) => {
  try {
    const result = await query('select id, display_name, role from profiles where id = $1', [req.user!.id]);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

// The route layer derives identity and role from the Better Auth session. Domain routes are
// added here as each data.ts service is moved behind the API.
app.get('/api/spaces', session, async (req: RequestWithUser, res, next) => {
  try {
    let sql: string;
    const values: string[] = [];
    if (req.role === 'student') {
      sql = `select cc.id, c.name as cohort_name, co.title as course_title
        from cohort_courses cc join cohorts c on c.id = cc.cohort_id join courses co on co.id = cc.course_id
        join cohort_members cm on cm.cohort_id = cc.cohort_id where cm.student_id = $1 order by c.name, co.title`;
      values.push(req.user!.id);
    } else if (req.role === 'teacher') {
      sql = `select cc.id, c.name as cohort_name, co.title as course_title
        from cohort_courses cc join cohorts c on c.id = cc.cohort_id join courses co on co.id = cc.course_id
        join teacher_assignments ta on ta.cohort_course_id = cc.id where ta.teacher_id = $1 order by c.name, co.title`;
      values.push(req.user!.id);
    } else {
      sql = `select cc.id, c.name as cohort_name, co.title as course_title
        from cohort_courses cc join cohorts c on c.id = cc.cohort_id join courses co on co.id = cc.course_id order by c.name, co.title`;
    }
    const result = await query(sql, values);
    res.json(result.rows.map(row => ({ id: row.id, cohortName: row.cohort_name, courseTitle: row.course_title })));
  } catch (error) { next(error); }
});

const assertSpace = async (req: RequestWithUser, spaceId: string) => {
  if (req.role === 'admin') return true;
  const relation = req.role === 'teacher' ? 'teacher_assignments' : 'cohort_members';
  const column = req.role === 'teacher' ? 'teacher_id' : 'student_id';
  const spaceJoin = req.role === 'teacher' ? 'x.cohort_course_id = cc.id' : 'x.cohort_id = cc.cohort_id';
  const result = await query(`select 1 from cohort_courses cc join ${relation} x on ${spaceJoin} where cc.id = $1 and x.${column} = $2`, [spaceId, req.user!.id]);
  return Boolean(result.rowCount);
};
const access = async (req: RequestWithUser, res: express.Response, spaceId: string) => {
  if (!await assertSpace(req, spaceId)) { res.status(403).json({ error: 'You do not have access to this learning space.' }); return false; }
  return true;
};

app.get('/api/admin/directory', session, allow('admin'), async (_req, res, next) => {
  try {
    const [profiles, cohorts, courses] = await Promise.all([
      query('select id,display_name,role from profiles order by display_name'),
      query('select id,name from cohorts order by name'),
      query('select id,title from courses order by title'),
    ]);
    res.json({ profiles: profiles.rows, cohorts: cohorts.rows, courses: courses.rows });
  } catch (error) { next(error); }
});
app.post('/api/admin/cohorts', session, allow('admin'), async (req, res, next) => {
  try { const result = await query('insert into cohorts(name) values($1) returning id', [String(req.body.name || '').trim()]); res.status(201).json(result.rows[0]); }
  catch (error) { next(error); }
});
app.post('/api/admin/courses', session, allow('admin'), async (req, res, next) => {
  try { const result = await query('insert into courses(title) values($1) returning id', [String(req.body.title || '').trim()]); res.status(201).json(result.rows[0]); }
  catch (error) { next(error); }
});
app.post('/api/admin/spaces', session, allow('admin'), async (req, res, next) => {
  try { const result = await query('insert into cohort_courses(cohort_id,course_id) values($1,$2) returning id', [req.body.cohortId, req.body.courseId]); res.status(201).json(result.rows[0]); }
  catch (error) { next(error); }
});
app.post('/api/admin/teacher-assignments', session, allow('admin'), async (req, res, next) => {
  try { await query('insert into teacher_assignments(cohort_course_id,teacher_id) values($1,$2) on conflict do nothing', [req.body.spaceId, req.body.teacherId]); res.sendStatus(204); }
  catch (error) { next(error); }
});
app.post('/api/admin/enrollments', session, allow('admin'), async (req, res, next) => {
  try { await query('insert into cohort_members(cohort_id,student_id) values($1,$2) on conflict do nothing', [req.body.cohortId, req.body.studentId]); res.sendStatus(204); }
  catch (error) { next(error); }
});
app.post('/api/admin/invitations', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    const displayName = String(req.body.displayName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = req.body.role as 'student' | 'teacher';
    if (displayName.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || !['student','teacher'].includes(role)) return res.status(400).json({ error: 'Enter a name, valid email, and student or teacher role.' });

    // Recover invitations created by earlier attempts that committed successfully
    // before SMTP delivery failed. The admin can safely submit the same address again.
    const pending = await query<{ id: string; display_name: string; role: Role; accepted_at: Date | null; invitation_id: string | null }>(
      `select p.id,p.display_name,p.role,i.accepted_at,i.id invitation_id from "user" u
       join profiles p on p.id=u.id left join invitations i on i.user_id=u.id where lower(u.email)= $1`, [email]);
    if (pending.rowCount) {
      const existing = pending.rows[0];
      if (existing.role !== role || existing.accepted_at || !existing.invitation_id) {
        return res.status(409).json({ error: 'An account already exists for this email. Use a different address or contact the centre admin.' });
      }
      const delivery = await sendInvitationSetup(email);
      return res.status(200).json({ message: delivery.setupUrl ? 'Pending account found. Copy this setup link and share it with the invitee.' : delivery.sent ? 'Invitation email sent again.' : 'The account is still pending, but email could not be sent. Configure SMTP and retry.', setupUrl: delivery.setupUrl, emailSent: delivery.sent });
    }
    const temporaryPassword = `${crypto.randomUUID()}${crypto.randomUUID()}!`;
    const created = await auth.api.createUser({
      headers: fromNodeHeaders(req.headers),
      body: { email, name: displayName, password: temporaryPassword, role: 'user' },
    });
    if (!created?.user?.id) return res.status(400).json({ error: 'The account could not be created.' });
    await client.query('begin');
    await client.query('insert into profiles(id,display_name,role) values($1,$2,$3)', [created.user.id, displayName, role]);
    await client.query('insert into invitations(user_id,invited_by) values($1,$2)', [created.user.id, req.user!.id]);
    await client.query('commit');
    const delivery = await sendInvitationSetup(email);
    res.status(201).json({
      message: delivery.setupUrl ? 'Account created. Copy this setup link and share it with the invitee.' : delivery.sent ? 'Account created and invitation email sent.' : 'Account created, but the invitation email could not be sent. Configure SMTP, then submit this invite again to retry.',
      setupUrl: delivery.setupUrl,
      emailSent: delivery.sent,
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    next(error);
  } finally { client.release(); }
});

async function sendInvitationSetup(email: string): Promise<{ sent: boolean; setupUrl?: string }> {
  try {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: `${process.env.APP_ORIGIN}/?setup=invite` } });
    const setupUrl = takeDevelopmentResetLink(email);
    return { sent: !setupUrl, setupUrl };
  } catch (error) {
    console.error(`Invitation email could not be delivered for ${email}.`, error);
    return { sent: false };
  }
}

app.get('/api/spaces/:spaceId/lessons', session, async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const result = await query(`select id,cohort_course_id,title,description,kind,storage_key as storage_path,original_name,status,created_at
      from lessons where cohort_course_id=$1 ${req.role === 'student' ? "and status='published'" : ''} order by created_at`, [spaceId]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.get('/api/lessons/:lessonId/completions', session, async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`select lp.lesson_id,lp.student_id,lp.completed_at from lesson_progress lp
      join lessons l on l.id=lp.lesson_id join cohort_courses cc on cc.id=l.cohort_course_id
      where lp.lesson_id=$1 and ( $2='admin' or ($2='student' and lp.student_id=$3 and l.status='published' and
      exists(select 1 from cohort_members cm where cm.cohort_id=cc.cohort_id and cm.student_id=$3)) or
      ($2='teacher' and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=cc.id and ta.teacher_id=$3)) )`, [req.params.lessonId, req.role, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.delete('/api/lessons/:lessonId', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const found = await client.query<{ cohort_course_id: string; storage_key: string | null; upload_key: string | null; multipart_upload_id: string | null; upload_status: string | null }>(
      `select l.cohort_course_id,l.storage_key,fu.object_key upload_key,fu.multipart_upload_id,fu.status upload_status
       from lessons l left join file_uploads fu on fu.lesson_id=l.id where l.id=$1 for update of l`,
      [req.params.lessonId],
    );
    if (!found.rowCount) { await client.query('rollback'); return res.sendStatus(204); }
    const lesson = found.rows[0];
    if (req.role === 'teacher') {
      const assigned = await client.query('select 1 from teacher_assignments where cohort_course_id=$1 and teacher_id=$2', [lesson.cohort_course_id, req.user!.id]);
      if (!assigned.rowCount) { await client.query('rollback'); return res.status(403).json({ error: 'You can only delete materials in your assigned learning spaces.' }); }
    }
    if (lesson.multipart_upload_id && lesson.upload_status === 'pending') await cancelMultipart(lesson.upload_key!, lesson.multipart_upload_id);
    const key = lesson.storage_key || lesson.upload_key;
    if (key) await deleteObject(key);
    await client.query('delete from lessons where id=$1', [req.params.lessonId]);
    await client.query('commit');
    res.sendStatus(204);
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
});
app.post('/api/lessons/:lessonId/complete', session, allow('student'), async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`insert into lesson_progress(lesson_id,student_id) select l.id,$2 from lessons l
      join cohort_courses cc on cc.id=l.cohort_course_id join cohort_members cm on cm.cohort_id=cc.cohort_id
      where l.id=$1 and l.status='published' and cm.student_id=$2 on conflict(lesson_id,student_id) do update set completed_at=lesson_progress.completed_at`, [req.params.lessonId, req.user!.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Published lesson not found in your enrollment.' });
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.get('/api/spaces/:spaceId/students', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const result = await query(`select p.id,p.display_name,p.role from profiles p join cohort_members cm on cm.student_id=p.id
      join cohort_courses cc on cc.cohort_id=cm.cohort_id where cc.id=$1 order by p.display_name`, [spaceId]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/spaces/:spaceId/sessions', session, async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const result = await query('select * from class_sessions where cohort_course_id=$1 order by starts_at', [spaceId]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.get('/api/spaces/:spaceId/attendance', session, async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const result = await query(`select a.* from attendance a join class_sessions s on s.id=a.session_id
      where s.cohort_course_id=$1 and ($2<>'student' or a.student_id=$3) order by s.starts_at desc`, [spaceId, req.role, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.post('/api/spaces/:spaceId/sessions', session, allow('teacher'), async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const result = await query(`insert into class_sessions(cohort_course_id,title,starts_at,ends_at,meeting_url,created_by)
      values($1,$2,$3,$4,$5,$6) returning id`, [spaceId, String(req.body.title || '').trim(), req.body.startsAt, req.body.endsAt || null, req.body.meetingUrl || null, req.user!.id]);
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});
app.get('/api/sessions/:sessionId/attendance', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`select a.* from attendance a join class_sessions s on s.id=a.session_id
      where a.session_id=$1 and ($2='admin' or exists(select 1 from teacher_assignments ta where ta.cohort_course_id=s.cohort_course_id and ta.teacher_id=$3))`, [req.params.sessionId, req.role, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.put('/api/sessions/:sessionId/attendance', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const context = await client.query('select cohort_course_id from class_sessions where id=$1 for update', [req.params.sessionId]);
    if (!context.rowCount || (req.role === 'teacher' && !await assertSpace(req, context.rows[0].cohort_course_id))) { await client.query('rollback'); return res.status(403).json({ error: 'You cannot mark this session.' }); }
    const sessionSpace = context.rows[0].cohort_course_id;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.some((r: any) => !['attended','missed','cancelled'].includes(r.attendance_status))) { await client.query('rollback'); return res.status(400).json({ error: 'Choose an attendance status for every student.' }); }
    for (const row of rows) {
      const enrolled = await client.query(`select 1 from class_sessions s join cohort_courses cc on cc.id=s.cohort_course_id
        join cohort_members cm on cm.cohort_id=cc.cohort_id where s.id=$1 and cm.student_id=$2`, [req.params.sessionId, row.student_id]);
      if (!enrolled.rowCount) throw new Error('Attendance includes a student who is not enrolled in this class.');
      const packageRow = await client.query<{ current_cycle: number }>('select current_cycle from student_packages where student_id=$1 and cohort_course_id=$2 for update', [row.student_id, sessionSpace]);
      const cycle = packageRow.rows[0]?.current_cycle || 1;
      await client.query(`insert into attendance(session_id,student_id,attendance_status,counts_toward_package,package_cycle,marked_by)
        values($1,$2,$3,$4,$5,$6) on conflict(session_id,student_id) do update set attendance_status=excluded.attendance_status,
        counts_toward_package=excluded.counts_toward_package,marked_by=excluded.marked_by,marked_at=now()`,
        [req.params.sessionId, row.student_id, row.attendance_status, Boolean(row.counts_toward_package), cycle, req.user!.id]);
    }
    for (const row of rows) {
      await client.query(`update student_packages p set sessions_attended=(select count(*)::int from attendance a join class_sessions s on s.id=a.session_id
        where a.student_id=p.student_id and s.cohort_course_id=p.cohort_course_id and a.package_cycle=p.current_cycle and a.counts_toward_package),
        status=case when p.status='locked_future' then p.status when (select count(*) from attendance a join class_sessions s on s.id=a.session_id
        where a.student_id=p.student_id and s.cohort_course_id=p.cohort_course_id and a.package_cycle=p.current_cycle and a.counts_toward_package)>=
        (select class_count from package_plans where id=p.plan_id) then 'payment_due' else 'active' end,updated_at=now()
        where p.student_id=$1 and p.cohort_course_id=$2`, [row.student_id, sessionSpace]);
    }
    await client.query('commit');
    res.sendStatus(204);
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
});

app.get('/api/package-plans', session, async (_req, res, next) => {
  try { const result = await query("select id,name,class_count,amount,active from package_plans where active=true order by class_count"); res.json(result.rows); }
  catch (error) { next(error); }
});
app.post('/api/admin/package-plans', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  try { await query('insert into package_plans(name,class_count,amount,created_by) values($1,$2,$3,$4)', [String(req.body.name || '').trim(), Number(req.body.classCount), Number(req.body.amount), req.user!.id]); res.sendStatus(201); }
  catch (error) { next(error); }
});
app.get('/api/spaces/:spaceId/packages', session, async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const result = await query(`select sp.id,sp.student_id,sp.cohort_course_id,sp.plan_id,sp.sessions_attended,sp.status,
      json_build_object('id',pp.id,'name',pp.name,'class_count',pp.class_count,'amount',pp.amount,'active',pp.active) package_plans,
      json_build_object('display_name',p.display_name) profiles from student_packages sp join package_plans pp on pp.id=sp.plan_id
      join profiles p on p.id=sp.student_id where sp.cohort_course_id=$1 and ($2<>'student' or sp.student_id=$3) order by sp.created_at`, [spaceId, req.role, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.post('/api/admin/student-packages', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    const studentId = String(req.body.studentId || '');
    const spaceId = String(req.body.spaceId || '');
    const planId = String(req.body.planId || '');
    await client.query('begin');
    const eligibility = await client.query<{ enrolled: boolean; active_plan: boolean }>(`select
      exists(select 1 from cohort_courses cc join cohort_members cm on cm.cohort_id=cc.cohort_id join profiles p on p.id=cm.student_id
        where cc.id=$1 and cm.student_id=$2 and p.role='student') enrolled,
      exists(select 1 from package_plans where id=$3 and active=true) active_plan`, [spaceId, studentId, planId]);
    if (!eligibility.rows[0]?.enrolled) { await client.query('rollback'); return res.status(400).json({ error: 'Enroll this student in the learning space before assigning a package.' }); }
    if (!eligibility.rows[0]?.active_plan) { await client.query('rollback'); return res.status(400).json({ error: 'Choose an active package plan.' }); }
    const created = await client.query(`insert into student_packages(student_id,cohort_course_id,plan_id,created_by)
      values($1,$2,$3,$4) on conflict(student_id,cohort_course_id) do nothing returning id`, [studentId, spaceId, planId, req.user!.id]);
    if (!created.rowCount) {
      const current = await client.query<{ id: string; status: string; sessions_attended: number; has_payment: boolean; has_attendance: boolean }>(`select sp.id,sp.status,sp.sessions_attended,
        exists(select 1 from package_payments pp where pp.student_package_id=sp.id) has_payment,
        exists(select 1 from attendance a join class_sessions cs on cs.id=a.session_id where a.student_id=sp.student_id
          and cs.cohort_course_id=sp.cohort_course_id and a.package_cycle=sp.current_cycle) has_attendance
        from student_packages sp where sp.student_id=$1 and sp.cohort_course_id=$2 for update`, [studentId, spaceId]);
      if (!current.rowCount || current.rows[0].status !== 'active' || current.rows[0].sessions_attended > 0 || current.rows[0].has_payment || current.rows[0].has_attendance) {
        await client.query('rollback');
        return res.status(409).json({ error: 'This package is already in use. Confirm payment to start its next cycle.' });
      }
      await client.query('update student_packages set plan_id=$2,updated_at=now() where id=$1', [current.rows[0].id, planId]);
    }
    await client.query('commit');
    res.sendStatus(created.rowCount ? 201 : 200);
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
});
app.get('/api/student-packages/:packageId/payments', session, async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`select pp.id,pp.student_package_id,pp.amount,pp.paid_at,pp.reference,pp.receipt_key as receipt_path,pp.confirmed_at
      from package_payments pp join student_packages sp on sp.id=pp.student_package_id
      where sp.id=$1 and ($2='admin' or ($2='student' and sp.student_id=$3) or ($2='teacher' and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=sp.cohort_course_id and ta.teacher_id=$3))) order by pp.paid_at desc`, [req.params.packageId, req.role, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});
app.post('/api/admin/student-packages/:packageId/confirm-payment', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const pkg = await client.query("select * from student_packages where id=$1 and status='payment_due' for update", [req.params.packageId]);
    if (!pkg.rowCount) { await client.query('rollback'); return res.status(409).json({ error: 'This package is not awaiting payment.' }); }
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a valid payment amount.');
    const receiptKey = req.body.receiptPath ? String(req.body.receiptPath) : null;
    if (receiptKey) {
      if (!receiptKey.startsWith(`receipts/${req.params.packageId}/`) || !await objectExists(receiptKey)) throw new Error('Upload a receipt for this package before confirming payment.');
      const meta = await objectMetadata(receiptKey);
      if (meta.contentLength > 10 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','application/pdf'].includes(meta.contentType)) throw new Error('Receipt must be a supported image or PDF up to 10 MB.');
    }
    await client.query(`insert into package_payments(student_package_id,amount,paid_at,reference,receipt_provider,receipt_key,confirmed_by)
      values($1,$2,$3,$4,$5,$6,$7)`, [req.params.packageId, amount, req.body.paidAt || new Date(), String(req.body.reference || '').trim() || null, receiptKey ? storageProvider : null, receiptKey, req.user!.id]);
    await client.query("update student_packages set sessions_attended=0,current_cycle=current_cycle+1,status='active',updated_at=now() where id=$1", [req.params.packageId]);
    await client.query('commit');
    res.sendStatus(204);
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
});

const cleanFilename = (name: unknown) => String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
app.post('/api/spaces/:spaceId/lessons', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const kind = req.body.kind === 'reading' ? 'reading' : 'recording';
    const result = await query(`insert into lessons(cohort_course_id,title,description,kind,created_by)
      values($1,$2,$3,$4,$5) returning id`, [spaceId, String(req.body.title || '').trim(), String(req.body.description || '').trim() || null, kind, req.user!.id]);
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) { next(error); }
});
app.post('/api/lessons/:lessonId/upload', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const lesson = await query(`select l.id,l.kind,l.cohort_course_id from lessons l where l.id=$1 and l.status='draft'
      and ($2='admin' or exists(select 1 from teacher_assignments ta where ta.cohort_course_id=l.cohort_course_id and ta.teacher_id=$3))`, [req.params.lessonId, req.role, req.user!.id]);
    if (!lesson.rowCount) return res.status(404).json({ error: 'Draft lesson not found.' });
    const id = String(req.params.lessonId);
    const contentType = String(req.body.contentType || 'application/octet-stream');
    const allowedTypes = lesson.rows[0].kind === 'recording'
      ? ['video/mp4','video/webm','video/quicktime'] : ['application/pdf','text/plain'];
    if (!allowedTypes.includes(contentType)) return res.status(415).json({ error: 'This file type is not supported for the selected material.' });
    const previous = await query<{ owner_id: string; object_key: string; multipart_upload_id: string | null; status: string }>(
      'select owner_id,object_key,multipart_upload_id,status from file_uploads where lesson_id=$1', [id]);
    if (previous.rowCount && req.role !== 'admin' && previous.rows[0].owner_id !== req.user!.id) return res.status(403).json({ error: 'Only the teacher who started this upload can resume it.' });
    if (previous.rowCount && previous.rows[0].status === 'pending') {
      const saved = previous.rows[0];
      if (saved.multipart_upload_id) return res.status(200).json({ key: saved.object_key, uploadId: saved.multipart_upload_id, partSize: 8 * 1024 * 1024 });
      return res.status(200).json({ key: saved.object_key, uploadUrl: await signPut(saved.object_key, String(req.body.contentType || 'application/octet-stream')) });
    }
    if (previous.rowCount) {
      if (previous.rows[0].multipart_upload_id) await cancelMultipart(previous.rows[0].object_key, previous.rows[0].multipart_upload_id).catch(() => undefined);
      await deleteObject(previous.rows[0].object_key).catch(() => undefined);
    }
    const key = `lessons/${lesson.rows[0].cohort_course_id}/${id}/${crypto.randomUUID()}-${cleanFilename(req.body.fileName)}`;
    if (lesson.rows[0].kind === 'recording' && storageProvider !== 'local') {
      const uploadId = await beginMultipart(key, contentType);
      await query(`insert into file_uploads(lesson_id,owner_id,object_key,multipart_upload_id,status)
        values($1,$2,$3,$4,'pending') on conflict(lesson_id) do update set owner_id=excluded.owner_id,object_key=excluded.object_key,multipart_upload_id=excluded.multipart_upload_id,status='pending',created_at=now()`, [id, req.user!.id, key, uploadId]);
      return res.status(201).json({ key, uploadId, partSize: 8 * 1024 * 1024 });
    }
    const uploadUrl = await signPut(key, contentType);
    await query(`insert into file_uploads(lesson_id,owner_id,object_key,status) values($1,$2,$3,'pending')
      on conflict(lesson_id) do update set owner_id=excluded.owner_id,object_key=excluded.object_key,multipart_upload_id=null,status='pending',created_at=now()`, [id, req.user!.id, key]);
    res.status(201).json({ key, uploadUrl });
  } catch (error) { next(error); }
});
const ownUpload = async (req: RequestWithUser) => query<{ object_key: string; multipart_upload_id: string | null; status: string }>(
  `select fu.object_key,fu.multipart_upload_id,fu.status from file_uploads fu join lessons l on l.id=fu.lesson_id
   where fu.lesson_id=$1 and ($2='admin' or (fu.owner_id=$3 and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=l.cohort_course_id and ta.teacher_id=$3)))`,
  [req.params.lessonId, req.role, req.user!.id]);
app.get('/api/lessons/:lessonId/upload/:uploadId/parts', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const upload = await ownUpload(req);
    if (!upload.rowCount || upload.rows[0].multipart_upload_id !== req.params.uploadId) return res.status(404).json({ error: 'Upload not found.' });
    res.json(await listParts(upload.rows[0].object_key, req.params.uploadId));
  } catch (error) { next(error); }
});
app.post('/api/lessons/:lessonId/upload/:uploadId/part-url', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const upload = await ownUpload(req);
    const partNumber = Number(req.body.partNumber);
    if (!upload.rowCount || upload.rows[0].multipart_upload_id !== req.params.uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return res.status(400).json({ error: 'Upload part is invalid.' });
    res.json({ url: await signPart(upload.rows[0].object_key, req.params.uploadId, partNumber) });
  } catch (error) { next(error); }
});
app.post('/api/lessons/:lessonId/upload/:uploadId/complete', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const upload = await ownUpload(req);
    if (!upload.rowCount || upload.rows[0].multipart_upload_id !== req.params.uploadId) return res.status(404).json({ error: 'Upload not found.' });
    const parts = Array.isArray(req.body.parts) ? req.body.parts : [];
    if (!parts.length) return res.status(400).json({ error: 'Upload has no completed parts.' });
    await finishMultipart(upload.rows[0].object_key, req.params.uploadId, parts);
    await query("update file_uploads set status='uploaded',updated_at=now() where lesson_id=$1", [req.params.lessonId]);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.post('/api/lessons/:lessonId/upload/:uploadId/abort', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const upload = await ownUpload(req);
    if (!upload.rowCount || upload.rows[0].multipart_upload_id !== req.params.uploadId) return res.status(404).json({ error: 'Upload not found.' });
    await cancelMultipart(upload.rows[0].object_key, req.params.uploadId);
    await query("update file_uploads set status='abandoned',updated_at=now() where lesson_id=$1", [req.params.lessonId]);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.post('/api/lessons/:lessonId/publish', session, allow('teacher','admin'), async (req: RequestWithUser, res, next) => {
  try {
    const upload = await ownUpload(req);
    if (!upload.rowCount || !['uploaded','pending'].includes(upload.rows[0].status) || !await objectExists(upload.rows[0].object_key)) return res.status(409).json({ error: 'Finish the file upload before publishing.' });
    if (!storageProvider) return res.status(503).json({ error: 'Configure private file storage before publishing materials.' });
    const update = await query(`update lessons set storage_provider=$4,storage_key=$2,original_name=$3,status='published',published_at=now()
      where id=$1 and status='draft' returning id`, [req.params.lessonId, upload.rows[0].object_key, String(req.body.fileName || '').slice(0,255), storageProvider]);
    if (!update.rowCount) return res.status(409).json({ error: 'The draft lesson cannot be published.' });
    await query("update file_uploads set status='published',updated_at=now() where lesson_id=$1", [req.params.lessonId]);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.get('/api/lessons/:lessonId/file', session, async (req: RequestWithUser, res, next) => {
  try {
    const lesson = await query(`select l.storage_key,l.status,l.cohort_course_id from lessons l where l.id=$1 and l.storage_provider=$4
      and ($2='admin' or exists(select 1 from teacher_assignments ta where ta.cohort_course_id=l.cohort_course_id and ta.teacher_id=$3)
      or ($2='student' and l.status='published' and exists(select 1 from cohort_courses cc join cohort_members cm on cm.cohort_id=cc.cohort_id where cc.id=l.cohort_course_id and cm.student_id=$3)))`, [req.params.lessonId, req.role, req.user!.id, storageProvider]);
    if (!lesson.rowCount) return res.status(404).json({ error: 'File not found or you do not have access.' });
    res.json({ signedUrl: await signGet(lesson.rows[0].storage_key) });
  } catch (error) { next(error); }
});

app.post('/api/student-packages/:packageId/receipt-upload', session, allow('admin'), async (req, res, next) => {
  try {
    const contentType = String(req.body.contentType || '');
    const size = Number(req.body.size);
    if (!['image/jpeg','image/png','image/webp','application/pdf'].includes(contentType) || !Number.isFinite(size) || size < 1 || size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Receipts must be a JPEG, PNG, WebP, or PDF up to 10 MB.' });
    const exists = await query('select id from student_packages where id=$1', [req.params.packageId]);
    if (!exists.rowCount) return res.status(404).json({ error: 'Package not found.' });
    const key = `receipts/${req.params.packageId}/${crypto.randomUUID()}-${cleanFilename(req.body.fileName)}`;
    res.status(201).json({ key, uploadUrl: await signPut(key, contentType) });
  } catch (error) { next(error); }
});
app.delete('/api/student-packages/:packageId/receipt', session, allow('admin'), async (req, res, next) => {
  try {
    const key = String(req.body.key || '');
    if (!key.startsWith(`receipts/${req.params.packageId}/`)) return res.status(400).json({ error: 'Receipt does not belong to this package.' });
    await deleteObject(key);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.get('/api/payment-receipts', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`select receipt_key from package_payments where receipt_key=$1`, [req.query.key]);
    if (!result.rowCount || !result.rows[0].receipt_key) return res.status(404).json({ error: 'Receipt not found.' });
    res.json({ signedUrl: await signGet(result.rows[0].receipt_key) });
  } catch (error) { next(error); }
});

app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: 'The request could not be completed.' });
});

const port = Number(process.env.PORT || 3001);
const server = app.listen(port, () => console.info(`Astute API listening on ${port}`));
let retentionCleanupRunning = false;
const runRetentionCleanup = async () => {
  if (retentionCleanupRunning) return;
  retentionCleanupRunning = true;
  try {
    const removed = await cleanupExpiredMaterials();
    if (removed) console.info(`Permanently removed ${removed} materials older than 20 days.`);
  } catch (error) { console.error('Material retention cleanup failed; it will be retried.', error); }
  finally { retentionCleanupRunning = false; }
};
const retentionTimer = setInterval(() => void runRetentionCleanup(), 60 * 60 * 1000);
retentionTimer.unref();
void runRetentionCleanup();
const shutdown = () => { clearInterval(retentionTimer); server.close(() => void pool.end()); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
