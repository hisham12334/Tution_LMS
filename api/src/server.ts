import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
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

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, database: 'ready' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});
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

const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(0);
let chatListener: PoolClient | null = null;
let chatListenerStarting = false;
let chatStopping = false;
async function listenForChat() {
  if (chatStopping || chatListener || chatListenerStarting) return;
  chatListenerStarting = true;
  try {
    const client = await pool.connect();
    chatListener = client;
    const reconnect = () => {
      if (chatListener !== client) return;
      chatListener = null;
      client.release(true);
      if (!chatStopping) setTimeout(() => void listenForChat(), 1000).unref();
    };
    client.on('notification', notification => {
      if (notification.channel !== 'chat_messages' || !notification.payload) return;
      try {
        const event = JSON.parse(notification.payload) as { conversationId?: string; messageId?: string; senderId?: string };
        if (uuid(event.conversationId) && chatCursor(event.messageId) && typeof event.senderId === 'string') chatEvents.emit('changed', event);
      } catch (error) { console.error('Invalid chat notification.', error); }
    });
    client.on('error', reconnect);
    client.on('end', reconnect);
    await client.query('listen chat_messages');
  } catch (error) {
    console.error('Chat event listener will reconnect.', error);
    if (chatListener) { const client = chatListener; chatListener = null; client.release(true); }
    if (!chatStopping) setTimeout(() => void listenForChat(), 1000).unref();
  } finally { chatListenerStarting = false; }
}

