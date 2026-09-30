import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { configured, supabase } from './supabase';
import { assignTeacher, createCohort, createCourse, createMaterial, enrollStudent, getAdminDirectory, getCompletions, getLessons, getProfile, getSpaces, getStudents, markComplete, offerCourse, openMaterial } from './data';
import type { AdminDirectory, Completion, CourseSpace, Lesson, Profile } from './types';

type Page = 'home' | 'setup' | 'classroom' | 'progress' | 'students' | 'upload';
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const initials = (name: string) => name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
const date = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));

export default function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [spaces, setSpaces] = useState<CourseSpace[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [directory, setDirectory] = useState<AdminDirectory>({ profiles: [], cohorts: [], courses: [] });
  const [page, setPage] = useState<Page>('home');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const signedIn = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError('');
    try {
      const { data, error: authError } = await supabase.auth.getUser();
      if (authError || !data.user) { setUserId(null); setProfile(null); return; }
      const p = await getProfile(data.user.id);
      setUserId(data.user.id);
      setProfile(p);
      const found = await getSpaces(p.role, data.user.id);
      setSpaces(found);
      setSpaceId(current => found.some(space => space.id === current) ? current : found[0]?.id ?? '');
      setDirectory(p.role === 'admin' ? await getAdminDirectory() : { profiles: [], cohorts: [], courses: [] });
    } catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    void signedIn();
    const { data } = supabase.auth.onAuthStateChange(() => { void signedIn(); });
    return () => data.subscription.unsubscribe();
  }, [signedIn]);

  const staff = profile?.role === 'teacher' || profile?.role === 'admin';
  const admin = profile?.role === 'admin';
  const activeSpace = spaces.find(space => space.id === spaceId);
  const refresh = useCallback(async () => {
    if (!profile || !spaceId) { setLessons([]); setCompletions([]); setStudents([]); return; }
    setLoading(true);
    setError('');
    try {
      const items = await getLessons(spaceId, profile.role);
      setLessons(items);
      const [done, roster] = await Promise.all([
        getCompletions(items.map(item => item.id)),
        profile.role === 'student' ? Promise.resolve([]) : getStudents(spaceId)
      ]);
      setCompletions(done);
      setStudents(roster);
    } catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  }, [profile, spaceId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const published = useMemo(() => lessons.filter(item => item.status === 'published'), [lessons]);
  const myCompleted = useMemo(() => new Set(completions.filter(c => c.student_id === userId).map(c => c.lesson_id)), [completions, userId]);
  const percent = published.length ? Math.round(myCompleted.size / published.length * 100) : 0;

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    const { error: loginError } = await supabase.auth.signInWithPassword({ email: String(form.get('email')), password: String(form.get('password')) });
    if (loginError) setError(loginError.message);
    setBusy(false);
  }

  async function finish(lesson: Lesson) {
    if (!userId) return;
    setBusy(true); setError('');
    try { await markComplete(userId, lesson.id); setNotice('Lesson marked complete.'); await refresh(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function view(lesson: Lesson) {
    setError('');
    try { await openMaterial(lesson); }
    catch (failure) { setError(message(failure)); }
  }

  async function refreshAdminDirectory() {
    const [found, people] = await Promise.all([getSpaces('admin', userId!), getAdminDirectory()]);
    setSpaces(found);
    setDirectory(people);
    setSpaceId(current => found.some(space => space.id === current) ? current : found[0]?.id ?? '');
    setNotice('Centre setup updated.');
  }

  if (!configured) return <main className="gate"><div className="gate-card"><div className="brand"><span className="brand-mark">N</span>NORTHSTAR</div><h1>Connect your LMS</h1><p>Add the Supabase project URL and publishable key to <code>app/.env.local</code>, then restart the app. Setup is explained in the project README.</p></div></main>;
  if (!profile) return <main className="gate"><form className="gate-card" onSubmit={signIn}><div className="brand"><span className="brand-mark">N</span>NORTHSTAR</div><p className="eyebrow">WELCOME BACK</p><h1>Sign in to learn.</h1><label>Email<input type="email" name="email" autoComplete="username" required /></label><label>Password<input type="password" name="password" autoComplete="current-password" required /></label>{error && <p role="alert" className="alert">{error}</p>}<button className="primary" disabled={busy || loading}>{busy ? 'Signing in…' : 'Sign in →'}</button><p className="helper">Accounts are created by the tuition centre. Ask your admin for access.</p></form></main>;

  const nav: Array<{ page: Page; label: string; icon: string }> = admin
    ? [{ page: 'home', label: 'Centre overview', icon: '⌂' }, { page: 'setup', label: 'Manage centre', icon: '⚙' }, { page: 'classroom', label: 'Materials', icon: '▣' }, { page: 'students', label: 'Students', icon: '♧' }, { page: 'upload', label: 'Upload material', icon: '+' }]
    : staff
    ? [{ page: 'home', label: 'Overview', icon: '⌂' }, { page: 'classroom', label: 'Materials', icon: '▣' }, { page: 'students', label: 'Students', icon: '♧' }, { page: 'upload', label: 'Upload material', icon: '+' }]
    : [{ page: 'home', label: 'Home', icon: '⌂' }, { page: 'classroom', label: 'Classroom', icon: '▣' }, { page: 'progress', label: 'Progress', icon: '◔' }];

  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">N</span>NORTHSTAR</div><div className="cohort">{admin ? 'ADMIN CONSOLE' : staff ? 'TEACHER WORKSPACE' : 'STUDENT PORTAL'}</div><nav className="nav">{nav.map(item => <button key={item.page} className={`nav-item ${page === item.page ? 'active' : ''}`} onClick={() => setPage(item.page)}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><div className="side-person">{profile.display_name}<small>{profile.role}</small></div><button className="nav-item" onClick={() => void supabase?.auth.signOut()}><span>↪</span>Log out</button></div></aside>
    <main className="main"><header className="topbar"><select aria-label="Course and cohort" value={spaceId} onChange={e => setSpaceId(e.target.value)}>{spaces.length ? spaces.map(space => <option key={space.id} value={space.id}>{space.cohortName} · {space.courseTitle}</option>) : <option value="">No courses assigned</option>}</select><span className="role-pill">{profile.role}</span><div className="avatar">{initials(profile.display_name)}</div><strong>{profile.display_name}</strong></header>
      <div className="content">{error && <div role="alert" className="alert">{error}</div>}{notice && <div role="status" className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {admin && page === 'home' && <><p className="eyebrow">ADMIN CONSOLE <span></span> CENTRE OPERATIONS</p><AdminOverview directory={directory} spaces={spaces} onManage={() => setPage('setup')} /></>}
        {admin && page === 'setup' && <><p className="eyebrow">ADMIN CONSOLE <span></span> CENTRE SETUP</p><AdminSetup directory={directory} spaces={spaces} onSaved={refreshAdminDirectory} /></>}
        {(!admin || (page !== 'home' && page !== 'setup')) && (!activeSpace ? <Empty title="No course yet" text={profile.role === 'teacher' ? 'An admin needs to assign you to a cohort and course.' : 'Your tuition centre has not enrolled you in a course yet.'} /> : <>
        <p className="eyebrow">{admin ? 'ADMIN CONSOLE' : staff ? 'TEACHER WORKSPACE' : 'STUDENT DASHBOARD'} <span></span> {activeSpace.cohortName.toUpperCase()} · {activeSpace.courseTitle.toUpperCase()}</p>
        {staff ? <>
          {(page === 'home' || page === 'students') && <StaffOverview students={students} lessons={published} completions={completions} onUpload={() => setPage('upload')} admin={admin} />}
          {page === 'classroom' && <LessonList lessons={lessons} completed={new Set()} staff onOpen={view} onComplete={finish} busy={busy} />}
          {page === 'upload' && <UploadForm space={activeSpace} userId={userId!} onDone={async () => { setNotice('Material uploaded and published.'); await refresh(); setPage('classroom'); }} />}
        </> : <>
          {page === 'home' && <StudentHome lessons={published} completed={myCompleted} percent={percent} onOpen={view} onComplete={finish} onClassroom={() => setPage('classroom')} busy={busy} />}
          {page === 'classroom' && <LessonList lessons={published} completed={myCompleted} onOpen={view} onComplete={finish} busy={busy} />}
          {page === 'progress' && <Progress lessons={published} completed={myCompleted} onOpen={view} onComplete={finish} busy={busy} />}
        </>}
      </>) }{loading && <p className="loading">Loading latest course data…</p>}</div>
    </main>
  </div>;
}

function AdminOverview({ directory, spaces, onManage }: { directory: AdminDirectory; spaces: CourseSpace[]; onManage: () => void }) {
  const students = directory.profiles.filter(person => person.role === 'student').length;
  const teachers = directory.profiles.filter(person => person.role === 'teacher').length;
  return <>
    <div className="page-title title-action"><div><h1>CENTRE<br /><em>OVERVIEW.</em></h1><p>Manage learning spaces, people, and teaching assignments across the centre.</p></div><button className="primary" onClick={onManage}>Manage centre →</button></div>
    <div className="metrics"><article><span>STUDENTS</span><b>{students}</b><p>Accounts in the centre</p></article><article><span>TEACHERS</span><b>{teachers}</b><p>Teaching staff</p></article><article><span>LEARNING SPACES</span><b>{spaces.length}</b><p>Cohort and course pairings</p></article></div>
    <section className="panel roster"><div className="section-head"><h2>Learning spaces</h2><span>{directory.cohorts.length} cohorts · {directory.courses.length} courses</span></div>{spaces.length ? spaces.map(space => <div className="student-row" key={space.id}><div className="student-avatar">{initials(space.cohortName)}</div><div className="student-name"><strong>{space.cohortName}</strong><small>{space.courseTitle}</small></div><span className="type-tag">ACTIVE SPACE</span></div>) : <p className="muted-text">No cohort and course pairings yet. Add them in Manage centre.</p>}</section>
  </>;
}

function AdminSetup({ directory, spaces, onSaved }: { directory: AdminDirectory; spaces: CourseSpace[]; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setError('');
    try { await action(new FormData(form)); form.reset(); await onSaved(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  const teachers = directory.profiles.filter(person => person.role === 'teacher');
  const students = directory.profiles.filter(person => person.role === 'student');
  return <>
    <div className="page-title"><h1>MANAGE<br /><em>THE CENTRE.</em></h1><p>Set up cohorts and courses, then connect existing accounts to the right learning spaces.</p></div>
    {error && <div role="alert" className="alert">{error}</div>}
    <div className="admin-setup-grid">
      <form className="panel admin-form" onSubmit={event => void submit(event, data => createCohort(String(data.get('name'))))}><h2>Create a cohort</h2><p>Add a teaching group or intake.</p><label>Cohort name<input name="name" required minLength={2} maxLength={100} placeholder="e.g. Year 10 · Autumn" /></label><button className="primary" disabled={busy}>Create cohort</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => createCourse(String(data.get('title'))))}><h2>Create a course</h2><p>Add a subject to offer to cohorts.</p><label>Course name<input name="title" required minLength={2} maxLength={100} placeholder="e.g. Mathematics" /></label><button className="primary" disabled={busy}>Create course</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => offerCourse(String(data.get('cohort_id')), String(data.get('course_id'))))}><h2>Open a learning space</h2><p>Pair a cohort with a course.</p><label>Cohort<select name="cohort_id" required defaultValue=""><option value="" disabled>Select a cohort</option>{directory.cohorts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Course<select name="course_id" required defaultValue=""><option value="" disabled>Select a course</option>{directory.courses.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button className="primary" disabled={busy || !directory.cohorts.length || !directory.courses.length}>Create learning space</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => assignTeacher(String(data.get('space_id')), String(data.get('teacher_id'))))}><h2>Assign a teacher</h2><p>Give a teacher access to an existing learning space.</p><label>Learning space<select name="space_id" required defaultValue=""><option value="" disabled>Select a space</option>{spaces.map(item => <option key={item.id} value={item.id}>{item.cohortName} · {item.courseTitle}</option>)}</select></label><label>Teacher<select name="teacher_id" required defaultValue=""><option value="" disabled>Select a teacher</option>{teachers.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label><button className="primary" disabled={busy || !spaces.length || !teachers.length}>Assign teacher</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => enrollStudent(String(data.get('cohort_id')), String(data.get('student_id'))))}><h2>Enroll a student</h2><p>Give a student access to all courses offered to their cohort.</p><label>Cohort<select name="cohort_id" required defaultValue=""><option value="" disabled>Select a cohort</option>{directory.cohorts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Student<select name="student_id" required defaultValue=""><option value="" disabled>Select a student</option>{students.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label><button className="primary" disabled={busy || !students.length || !directory.cohorts.length}>Enroll student</button></form>
    </div>
    <p className="helper">This manages existing accounts and their access. Create or invite Auth accounts from Supabase before assigning them here.</p>
  </>;
}

function Empty({ title, text }: { title: string; text: string }) { return <section className="empty"><span>✦</span><h2>{title}</h2><p>{text}</p></section>; }

function StudentHome({ lessons, completed, percent, onOpen, onComplete, onClassroom, busy }: { lessons: Lesson[]; completed: Set<string>; percent: number; onOpen: (lesson: Lesson) => void; onComplete: (lesson: Lesson) => void; onClassroom: () => void; busy: boolean }) {
  const next = lessons.find(lesson => !completed.has(lesson.id));
  return <><div className="hero"><div><h1>PICK UP<br />WHERE YOU<br />LEFT OFF.</h1><p>Every lesson finished moves you forward.</p></div><article className="feature">{next ? <><span className="tag">NEXT UP · {next.kind.toUpperCase()}</span><h2>{next.title}</h2><p>{next.description || 'Open the material when you are ready.'}</p><button className="watch" onClick={() => onOpen(next)}>Open material →</button></> : <><span className="tag">ALL CAUGHT UP</span><h2>You're on track.</h2><p>New materials will appear here when your teacher publishes them.</p></>}</article></div><div className="overview-grid"><section className="panel"><div className="section-label">YOUR PROGRESS</div><div className="progress-number">{completed.size}<small> / {lessons.length} lessons</small></div><div className="meter"><i style={{ width: `${percent}%` }} /></div><p>{percent}% of published materials completed</p></section><section className="panel"><div className="section-label">UP NEXT</div>{next ? <><h3>{next.title}</h3><p>Once you've finished the recording or reading, mark it complete.</p><button className="outline" onClick={() => onComplete(next)} disabled={busy}>Mark complete</button></> : <p>No unfinished materials right now.</p>}</section></div><div className="section-head"><h2>Classroom materials</h2><button className="link" onClick={onClassroom}>View all →</button></div><LessonList lessons={lessons.slice(0, 3)} completed={completed} onOpen={onOpen} onComplete={onComplete} busy={busy} /></>;
}

function LessonList({ lessons, completed, staff = false, onOpen, onComplete, busy }: { lessons: Lesson[]; completed: Set<string>; staff?: boolean; onOpen: (lesson: Lesson) => void; onComplete: (lesson: Lesson) => void; busy: boolean }) {
  if (!lessons.length) return <Empty title="No materials yet" text="Your teacher's recordings and reading material will appear here." />;
  return <div className="lesson-list">{lessons.map((lesson, index) => <article className="lesson-row" key={lesson.id}><div className="row-index">{String(index + 1).padStart(2, '0')}</div><div className="row-main"><div><span className="type-tag">{lesson.kind === 'recording' ? '▶ RECORDING' : '▤ READING'}</span>{staff && <span className={`status-tag ${lesson.status}`}>{lesson.status}</span>}</div><h3>{lesson.title}</h3><p>{lesson.description || lesson.original_name || 'Course material'}</p></div><div className="row-actions">{lesson.storage_path && <button className="outline" onClick={() => onOpen(lesson)}>Open</button>}{!staff && (completed.has(lesson.id) ? <span className="completed">✓ Completed</span> : <button className="small-btn" disabled={busy} onClick={() => onComplete(lesson)}>Mark complete</button>)}</div></article>)}</div>;
}

function Progress({ lessons, completed, onOpen, onComplete, busy }: { lessons: Lesson[]; completed: Set<string>; onOpen: (lesson: Lesson) => void; onComplete: (lesson: Lesson) => void; busy: boolean }) {
  const percent = lessons.length ? Math.round(completed.size / lessons.length * 100) : 0;
  return <><div className="page-title"><h1>YOUR PROGRESS.</h1><p>Completion is recorded when you choose “Mark complete.”</p></div><section className="panel progress-large"><span className="eyebrow">PUBLISHED MATERIALS</span><div className="progress-number">{completed.size}<small> / {lessons.length} complete</small></div><div className="meter"><i style={{ width: `${percent}%` }} /></div><p>{percent}% complete</p></section><LessonList lessons={lessons} completed={completed} onOpen={onOpen} onComplete={onComplete} busy={busy} /></>;
}

function StaffOverview({ students, lessons, completions, onUpload, admin = false }: { students: Profile[]; lessons: Lesson[]; completions: Completion[]; onUpload: () => void; admin?: boolean }) {
  const finished = completions.filter(c => lessons.some(l => l.id === c.lesson_id));
  const average = students.length && lessons.length ? Math.round(finished.length / (students.length * lessons.length) * 100) : 0;
  return <><div className="page-title title-action"><div><h1>{admin ? <>CENTRE<br /><em>PROGRESS.</em></> : <>STUDENT<br /><em>INVOLVEMENT.</em></>}</h1><p>{admin ? 'Review progress for the selected cohort and course.' : 'See who has finished the materials you published.'}</p></div><button className="primary" onClick={onUpload}>+ Upload material</button></div><div className="metrics"><article><span>STUDENTS</span><b>{students.length}</b><p>In this cohort</p></article><article><span>PUBLISHED MATERIALS</span><b>{lessons.length}</b><p>Recordings and readings</p></article><article><span>AVG. COMPLETION</span><b>{average}<small>%</small></b><div className="meter"><i style={{ width: `${average}%` }} /></div></article></div><section className="panel roster"><div className="section-head"><h2>Progress by student</h2><span>{students.length} students</span></div>{students.length ? students.map(student => { const own = finished.filter(c => c.student_id === student.id); const count = own.length; const studentPercent = lessons.length ? Math.round(count / lessons.length * 100) : 0; const latest = own.length ? own.map(c => c.completed_at).sort().at(-1)! : null; return <div className="student-row" key={student.id}><div className="student-avatar">{initials(student.display_name)}</div><div className="student-name"><strong>{student.display_name}</strong><small>{latest ? `Last completed ${date(latest)}` : 'No lessons completed yet'}</small></div><div className="student-meter"><div className="meter"><i style={{ width: `${studentPercent}%` }} /></div><span>{count} / {lessons.length}</span></div><b>{studentPercent}%</b></div>; }) : <p className="muted-text">No students enrolled in this cohort yet.</p>}</section></>;
}

function UploadForm({ space, userId, onDone }: { space: CourseSpace; userId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const file = data.get('file');
    if (!(file instanceof File) || !file.size) { setError('Choose a file to upload.'); return; }
    const kind = String(data.get('kind')) as 'recording' | 'reading';
    if (kind === 'recording' && !file.type.startsWith('video/')) { setError('Choose a video file for a recording.'); return; }
    if (kind === 'reading' && !['application/pdf', 'text/plain'].includes(file.type)) { setError('Choose a PDF or text file for reading material.'); return; }
    setBusy(true); setError(''); setProgress(0);
    try { await createMaterial({ spaceId: space.id, teacherId: userId, title: String(data.get('title')), description: String(data.get('description')), kind, file, onProgress: setProgress }); formElement.reset(); await onDone(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <><div className="page-title"><h1>ADD NEW<br /><em>MATERIAL.</em></h1><p>Upload a recorded class or reading file for {space.cohortName} · {space.courseTitle}.</p></div><form className="upload-form panel" onSubmit={submit}><label>Material title<input name="title" required minLength={2} maxLength={160} placeholder="e.g. Quadratic equations — Part 1" /></label><label>Type<select name="kind"><option value="recording">Recorded class (video)</option><option value="reading">Reading material (PDF or text)</option></select></label><label>Description<textarea name="description" rows={3} placeholder="What will students learn?" /></label><label>File<input name="file" type="file" required accept="video/*,.pdf,.txt" /></label><p className="helper">Materials stay private to this cohort. The lesson is published only after the upload finishes. Large videos upload in resumable chunks.</p>{busy && <div><div className="meter"><i style={{ width: `${progress}%` }} /></div><p>{progress}% uploaded</p></div>}{error && <p role="alert" className="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Uploading…' : 'Upload and publish →'}</button></form></>;
}
