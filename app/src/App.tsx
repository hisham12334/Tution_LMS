import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { arrivingFromEmail, passwordResetToken, resetPasswordRequest, setPassword, signIn as apiSignIn, signOut } from './backend';
import './features.css';
import { assignStudentPackage, assignTeacher, confirmPackagePayment, createClassSession, createCohort, createCourse, createMaterial, createPackagePlan, deleteMaterial as deleteMaterialRequest, deletePaymentReceipt, enrollStudent, getAdminDirectory, getClassSessions, getCompletions, getLessons, getPackagePayments, getPackagePlans, getPaymentReceiptUrl, getProfile, getSessionAttendance, getSpaces, getStudentPackages, getStudents, inviteAccount, markComplete, offerCourse, openMaterial, saveSessionAttendance, uploadPaymentReceipt } from './data';
import type { AdminDirectory, Attendance, ClassSession, Completion, CourseSpace, Lesson, PackagePayment, PackagePlan, Profile, StudentPackage } from './types';

type Page = 'home' | 'setup' | 'classroom' | 'progress' | 'students' | 'upload' | 'schedule' | 'packages';
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
  const [emailInput, setEmailInput] = useState('');
  const [setupPassword, setSetupPassword] = useState(arrivingFromEmail);

  const signedIn = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const p = await getProfile();
      setUserId(p.id);
      setProfile(p);
      const found = await getSpaces(p.role, p.id);
      setSpaces(found);
      setSpaceId(current => found.some(space => space.id === current) ? current : found[0]?.id ?? '');
      setDirectory(p.role === 'admin' ? await getAdminDirectory() : { profiles: [], cohorts: [], courses: [] });
    } catch (failure) {
      setUserId(null); setProfile(null); setSpaces([]);
      if (!(failure instanceof Error && failure.message === 'Sign in to continue.')) setError(message(failure));
    }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void signedIn();
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
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try { await apiSignIn(String(form.get('email')), String(form.get('password'))); await signedIn(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
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

  async function removeMaterial(lesson: Lesson) {
    if (!window.confirm(`Permanently delete “${lesson.title}”, its uploaded file, and its completion history?`)) return;
    setBusy(true); setError('');
    try { await deleteMaterialRequest(lesson.id); await refresh(); setNotice('Material and its file were permanently deleted.'); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function requestPasswordReset() {
    if (!emailInput.trim()) { setError('Enter your email address first.'); return; }
    setBusy(true); setError(''); setNotice('');
    try { await resetPasswordRequest(emailInput.trim()); setNotice('If this account exists, a password reset link is on its way.'); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== form.get('confirm')) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      if (!passwordResetToken) throw new Error('This password setup link is missing or expired. Request a new reset link.');
      await setPassword(passwordResetToken, password);
      window.history.replaceState({}, '', window.location.pathname);
      setSetupPassword(false);
      setNotice('Your password is ready. Welcome to Astute Academy.');
      await signedIn();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function refreshAdminDirectory(messageText = 'Centre setup updated.') {
    const [found, people] = await Promise.all([getSpaces('admin', userId!), getAdminDirectory()]);
    setSpaces(found);
    setDirectory(people);
    setSpaceId(current => found.some(space => space.id === current) ? current : found[0]?.id ?? '');
    setNotice(messageText);
  }

  if (setupPassword) return <main className="gate"><form className="gate-card" onSubmit={savePassword}><div className="brand"><span className="brand-mark">A</span>ASTUTE ACADEMY</div><p className="eyebrow">ACCOUNT SETUP</p><h1>Set your password.</h1><p>Choose a password to use when signing in.</p><label>New password<input type="password" name="password" autoComplete="new-password" minLength={10} required /></label><label>Confirm password<input type="password" name="confirm" autoComplete="new-password" minLength={10} required /></label>{error && <p role="alert" className="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save password →'}</button></form></main>;
  if (!profile) return <main className="gate"><form className="gate-card" onSubmit={signIn}><div className="brand"><span className="brand-mark">A</span>ASTUTE ACADEMY</div><p className="eyebrow">WELCOME BACK</p><h1>Sign in to learn.</h1><label>Email<input type="email" name="email" autoComplete="username" value={emailInput} onChange={event => setEmailInput(event.target.value)} required /></label><label>Password<input type="password" name="password" autoComplete="current-password" required /></label>{error && <p role="alert" className="alert">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}<button className="primary" disabled={busy || loading}>{busy ? 'Signing in…' : 'Sign in →'}</button><button type="button" className="link password-help" onClick={() => void requestPasswordReset()} disabled={busy}>Forgot password?</button><p className="helper">Accounts are created by the tuition centre. Ask your admin for access.</p></form></main>;

  const nav: Array<{ page: Page; label: string; mobileLabel: string; icon: string }> = admin
    ? [{ page: 'home', label: 'Centre overview', mobileLabel: 'Home', icon: '⌂' }, { page: 'setup', label: 'Manage centre', mobileLabel: 'Manage', icon: '⚙' }, { page: 'packages', label: 'Class packages', mobileLabel: 'Packages', icon: '₹' }, { page: 'classroom', label: 'Materials', mobileLabel: 'Materials', icon: '▣' }, { page: 'students', label: 'Students', mobileLabel: 'Students', icon: '♧' }, { page: 'upload', label: 'Upload material', mobileLabel: 'Upload', icon: '+' }]
    : staff
    ? [{ page: 'home', label: 'Overview', mobileLabel: 'Home', icon: '⌂' }, { page: 'schedule', label: 'Class schedule', mobileLabel: 'Schedule', icon: '◷' }, { page: 'classroom', label: 'Materials', mobileLabel: 'Materials', icon: '▣' }, { page: 'students', label: 'Students', mobileLabel: 'Students', icon: '♧' }, { page: 'upload', label: 'Upload material', mobileLabel: 'Upload', icon: '+' }]
    : [{ page: 'home', label: 'Home', mobileLabel: 'Home', icon: '⌂' }, { page: 'schedule', label: 'Schedule', mobileLabel: 'Schedule', icon: '◷' }, { page: 'classroom', label: 'Classroom', mobileLabel: 'Classroom', icon: '▣' }, { page: 'progress', label: 'Progress', mobileLabel: 'Progress', icon: '◔' }, { page: 'packages', label: 'Class package', mobileLabel: 'Package', icon: '₹' }];

  function navigate(next: Page) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">A</span>ASTUTE ACADEMY</div><div className="cohort">{admin ? 'ADMIN CONSOLE' : staff ? 'TEACHER WORKSPACE' : 'STUDENT PORTAL'}</div><nav className="nav">{nav.map(item => <button key={item.page} className={`nav-item ${page === item.page ? 'active' : ''}`} onClick={() => navigate(item.page)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><div className="side-person">{profile.display_name}<small>{profile.role}</small></div><button className="nav-item" onClick={() => void signOut().then(() => { setProfile(null); setUserId(null); })}><span aria-hidden="true">↪</span>Log out</button></div></aside>
    <main className="main"><header className="topbar"><div className="mobile-brand brand"><span className="brand-mark">A</span>ASTUTE ACADEMY <small>{profile.role}</small></div><label className="mobile-course-label" htmlFor="active-course">Course and cohort</label><div className="course-switcher"><select id="active-course" aria-label="Course and cohort" value={spaceId} onChange={e => setSpaceId(e.target.value)}>{spaces.length ? spaces.map(space => <option key={space.id} value={space.id}>{space.cohortName} · {space.courseTitle}</option>) : <option value="">No courses assigned</option>}</select></div><span className="role-pill">{profile.role}</span><div className="avatar">{initials(profile.display_name)}</div><strong>{profile.display_name}</strong><button className="mobile-logout" onClick={() => void signOut().then(() => { setProfile(null); setUserId(null); })}>Log out</button></header>
      <div className="content">{error && <div role="alert" className="alert">{error}</div>}{notice && <div role="status" className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {admin && page === 'home' && <><p className="eyebrow">ADMIN CONSOLE <span></span> CENTRE OPERATIONS</p><AdminOverview directory={directory} spaces={spaces} onManage={() => setPage('setup')} /></>}
        {admin && page === 'setup' && <><p className="eyebrow">ADMIN CONSOLE <span></span> CENTRE SETUP</p><AdminSetup directory={directory} spaces={spaces} onSaved={refreshAdminDirectory} /></>}
        {(!admin || (page !== 'home' && page !== 'setup')) && (!activeSpace ? <Empty title="No course yet" text={profile.role === 'teacher' ? 'An admin needs to assign you to a cohort and course.' : 'Your tuition centre has not enrolled you in a course yet.'} /> : <>
        <p className="eyebrow">{admin ? 'ADMIN CONSOLE' : staff ? 'TEACHER WORKSPACE' : 'STUDENT DASHBOARD'} <span></span> {activeSpace.cohortName.toUpperCase()} · {activeSpace.courseTitle.toUpperCase()}</p>
        {staff ? <>
          {(page === 'home' || page === 'students') && <StaffOverview students={students} lessons={published} completions={completions} onUpload={() => setPage('upload')} admin={admin} />}
          {page === 'schedule' && <SchedulePage space={activeSpace} profile={profile} userId={userId!} onNotice={setNotice} />}
          {admin && page === 'packages' && <PackagesPage space={activeSpace} adminId={userId!} students={students} isAdmin onNotice={setNotice} />}
          {page === 'classroom' && <LessonList lessons={lessons} completed={new Set()} staff onOpen={view} onComplete={finish} onDelete={removeMaterial} busy={busy} />}
          {page === 'upload' && <UploadForm space={activeSpace} userId={userId!} onDone={async () => { setNotice('Material uploaded and published.'); await refresh(); setPage('classroom'); }} />}
        </> : <>
          {page === 'home' && <StudentHome lessons={published} completed={myCompleted} percent={percent} onOpen={view} onComplete={finish} onClassroom={() => setPage('classroom')} busy={busy} />}
          {page === 'classroom' && <LessonList lessons={published} completed={myCompleted} onOpen={view} onComplete={finish} busy={busy} />}
          {page === 'progress' && <Progress lessons={published} completed={myCompleted} onOpen={view} onComplete={finish} busy={busy} />}
          {page === 'schedule' && <SchedulePage space={activeSpace} profile={profile} userId={userId!} onNotice={setNotice} />}
          {page === 'packages' && <PackagesPage space={activeSpace} adminId={userId!} students={[]} isAdmin={false} onNotice={setNotice} />}
        </>}
      </>) }{loading && <p className="loading">Loading latest course data…</p>}</div>
    </main>
    <nav className="mobile-nav" aria-label="Mobile navigation">{nav.map(item => <button key={item.page} className={`mobile-nav-item ${page === item.page ? 'active' : ''}`} aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}><span aria-hidden="true">{item.icon}</span><small>{item.mobileLabel}</small></button>)}</nav>
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

function AdminSetup({ directory, spaces, onSaved }: { directory: AdminDirectory; spaces: CourseSpace[]; onSaved: (message?: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupUrl, setSetupUrl] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setError('');
    try { await action(new FormData(form)); form.reset(); await onSaved(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setError('');
    try {
      setSetupUrl('');
      const result = await inviteAccount({
        displayName: String(values.get('display_name')),
        email: String(values.get('email')),
        role: String(values.get('role')) as 'student' | 'teacher'
      });
      setSetupUrl(result.setupUrl || '');
      form.reset();
      try { await onSaved(result.message); }
      catch { setError(`${result.message} Refresh this page to see the new account.`); }
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  const teachers = directory.profiles.filter(person => person.role === 'teacher');
  const students = directory.profiles.filter(person => person.role === 'student');
  return <>
    <div className="page-title"><h1>MANAGE<br /><em>THE CENTRE.</em></h1><p>Set up cohorts and courses, then connect existing accounts to the right learning spaces.</p></div>
    {error && <div role="alert" className="alert">{error}</div>}
    <div className="admin-setup-grid">
      <form className="panel admin-form account-form" onSubmit={event => void invite(event)}><h2>Invite an account</h2><p>Create a student or teacher account. With email configured, they receive a password setup link. Local development shows a link you can share.</p><label>Full name<input name="display_name" required minLength={2} maxLength={100} autoComplete="name" placeholder="e.g. Samira Khan" /></label><label>Email address<input name="email" type="email" required autoComplete="email" placeholder="name@example.com" /></label><label>Account role<select name="role" required defaultValue="student"><option value="student">Student</option><option value="teacher">Teacher</option></select></label><button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create account →'}</button>{setupUrl && <div className="notice invite-link"><p>Share this one-time password setup link with the invitee:</p><a href={setupUrl}>{setupUrl}</a></div>}<p className="helper">After inviting, use the forms below to enroll a student or assign a teacher.</p></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => createCohort(String(data.get('name'))))}><h2>Create a cohort</h2><p>Add a teaching group or intake.</p><label>Cohort name<input name="name" required minLength={2} maxLength={100} placeholder="e.g. Year 10 · Autumn" /></label><button className="primary" disabled={busy}>Create cohort</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => createCourse(String(data.get('title'))))}><h2>Create a course</h2><p>Add a subject to offer to cohorts.</p><label>Course name<input name="title" required minLength={2} maxLength={100} placeholder="e.g. Mathematics" /></label><button className="primary" disabled={busy}>Create course</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => offerCourse(String(data.get('cohort_id')), String(data.get('course_id'))))}><h2>Open a learning space</h2><p>Pair a cohort with a course.</p><label>Cohort<select name="cohort_id" required defaultValue=""><option value="" disabled>Select a cohort</option>{directory.cohorts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Course<select name="course_id" required defaultValue=""><option value="" disabled>Select a course</option>{directory.courses.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button className="primary" disabled={busy || !directory.cohorts.length || !directory.courses.length}>Create learning space</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => assignTeacher(String(data.get('space_id')), String(data.get('teacher_id'))))}><h2>Assign a teacher</h2><p>Give a teacher access to an existing learning space.</p><label>Learning space<select name="space_id" required defaultValue=""><option value="" disabled>Select a space</option>{spaces.map(item => <option key={item.id} value={item.id}>{item.cohortName} · {item.courseTitle}</option>)}</select></label><label>Teacher<select name="teacher_id" required defaultValue=""><option value="" disabled>Select a teacher</option>{teachers.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label><button className="primary" disabled={busy || !spaces.length || !teachers.length}>Assign teacher</button></form>
      <form className="panel admin-form" onSubmit={event => void submit(event, data => enrollStudent(String(data.get('cohort_id')), String(data.get('student_id'))))}><h2>Enroll a student</h2><p>Give a student access to all courses offered to their cohort.</p><label>Cohort<select name="cohort_id" required defaultValue=""><option value="" disabled>Select a cohort</option>{directory.cohorts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Student<select name="student_id" required defaultValue=""><option value="" disabled>Select a student</option>{students.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label><button className="primary" disabled={busy || !students.length || !directory.cohorts.length}>Enroll student</button></form>
    </div>
    <p className="helper">Only centre admins can invite accounts. Passwords are chosen by the invitee and are never shown to the admin.</p>
  </>;
}

function Empty({ title, text }: { title: string; text: string }) { return <section className="empty"><span>✦</span><h2>{title}</h2><p>{text}</p></section>; }

function StudentHome({ lessons, completed, percent, onOpen, onComplete, onClassroom, busy }: { lessons: Lesson[]; completed: Set<string>; percent: number; onOpen: (lesson: Lesson) => void; onComplete: (lesson: Lesson) => void; onClassroom: () => void; busy: boolean }) {
  const next = lessons.find(lesson => !completed.has(lesson.id));
  return <><div className="hero"><div><h1>PICK UP<br />WHERE YOU<br />LEFT OFF.</h1><p>Every lesson finished moves you forward.</p></div><article className="feature">{next ? <><span className="tag">NEXT UP · {next.kind.toUpperCase()}</span><h2>{next.title}</h2><p>{next.description || 'Open the material when you are ready.'}</p><button className="watch" onClick={() => onOpen(next)}>Open material →</button></> : <><span className="tag">ALL CAUGHT UP</span><h2>You're on track.</h2><p>New materials will appear here when your teacher publishes them.</p></>}</article></div><div className="overview-grid"><section className="panel"><div className="section-label">YOUR PROGRESS</div><div className="progress-number">{completed.size}<small> / {lessons.length} lessons</small></div><div className="meter"><i style={{ width: `${percent}%` }} /></div><p>{percent}% of published materials completed</p></section><section className="panel"><div className="section-label">UP NEXT</div>{next ? <><h3>{next.title}</h3><p>Once you've finished the recording or reading, mark it complete.</p><button className="outline" onClick={() => onComplete(next)} disabled={busy}>Mark complete</button></> : <p>No unfinished materials right now.</p>}</section></div><div className="section-head"><h2>Classroom materials</h2><button className="link" onClick={onClassroom}>View all →</button></div><LessonList lessons={lessons.slice(0, 3)} completed={completed} onOpen={onOpen} onComplete={onComplete} busy={busy} /></>;
}

function LessonList({ lessons, completed, staff = false, onOpen, onComplete, onDelete, busy }: { lessons: Lesson[]; completed: Set<string>; staff?: boolean; onOpen: (lesson: Lesson) => void; onComplete: (lesson: Lesson) => void; onDelete?: (lesson: Lesson) => void; busy: boolean }) {
  if (!lessons.length) return <>{staff && <p className="retention-note">Published files and records are permanently removed after 20 days. Teachers and admins can delete materials sooner.</p>}<Empty title="No materials yet" text="Your teacher's recordings and reading material will appear here." /></>;
  return <>{staff && <p className="retention-note">Published files and records are permanently removed after 20 days. Teachers and admins can delete materials sooner.</p>}<div className="lesson-list">{lessons.map((lesson, index) => <article className="lesson-row" key={lesson.id}><div className="row-index">{String(index + 1).padStart(2, '0')}</div><div className="row-main"><div><span className="type-tag">{lesson.kind === 'recording' ? '▶ RECORDING' : '▤ READING'}</span>{staff && <span className={`status-tag ${lesson.status}`}>{lesson.status}</span>}</div><h3>{lesson.title}</h3><p>{lesson.description || lesson.original_name || 'Course material'}</p></div><div className="row-actions">{lesson.storage_path && <button className="outline" onClick={() => onOpen(lesson)}>Open</button>}{staff && onDelete && <button className="small-btn delete-material" disabled={busy} onClick={() => onDelete(lesson)}>Delete permanently</button>}{!staff && (completed.has(lesson.id) ? <span className="completed">✓ Completed</span> : <button className="small-btn" disabled={busy} onClick={() => onComplete(lesson)}>Mark complete</button>)}</div></article>)}</div></>;
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

function SchedulePage({ space, profile, userId, onNotice }: { space: CourseSpace; profile: Profile; userId: string; onNotice: (value: string) => void }) {
  const canSchedule = profile.role === 'teacher';
  const canMark = profile.role === 'teacher' || profile.role === 'admin';
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [selected, setSelected] = useState('');
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  async function refresh() {
    setLoading(true); setError('');
    try {
      const [found, roster] = await Promise.all([getClassSessions(space.id), canMark ? getStudents(space.id) : Promise.resolve([])]);
      setSessions(found); setStudents(roster);
      setSelected(current => found.some(item => item.id === current) ? current : '');
    } catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [space.id]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!selected || !canMark) { setAttendance([]); return; }
    void getSessionAttendance(selected).then(rows => {
      setAttendance(students.map(student => rows.find(row => row.student_id === student.id) || {
        session_id: selected, student_id: student.id, attendance_status: 'unmarked', counts_toward_package: false, marked_by: userId
      }));
    }).catch(failure => setError(message(failure)));
  }, [selected, students, canMark, userId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const starts = String(data.get('starts_at'));
    const ends = String(data.get('ends_at'));
    setBusy(true); setError('');
    try {
      await createClassSession({ spaceId: space.id, teacherId: userId, title: String(data.get('title')), startsAt: new Date(starts).toISOString(), endsAt: ends ? new Date(ends).toISOString() : '', meetingUrl: String(data.get('meeting_url')) });
      form.reset(); await refresh(); onNotice('Class scheduled.');
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function saveAttendance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { await saveSessionAttendance(attendance.map(row => ({ ...row, marked_by: userId }))); onNotice('Attendance saved. Package counts were updated from the chargeable classes.'); setSelected(''); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  function changeRow(studentId: string, change: Partial<Attendance>) {
    setAttendance(rows => rows.map(row => row.student_id === studentId ? { ...row, ...change } : row));
  }
  const dateTime = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));
  const chosen = sessions.find(item => item.id === selected);

  return <>
    <div className="page-title"><h1>CLASS<br /><em>SCHEDULE.</em></h1><p>{space.cohortName} · {space.courseTitle}. Times display in India Standard Time.</p></div>
    {canSchedule && <form className="upload-form panel schedule-form" onSubmit={create}>
      <h2>Schedule a class</h2><label>Class title<input name="title" required minLength={2} maxLength={160} placeholder="e.g. Algebra — Chapter 4" /></label>
      <label>Starts<input name="starts_at" type="datetime-local" required /></label><label>Ends (optional)<input name="ends_at" type="datetime-local" /></label>
      <label>Meet or Zoom link<input name="meeting_url" type="url" placeholder="https://meet.google.com/..." required /></label>
      <p className="helper">Create the call in your existing video service and paste its link here. Students can open the link from this schedule.</p>
      {error && <p role="alert" className="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Schedule class →'}</button>
    </form>}
    {error && !canSchedule && <p role="alert" className="alert">{error}</p>}
    <div className="section-head"><h2>Scheduled classes</h2><span>{sessions.length} classes</span></div>
    {loading ? <p className="loading">Loading schedule…</p> : !sessions.length ? <Empty title="No classes scheduled" text="New class times and meeting links will appear here." /> : <div className="lesson-list">
      {sessions.map(session => {
        const startsAt = new Date(session.starts_at).getTime();
        const endsAt = session.ends_at ? new Date(session.ends_at).getTime() : Number.POSITIVE_INFINITY;
        const canJoin = now >= startsAt && now <= endsAt;
        const ended = now > endsAt;
        return <article className="lesson-row" key={session.id}><div className="date-chip">{dateTime(session.starts_at)}</div><div className="row-main"><span className="type-tag">{canJoin ? 'LIVE NOW' : ended ? 'ENDED' : 'UPCOMING'}</span><h3>{session.title}</h3><p>{session.ends_at ? `Until ${dateTime(session.ends_at)}` : 'Class time'}</p></div><div className="row-actions">{canJoin ? <a className="outline" href={session.meeting_url} target="_blank" rel="noreferrer">Join class ↗</a> : <button className="outline" type="button" disabled>{ended ? 'Class ended' : `Join available ${dateTime(session.starts_at)}`}</button>}{canMark && <button className="small-btn" onClick={() => setSelected(current => current === session.id ? '' : session.id)}>{selected === session.id ? 'Close attendance' : 'Mark attendance'}</button>}</div></article>;
      })}
    </div>}
    {chosen && canMark && <form className="panel attendance-panel" onSubmit={saveAttendance}><div className="section-head"><div><h2>Attendance · {chosen.title}</h2><p>{dateTime(chosen.starts_at)}. New records do not count toward a package until you tick the box. You decide whether missed or cancelled classes count.</p></div></div>
      {!students.length ? <p>No students enrolled in this learning space.</p> : <div className="attendance-list">{attendance.map(row => { const student = students.find(person => person.id === row.student_id)!; return <div className="student-row attendance-row" key={row.student_id}><div className="student-name"><strong>{student.display_name}</strong></div><label className="attendance-select">Attendance<select value={row.attendance_status} onChange={event => changeRow(row.student_id, { attendance_status: event.target.value as Attendance['attendance_status'] })}><option value="unmarked" disabled>Choose status</option><option value="attended">Attended</option><option value="missed">Missed</option><option value="cancelled">Cancelled</option></select></label><label className="checkbox-label"><input type="checkbox" checked={row.counts_toward_package} onChange={event => changeRow(row.student_id, { counts_toward_package: event.target.checked })} /> Counts toward package</label></div>; })}</div>}
      {error && <p role="alert" className="alert">{error}</p>}<button className="primary" disabled={busy || !attendance.length}>{busy ? 'Saving…' : 'Save attendance →'}</button>
    </form>}
  </>;
}

function PackagesPage({ space, adminId, students, isAdmin, onNotice }: { space: CourseSpace; adminId: string; students: Profile[]; isAdmin: boolean; onNotice: (value: string) => void }) {
  const [plans, setPlans] = useState<PackagePlan[]>([]);
  const [packages, setPackages] = useState<StudentPackage[]>([]);
  const [payments, setPayments] = useState<PackagePayment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState('');

  async function refresh() {
    setError('');
    try {
      const [foundPlans, foundPackages] = await Promise.all([getPackagePlans(), getStudentPackages(space.id)]);
      const history = await getPackagePayments(foundPackages.map(item => item.id));
      setPlans(foundPlans); setPackages(foundPackages); setPayments(history);
    }
    catch (failure) { setError(message(failure)); }
  }
  useEffect(() => { void refresh(); }, [space.id]);
  const selectedPackage = packages.find(item => item.student_id === selectedStudentId);
  const money = (amount: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);

  async function addPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    setBusy(true); setError('');
    try { await createPackagePlan({ name: String(data.get('name')), classCount: Number(data.get('class_count')), amount: Number(data.get('amount')), adminId }); form.reset(); await refresh(); onNotice('Package plan created.'); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    setBusy(true); setError('');
    try { await assignStudentPackage({ studentId: String(data.get('student_id')), spaceId: space.id, planId: String(data.get('plan_id')), adminId }); form.reset(); setSelectedStudentId(''); setSelectedPlanId(''); await refresh(); onNotice(selectedPackage ? 'Package plan updated.' : 'Class package assigned.'); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function confirm(event: FormEvent<HTMLFormElement>, pkg: StudentPackage) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const file = data.get('receipt');
    const receipt = file instanceof File && file.size ? file : null;
    if (receipt && !['image/jpeg','image/png','image/webp','application/pdf'].includes(receipt.type)) { setError('Choose a JPG, PNG, WebP, or PDF receipt.'); return; }
    setBusy(true); setError(''); let path = '';
    try {
      if (receipt) path = await uploadPaymentReceipt(pkg.id, receipt);
      await confirmPackagePayment({ packageId: pkg.id, amount: Number(data.get('amount')), paidAt: new Date(String(data.get('paid_at'))).toISOString(), reference: String(data.get('reference')), receiptPath: path || null });
      setConfirming(''); await refresh(); onNotice('Payment confirmed and receipt saved. The next package cycle is active.');
    } catch (failure) { if (path) await deletePaymentReceipt(path).catch(() => undefined); setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function viewReceipt(path: string) {
    try { const url = await getPaymentReceiptUrl(path); window.open(url, '_blank', 'noopener,noreferrer'); }
    catch (failure) { setError(message(failure)); }
  }

  return <>
    <div className="page-title"><h1>CLASS<br /><em>PACKAGES.</em></h1><p>{space.cohortName} · {space.courseTitle}. Payment status is visible to students; access stays available.</p></div>
    {error && <div role="alert" className="alert">{error}</div>}
    {isAdmin && plans.length > 0 && !students.length && <p className="helper">No students are enrolled in this learning space yet. Enroll students under Manage Centre before assigning packages.</p>}
    {isAdmin && <div className="admin-setup-grid package-admin-grid">
      <form className="panel admin-form" onSubmit={addPlan}><h2>Create a package plan</h2><p>The centre sets the fee and included classes.</p><label>Plan name<input name="name" required minLength={2} maxLength={100} placeholder="e.g. 12 class package" /></label><label>Classes included<input name="class_count" type="number" min="1" step="1" required /></label><label>Package fee (INR)<input name="amount" type="number" min="0" step="0.01" required /></label><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Create plan'}</button></form>
      <form className="panel admin-form" onSubmit={assign}><h2>Assign a package</h2><p>Choose a plan for an enrolled student. An unused package can be changed here.</p><label>Student<select name="student_id" required value={selectedStudentId} onChange={event => { const id = event.target.value; setSelectedStudentId(id); setSelectedPlanId(packages.find(item => item.student_id === id)?.plan_id || ''); }}><option value="" disabled>Select a student</option>{students.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label><label>Package plan<select name="plan_id" required value={selectedPlanId} onChange={event => setSelectedPlanId(event.target.value)}><option value="" disabled>Select a plan</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.class_count} classes · {money(plan.amount)}</option>)}</select></label>{selectedPackage && <p className="helper">Current plan: {selectedPackage.package_plans.name}. You can change it before attendance is recorded or a payment is confirmed.</p>}<button className="primary" disabled={busy || !students.length || !plans.length}>{busy ? 'Saving…' : selectedPackage ? 'Update package' : 'Assign package'}</button></form>
    </div>}
    {isAdmin && !plans.length && <p className="helper">Create a package plan before assigning one to a student.</p>}
    <div className="section-head"><h2>{isAdmin ? 'Student packages' : 'Your package'}</h2><span>{packages.length} assigned</span></div>
    {!packages.length ? <Empty title="No package assigned" text={isAdmin ? 'Assign a plan to each enrolled student for this course.' : 'Ask the academy admin to assign your class package.'} /> : <div className="lesson-list">
      {packages.map(pkg => <article className="package-row" key={pkg.id}><div className="row-main"><div><span className={`status-tag ${pkg.status === 'payment_due' || pkg.status === 'locked_future' ? 'draft' : 'published'}`}>{pkg.status === 'payment_due' ? 'PAYMENT DUE' : pkg.status === 'locked_future' ? 'LOCKED' : 'ACTIVE'}</span></div><h3>{isAdmin ? pkg.profiles?.display_name || students.find(person => person.id === pkg.student_id)?.display_name : pkg.package_plans.name}</h3><p>{pkg.package_plans.name} · {money(Number(pkg.package_plans.amount))} · {pkg.sessions_attended} of {pkg.package_plans.class_count} chargeable classes</p><div className="meter"><i style={{ width: `${Math.min(100, Math.round(pkg.sessions_attended / pkg.package_plans.class_count * 100))}%` }} /></div>{pkg.status === 'payment_due' && <p className="due-copy">This package is complete. The admin will confirm the next payment.</p>}{payments.filter(payment => payment.student_package_id === pkg.id).length > 0 && <div className="payment-history"><strong>Confirmed payments</strong>{payments.filter(payment => payment.student_package_id === pkg.id).map(payment => <div key={payment.id}><span>{money(Number(payment.amount))} · {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(payment.paid_at))}{payment.reference ? ` · ${payment.reference}` : ''}</span>{isAdmin && payment.receipt_path && <button type="button" className="link" onClick={() => void viewReceipt(payment.receipt_path!)}>View receipt ↗</button>}</div>)}</div>}</div>
        {isAdmin && pkg.status === 'payment_due' && <button className="small-btn" onClick={() => setConfirming(confirming === pkg.id ? '' : pkg.id)}>{confirming === pkg.id ? 'Close' : 'Confirm payment'}</button>}
        {isAdmin && confirming === pkg.id && <form className="payment-confirm-form" onSubmit={event => void confirm(event, pkg)}><label>Amount received (INR)<input name="amount" type="number" min="0" step="0.01" defaultValue={pkg.package_plans.amount} required /></label><label>Payment date<input name="paid_at" type="date" defaultValue={new Date().toISOString().slice(0,10)} required /></label><label>Bank or UPI reference (optional)<input name="reference" maxLength={120} /></label><label>Receipt or payment screenshot (optional)<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label><p className="helper">Only admins can view an uploaded receipt. Confirming resets the attended-class count for the next package cycle.</p><button className="primary" disabled={busy}>{busy ? 'Uploading and confirming…' : 'Confirm payment →'}</button></form>}
      </article>)}
    </div>}
    {isAdmin && <p className="helper">A class counts when its teacher marks “Counts toward package” in attendance. Reaching the plan limit changes the status to Payment due. Access is not blocked in this release.</p>}
  </>;
}