const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const chatCursor = (value: unknown) => typeof value === 'string' && /^\d{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : null;
const canReadConversation = async (req: RequestWithUser, conversationId: string) => {
  const found = await query(`select 1 from chat_conversations c join cohort_courses cc on cc.id=c.cohort_course_id
    where c.id=$1 and ($2='admin'
      or ($2='student' and c.student_id=$3 and exists(select 1 from cohort_members cm where cm.cohort_id=cc.cohort_id and cm.student_id=$3))
      or ($2='teacher' and c.teacher_id=$3 and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=cc.id and ta.teacher_id=$3)))`,
    [conversationId, req.role, req.user!.id]);
  return Boolean(found.rowCount);
};

app.get('/api/chat/contacts', session, allow('student', 'teacher'), async (req: RequestWithUser, res, next) => {
  try {
    if (!uuid(req.query.spaceId)) return res.status(400).json({ error: 'Choose a valid learning space.' });
    const result = req.role === 'student'
      ? await query(`select distinct p.id, p.display_name from cohort_courses cc
          join cohort_members cm on cm.cohort_id=cc.cohort_id and cm.student_id=$2
          join teacher_assignments ta on ta.cohort_course_id=cc.id
          join profiles p on p.id=ta.teacher_id where cc.id=$1 order by p.display_name`, [req.query.spaceId, req.user!.id])
      : await query(`select distinct p.id, p.display_name from cohort_courses cc
          join teacher_assignments ta on ta.cohort_course_id=cc.id and ta.teacher_id=$2
          join cohort_members cm on cm.cohort_id=cc.cohort_id
          join profiles p on p.id=cm.student_id where cc.id=$1 order by p.display_name`, [req.query.spaceId, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/chat/conversations', session, async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`select c.id, c.cohort_course_id as "spaceId", c.student_id as "studentId", c.teacher_id as "teacherId",
      sp.display_name as "studentName", tp.display_name as "teacherName", co.title as "courseTitle", ch.name as "cohortName",
      last_message.body as "lastMessage", last_message.created_at as "lastAt", unread.count as "unreadCount"
      from chat_conversations c join profiles sp on sp.id=c.student_id join profiles tp on tp.id=c.teacher_id
      join cohort_courses cc on cc.id=c.cohort_course_id join cohorts ch on ch.id=cc.cohort_id join courses co on co.id=cc.course_id
      left join lateral (select body,created_at from chat_messages where conversation_id=c.id order by id desc limit 1) last_message on true
      left join chat_reads cr on cr.conversation_id=c.id and cr.user_id=$2
      cross join lateral (select count(*)::int as count from chat_messages m where m.conversation_id=c.id
        and m.id > coalesce(cr.last_read_message_id,0) and m.sender_id<>$2) unread
      where ($1='admin'
        or ($1='student' and c.student_id=$2 and exists(select 1 from cohort_members cm where cm.cohort_id=cc.cohort_id and cm.student_id=$2))
        or ($1='teacher' and c.teacher_id=$2 and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=cc.id and ta.teacher_id=$2)))
      order by last_message.created_at desc nulls last, c.created_at desc`, [req.role, req.user!.id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/chat/unread', session, async (req: RequestWithUser, res, next) => {
  try {
    const result = await query(`select count(*)::int as count from chat_messages m
      join chat_conversations c on c.id=m.conversation_id
      join cohort_courses cc on cc.id=c.cohort_course_id
      left join chat_reads cr on cr.conversation_id=c.id and cr.user_id=$2
      where m.id>coalesce(cr.last_read_message_id,0) and m.sender_id<>$2
      and ($1='admin'
        or ($1='student' and c.student_id=$2 and exists(select 1 from cohort_members cm where cm.cohort_id=cc.cohort_id and cm.student_id=$2))
        or ($1='teacher' and c.teacher_id=$2 and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=cc.id and ta.teacher_id=$2)))`,
      [req.role, req.user!.id]);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.post('/api/chat/conversations/:conversationId/read', session, async (req: RequestWithUser, res, next) => {
  try {
    const id = String(req.params.conversationId);
    const messageId = chatCursor(req.body?.messageId);
    if (!uuid(id) || !messageId) return res.status(400).json({ error: 'Invalid read position.' });
    if (!await canReadConversation(req, id)) return res.status(403).json({ error: 'You do not have access to this conversation.' });
    const updated = await query(`insert into chat_reads(conversation_id,user_id,last_read_message_id)
      select m.conversation_id,$2,m.id from chat_messages m where m.conversation_id=$1 and m.id=$3
      on conflict (conversation_id,user_id) do update set
        last_read_message_id=greatest(chat_reads.last_read_message_id,excluded.last_read_message_id), read_at=now()
      returning last_read_message_id`, [id, req.user!.id, messageId]);
    if (!updated.rowCount) return res.status(400).json({ error: 'Message is not in this conversation.' });
    res.sendStatus(204);
  } catch (error) { next(error); }
});

app.post('/api/chat/conversations', session, allow('student', 'teacher'), async (req: RequestWithUser, res, next) => {
  try {
    const { spaceId, peerId } = req.body || {};
    if (!uuid(spaceId) || typeof peerId !== 'string' || !peerId) return res.status(400).json({ error: 'Choose a valid contact.' });
    const studentId = req.role === 'student' ? req.user!.id : peerId;
    const teacherId = req.role === 'teacher' ? req.user!.id : peerId;
    const eligible = await query(`select 1 from cohort_courses cc
      join cohort_members cm on cm.cohort_id=cc.cohort_id and cm.student_id=$2
      join teacher_assignments ta on ta.cohort_course_id=cc.id and ta.teacher_id=$3
      where cc.id=$1`, [spaceId, studentId, teacherId]);
    if (!eligible.rowCount) return res.status(403).json({ error: 'This student and teacher are not connected in this learning space.' });
    await query(`insert into chat_conversations(cohort_course_id,student_id,teacher_id) values($1,$2,$3) on conflict do nothing`, [spaceId, studentId, teacherId]);
    const result = await query<{ id: string }>(`select id from chat_conversations where cohort_course_id=$1 and student_id=$2 and teacher_id=$3`, [spaceId, studentId, teacherId]);
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/chat/conversations/:conversationId/messages', session, async (req: RequestWithUser, res, next) => {
  try {
    const id = String(req.params.conversationId);
    if (!uuid(id)) return res.status(400).json({ error: 'Invalid conversation.' });
    if (!await canReadConversation(req, id)) return res.status(403).json({ error: 'You do not have access to this conversation.' });
    const before = req.query.before === undefined ? null : chatCursor(req.query.before);
    const after = req.query.after === undefined ? null : chatCursor(req.query.after);
    if ((req.query.before !== undefined && !before) || (req.query.after !== undefined && !after) || (before && after)) return res.status(400).json({ error: 'Invalid message cursor.' });
    const result = await query(`select m.id::text, m.sender_id as "senderId", p.display_name as "senderName", m.body, m.created_at as "createdAt"
      from chat_messages m join profiles p on p.id=m.sender_id where m.conversation_id=$1
      and ($2::bigint is null or m.id < $2) and ($3::bigint is null or m.id > $3)
      order by m.id ${after ? 'asc' : 'desc'} limit 101`, [id, before, after]);
    const hasMore = result.rows.length > 100;
    const rows = result.rows.slice(0, 100);
    res.json({ messages: after ? rows : rows.reverse(), hasMore });
  } catch (error) { next(error); }
});

app.post('/api/chat/conversations/:conversationId/messages', session, allow('student', 'teacher'), async (req: RequestWithUser, res, next) => {
  try {
    const id = String(req.params.conversationId);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!uuid(id) || !body || body.length > 2000) return res.status(400).json({ error: 'Enter a message of up to 2,000 characters.' });
    const inserted = await query(`insert into chat_messages(conversation_id,sender_id,body)
      select c.id,$2,$3 from chat_conversations c join cohort_courses cc on cc.id=c.cohort_course_id
      where c.id=$1 and (($4='student' and c.student_id=$2 and exists(select 1 from cohort_members cm where cm.cohort_id=cc.cohort_id and cm.student_id=$2))
        or ($4='teacher' and c.teacher_id=$2 and exists(select 1 from teacher_assignments ta where ta.cohort_course_id=cc.id and ta.teacher_id=$2)))
      returning id::text`, [id, req.user!.id, body, req.role]);
    if (!inserted.rowCount) return res.status(403).json({ error: 'You do not have access to send in this conversation.' });
    await query('select pg_notify($1,$2)', ['chat_messages', JSON.stringify({ conversationId: id, messageId: inserted.rows[0].id, senderId: req.user!.id })]).catch(error => console.error('Chat notification failed; connected clients will resync.', error));
    res.status(201).json(inserted.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/chat/events', session, async (req: RequestWithUser, res, next) => {
  try {
    await listenForChat();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: sync\ndata: {}\n\n');
    const changed = (event: { conversationId: string; messageId: string; senderId: string }) => {
      void canReadConversation(req, event.conversationId).then(allowed => {
        if (allowed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      }).catch(error => console.error('Chat event access check failed.', error));
    };
    chatEvents.on('changed', changed);
    const shutdownStream = () => res.end();
    chatEvents.on('shutdown', shutdownStream);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write('event: sync\ndata: {}\n\n'); }, 15000);
    const lifetime = setTimeout(() => res.end(), 5 * 60 * 1000);
    const cleanup = () => { chatEvents.off('changed', changed); chatEvents.off('shutdown', shutdownStream); clearInterval(heartbeat); clearTimeout(lifetime); };
    res.on('close', cleanup);
  } catch (error) { next(error); }
});

const indiaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const validMonth = (value: unknown) => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
const validDay = (value: unknown) => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value: unknown) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

app.get('/api/spaces/:spaceId/working-hours', session, async (req: RequestWithUser, res, next) => {
  try {
    if (!await access(req, res, String(req.params.spaceId))) return;
    const result = await query(`select effective_from::text, to_char(starts_at,'HH24:MI') starts_at,
      to_char(ends_at,'HH24:MI') ends_at from space_working_hours where cohort_course_id=$1 order by effective_from desc limit 1`, [req.params.spaceId]);
    res.json(result.rows[0] || null);
  } catch (error) { next(error); }
});
app.put('/api/admin/spaces/:spaceId/working-hours', session, allow('admin'), async (req, res, next) => {
  try {
    const { startsAt, endsAt } = req.body;
    if (!validTime(startsAt) || !validTime(endsAt) || startsAt >= endsAt) return res.status(400).json({ error: 'Choose a valid start and end time in IST.' });
    const result = await query(`insert into space_working_hours(cohort_course_id,effective_from,starts_at,ends_at)
      values($1,$2,$3,$4) on conflict(cohort_course_id,effective_from) do update
      set starts_at=excluded.starts_at,ends_at=excluded.ends_at returning id`, [req.params.spaceId, indiaDate(), startsAt, endsAt]);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});
app.get('/api/teacher-attendance/:teacherId', session, async (req: RequestWithUser, res, next) => {
  try {
    const teacherId = String(req.params.teacherId);
    if (req.role !== 'admin' && (req.role !== 'teacher' || req.user!.id !== teacherId)) return res.status(403).json({ error: 'You cannot view this attendance.' });
    const month = validMonth(req.query.month);
    if (!month) return res.status(400).json({ error: 'Choose a valid month.' });
    const teacher = await query('select 1 from profiles where id=$1 and role=$2', [teacherId, 'teacher']);
    if (!teacher.rowCount) return res.status(404).json({ error: 'Teacher not found.' });
    const first = `${month}-01`;
    const nextMonth = new Date(`${first}T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const end = nextMonth.toISOString().slice(0, 10);
    const [spaces, hours, links, overrides] = await Promise.all([
      query(`select cc.id,c.name cohort_name,co.title course_title,(ta.created_at at time zone 'Asia/Kolkata')::date::text assigned_from
        from teacher_assignments ta join cohort_courses cc on cc.id=ta.cohort_course_id
        join cohorts c on c.id=cc.cohort_id join courses co on co.id=cc.course_id where ta.teacher_id=$1`, [teacherId]),
      query(`select h.cohort_course_id,h.effective_from::text,to_char(h.starts_at,'HH24:MI') starts_at,to_char(h.ends_at,'HH24:MI') ends_at
        from space_working_hours h join teacher_assignments ta on ta.cohort_course_id=h.cohort_course_id
        where ta.teacher_id=$1 and h.effective_from<$2 order by h.effective_from`, [teacherId, end]),
      query(`select l.cohort_course_id,l.class_date::text,l.submitted_at from teacher_class_links l
        where l.teacher_id=$1 and l.class_date >= $2 and l.class_date < $3`, [teacherId, first, end]),
      query(`select cohort_course_id,class_date::text,attendance_status from teacher_attendance_overrides
        where teacher_id=$1 and class_date >= $2 and class_date < $3`, [teacherId, first, end]),
    ]);
    const today = indiaDate();
    const now = new Date();
    const rows = [];
    for (const space of spaces.rows) {
      for (let day = new Date(`${first}T00:00:00Z`); day < nextMonth; day.setUTCDate(day.getUTCDate() + 1)) {
        if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
        const classDate = day.toISOString().slice(0, 10);
        if (classDate < space.assigned_from) continue;
        const window = hours.rows.filter(row => row.cohort_course_id === space.id && row.effective_from <= classDate).at(-1);
        if (!window) continue;
        const link = links.rows.find(row => row.cohort_course_id === space.id && row.class_date === classDate);
        const override = overrides.rows.find(row => row.cohort_course_id === space.id && row.class_date === classDate);
        const start = new Date(`${classDate}T${window.starts_at}:00+05:30`);
        const deadline = new Date(`${classDate}T23:30:00+05:30`);
        const automatic = link ? (new Date(link.submitted_at) <= start ? 'attended' : 'missed') : now > deadline ? 'missed' : 'pending';
        rows.push({ space_id: space.id, space_name: `${space.cohort_name} · ${space.course_title}`, class_date: classDate,
          starts_at: window.starts_at, ends_at: window.ends_at, submitted_at: link?.submitted_at || null,
          automatic_status: classDate > today ? 'upcoming' : automatic, status: override?.attendance_status || (classDate > today ? 'upcoming' : automatic), overridden: Boolean(override) });
      }
    }
    res.json(rows);
  } catch (error) { next(error); }
});
app.put('/api/admin/teacher-attendance/:teacherId/:spaceId/:classDate', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  try {
    const { teacherId, spaceId, classDate } = req.params;
    if (!validDay(classDate) || classDate > indiaDate()) return res.status(400).json({ error: 'Choose a past or current date.' });
    if (!['attended','missed'].includes(req.body.status)) return res.status(400).json({ error: 'Choose attended or missed.' });
    const weekday = new Date(`${classDate}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) return res.status(400).json({ error: 'Teacher attendance is scheduled Monday through Friday.' });
    const assigned = await query(`select 1 from teacher_assignments ta join space_working_hours h
      on h.cohort_course_id=ta.cohort_course_id and h.effective_from<=$3
      where ta.teacher_id=$1 and ta.cohort_course_id=$2 and (ta.created_at at time zone 'Asia/Kolkata')::date<=$3 limit 1`, [teacherId, spaceId, classDate]);
    if (!assigned.rowCount) return res.status(404).json({ error: 'Teacher assignment not found.' });
    await query(`insert into teacher_attendance_overrides(cohort_course_id,teacher_id,class_date,attendance_status,marked_by)
      values($1,$2,$3,$4,$5) on conflict(cohort_course_id,teacher_id,class_date) do update
      set attendance_status=excluded.attendance_status,marked_by=excluded.marked_by,marked_at=now()`, [spaceId, teacherId, classDate, req.body.status, req.user!.id]);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.post('/api/spaces/:spaceId/class-link', session, allow('teacher'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    const spaceId = String(req.params.spaceId);
    if (!await access(req, res, spaceId)) return;
    const today = indiaDate();
    if (new Date() > new Date(`${today}T23:30:00+05:30`)) return res.status(400).json({ error: 'Today’s link deadline has passed (11:30 pm IST).' });
    const meetingUrl = String(req.body.meetingUrl || '').trim();
    let parsed: URL;
    try { parsed = new URL(meetingUrl); } catch { return res.status(400).json({ error: 'Enter a valid HTTPS meeting link.' }); }
    if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'Enter a valid HTTPS meeting link.' });
    if ([0, 6].includes(new Date(`${today}T00:00:00Z`).getUTCDay())) return res.status(400).json({ error: 'Classes are scheduled Monday through Friday.' });
    await client.query('begin');
    const window = await client.query(`select starts_at,ends_at from space_working_hours where cohort_course_id=$1 and effective_from<=$2
      order by effective_from desc limit 1`, [spaceId, today]);
    if (!window.rowCount) { await client.query('rollback'); return res.status(400).json({ error: 'An admin must set this learning space’s working hours first.' }); }
    const existing = await client.query('select session_id from teacher_class_links where cohort_course_id=$1 and teacher_id=$2 and class_date=$3 for update', [spaceId, req.user!.id, today]);
    if (existing.rowCount) { await client.query('rollback'); return res.status(409).json({ error: 'You already submitted today’s class link.' }); }
    const start = `${today}T${String(window.rows[0].starts_at).slice(0, 8)}+05:30`;
    const end = `${today}T${String(window.rows[0].ends_at).slice(0, 8)}+05:30`;
    const space = await client.query(`select c.name cohort_name,co.title course_title from cohort_courses cc
      join cohorts c on c.id=cc.cohort_id join courses co on co.id=cc.course_id where cc.id=$1`, [spaceId]);
    const title = `${space.rows[0].course_title} class`;
    const sessionRow = await client.query(`insert into class_sessions(cohort_course_id,title,starts_at,ends_at,meeting_url,created_by)
      values($1,$2,$3,$4,$5,$6) returning id`, [spaceId, title, start, end, meetingUrl, req.user!.id]);
    await client.query(`insert into teacher_class_links(cohort_course_id,teacher_id,class_date,session_id)
      values($1,$2,$3,$4)`, [spaceId, req.user!.id, today, sessionRow.rows[0].id]);
    await client.query('commit');
    res.status(201).json({ session_id: sessionRow.rows[0].id });
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
});
app.get('/api/admin/student-attendance/:studentId', session, allow('admin'), async (req, res, next) => {
  try {
    const studentId = String(req.params.studentId);
    const student = await query('select 1 from profiles where id=$1 and role=$2', [studentId, 'student']);
    if (!student.rowCount) return res.status(404).json({ error: 'Student not found.' });
    const [classes, packages] = await Promise.all([
      query(`select s.id session_id,s.title,s.starts_at,s.ends_at,c.name cohort_name,co.title course_title,
        a.attendance_status,a.counts_toward_package from class_sessions s
        join cohort_courses cc on cc.id=s.cohort_course_id join cohorts c on c.id=cc.cohort_id
        join courses co on co.id=cc.course_id join cohort_members cm on cm.cohort_id=cc.cohort_id and cm.student_id=$1
        left join attendance a on a.session_id=s.id and a.student_id=$1 order by s.starts_at desc`, [studentId]),
      query(`select c.name cohort_name,co.title course_title,p.class_count,sp.sessions_attended,
        greatest(0,p.class_count-sp.sessions_attended) remaining from student_packages sp
        join package_plans p on p.id=sp.plan_id join cohort_courses cc on cc.id=sp.cohort_course_id
        join cohorts c on c.id=cc.cohort_id join courses co on co.id=cc.course_id
        where sp.student_id=$1 order by c.name,co.title`, [studentId]),
    ]);
    res.json({ classes: classes.rows, packages: packages.rows });
  } catch (error) { next(error); }
});

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
app.get('/api/admin/people/:personId', session, allow('admin'), async (req, res, next) => {
  try {
    const person = await query(`select p.id,p.display_name,p.role,u.email,u."createdAt" created_at
      from profiles p join "user" u on u.id=p.id where p.id=$1 and p.role in ('student','teacher')`, [req.params.personId]);
    if (!person.rowCount) return res.status(404).json({ error: 'Student or teacher not found.' });
    const role = person.rows[0].role;
    const spaces = role === 'student'
      ? await query(`select cc.id,c.name cohort_name,co.title course_title from cohort_members cm
          join cohorts c on c.id=cm.cohort_id join cohort_courses cc on cc.cohort_id=c.id
          join courses co on co.id=cc.course_id where cm.student_id=$1 order by c.name,co.title`, [req.params.personId])
      : await query(`select cc.id,c.name cohort_name,co.title course_title from teacher_assignments ta
          join cohort_courses cc on cc.id=ta.cohort_course_id join cohorts c on c.id=cc.cohort_id
          join courses co on co.id=cc.course_id where ta.teacher_id=$1 order by c.name,co.title`, [req.params.personId]);
    const impact = role === 'student'
      ? await query(`select (select count(*)::int from lesson_progress where student_id=$1) progress,
          (select count(*)::int from attendance where student_id=$1) attendance,
          (select count(*)::int from student_packages where student_id=$1) packages,
          (select count(*)::int from package_payments pp join student_packages sp on sp.id=pp.student_package_id where sp.student_id=$1) payments`, [req.params.personId])
      : await query(`select (select count(*)::int from lessons where created_by=$1) authored_lessons,
          (select count(*)::int from class_sessions where created_by=$1) authored_sessions`, [req.params.personId]);
    res.json({ ...person.rows[0], spaces: spaces.rows.map(row => ({ id: row.id, cohortName: row.cohort_name, courseTitle: row.course_title })), impact: impact.rows[0] });
  } catch (error) { next(error); }
});
app.delete('/api/admin/people/:personId', session, allow('admin'), async (req: RequestWithUser, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const person = await client.query<{ role: Role }>(`select role from profiles where id=$1 for update`, [req.params.personId]);
    if (!person.rowCount) { await client.query('rollback'); return res.status(404).json({ error: 'Account not found.' }); }
    if (person.rows[0].role === 'admin' || req.params.personId === req.user!.id) {
      await client.query('rollback'); return res.status(403).json({ error: 'Admin accounts cannot be deleted here.' });
    }
    if (person.rows[0].role === 'student') {
      await client.query(`insert into deleted_file_cleanup(object_key)
        select distinct pp.receipt_key from package_payments pp join student_packages sp on sp.id=pp.student_package_id
        where sp.student_id=$1 and pp.receipt_key is not null on conflict (object_key) do nothing`, [req.params.personId]);
    }
    await client.query('delete from "user" where id=$1', [req.params.personId]);
    await client.query('commit');
    void runDeletedFileCleanup();
    res.sendStatus(204);
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
});
app.get('/api/admin/spaces/:spaceId', session, allow('admin'), async (req, res, next) => {
  try {
    const space = await query(`select cc.id,c.name cohort_name,co.title course_title,
      (select count(*)::int from cohort_members cm where cm.cohort_id=cc.cohort_id) students,
      (select count(*)::int from teacher_assignments ta where ta.cohort_course_id=cc.id) teachers,
      (select count(*)::int from lessons l where l.cohort_course_id=cc.id) lessons,
      (select count(*)::int from class_sessions cs where cs.cohort_course_id=cc.id) sessions,
      (select count(*)::int from student_packages sp where sp.cohort_course_id=cc.id) packages,
      (select count(*)::int from package_payments pp join student_packages sp on sp.id=pp.student_package_id where sp.cohort_course_id=cc.id) payments
      from cohort_courses cc join cohorts c on c.id=cc.cohort_id join courses co on co.id=cc.course_id where cc.id=$1`, [req.params.spaceId]);
    if (!space.rowCount) return res.status(404).json({ error: 'Learning space not found.' });
    const [students, teachers] = await Promise.all([
      query(`select p.id,p.display_name from cohort_members cm join profiles p on p.id=cm.student_id
        where cm.cohort_id=(select cohort_id from cohort_courses where id=$1) order by p.display_name`, [req.params.spaceId]),
      query(`select p.id,p.display_name from teacher_assignments ta join profiles p on p.id=ta.teacher_id
        where ta.cohort_course_id=$1 order by p.display_name`, [req.params.spaceId]),
    ]);
    res.json({ ...space.rows[0], cohortName: space.rows[0].cohort_name, courseTitle: space.rows[0].course_title, studentsList: students.rows, teachersList: teachers.rows });
  } catch (error) { next(error); }
});
app.delete('/api/admin/spaces/:spaceId', session, allow('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const space = await client.query('select id from cohort_courses where id=$1 for update', [req.params.spaceId]);
    if (!space.rowCount) { await client.query('rollback'); return res.status(404).json({ error: 'Learning space not found.' }); }
    await client.query(`insert into deleted_file_cleanup(object_key,multipart_upload_id)
      select distinct coalesce(l.storage_key,fu.object_key),fu.multipart_upload_id from lessons l
      left join file_uploads fu on fu.lesson_id=l.id where l.cohort_course_id=$1 and coalesce(l.storage_key,fu.object_key) is not null
      on conflict (object_key) do nothing`, [req.params.spaceId]);
    await client.query(`insert into deleted_file_cleanup(object_key)
      select distinct pp.receipt_key from package_payments pp join student_packages sp on sp.id=pp.student_package_id
      where sp.cohort_course_id=$1 and pp.receipt_key is not null on conflict (object_key) do nothing`, [req.params.spaceId]);
    await client.query('delete from cohort_courses where id=$1', [req.params.spaceId]);
    await client.query('commit');
    void runDeletedFileCleanup();
    res.sendStatus(204);
  } catch (error) { await client.query('rollback').catch(() => undefined); next(error); }
  finally { client.release(); }
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
let deletedFileCleanupRunning = false;
const runDeletedFileCleanup = async () => {
  if (deletedFileCleanupRunning) return;
  deletedFileCleanupRunning = true;
  try {
    const pending = await query<{ object_key: string; multipart_upload_id: string | null }>(
      'select object_key,multipart_upload_id from deleted_file_cleanup order by created_at limit 50');
    for (const file of pending.rows) {
      try {
        if (file.multipart_upload_id) await cancelMultipart(file.object_key, file.multipart_upload_id).catch(error => console.warn('Multipart cancellation failed; checking object deletion.', file.object_key, error));
        await deleteObject(file.object_key);
        await query('delete from deleted_file_cleanup where object_key=$1', [file.object_key]);
      } catch (error) { console.error('Deleted file cleanup will retry.', file.object_key, error); }
    }
  } catch (error) { console.error('Deleted file cleanup query failed; it will be retried.', error); }
  finally { deletedFileCleanupRunning = false; }
};
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
const retentionTimer = setInterval(() => { void runRetentionCleanup(); void runDeletedFileCleanup(); }, 60 * 60 * 1000);
retentionTimer.unref();
void runRetentionCleanup();
void runDeletedFileCleanup();
const shutdown = () => {
  clearInterval(retentionTimer);
  chatStopping = true;
  chatEvents.emit('shutdown');
  if (chatListener) { const client = chatListener; chatListener = null; client.release(true); }
  server.close(() => void pool.end());
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
