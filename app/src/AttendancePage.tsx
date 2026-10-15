import { useEffect, useState, type FormEvent } from 'react';
import { getStudentAttendance, getTeacherAttendance, getWorkingHours, overrideTeacherAttendance, saveWorkingHours } from './data';
import { formatMinutes, hourSegments, slotMinutes, summarizeTeacherDay } from './attendanceHours';
import type { AdminDirectory, CourseSpace, StudentAttendanceReport, TeacherAttendanceDay, WorkingHours } from './types';

const currentMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date());
const friendlyTime = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const teacherStatus = (status: TeacherAttendanceDay['status']) => ({ attended: 'Present', missed: 'Absent', pending: 'Waiting for link', upcoming: 'Coming up' })[status];
const studentStatus = (status: 'attended' | 'missed' | 'cancelled') => ({ attended: 'Present', missed: 'Absent', cancelled: 'Cancelled' })[status];

export function TeacherCalendar({ days, month, busy = false, onChange }: { days: TeacherAttendanceDay[]; month: string; busy?: boolean; onChange?: (day: TeacherAttendanceDay, status: 'attended' | 'missed') => void }) {
  const [openDate, setOpenDate] = useState<string | null>(null);
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5)) - 1;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const leading = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const dates = Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
  const selectedDate = openDate?.startsWith(month) ? openDate : null;
  const selectedSlots = days.filter(day => day.class_date === selectedDate).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const selectedTotals = summarizeTeacherDay(selectedSlots);
  function slotDetail(slot: TeacherAttendanceDay) {
    return <div className="calendar-class-more"><span>{slot.starts_at}–{slot.ends_at} IST · {formatMinutes(slotMinutes(slot))} · {teacherStatus(slot.status)}</span>{slot.submitted_at && <span>Link sent {friendlyTime(slot.submitted_at)}</span>}{slot.overridden && <span>Changed by admin</span>}
      {onChange && (slot.status === 'attended' || slot.status === 'missed') && <button type="button" disabled={busy} onClick={() => onChange(slot, slot.status === 'missed' ? 'attended' : 'missed')}>Mark {slot.status === 'missed' ? 'present' : 'absent'}</button>}
    </div>;
  }
  return <>
    <div className="attendance-dot-legend" aria-label="Attendance colours"><span><i className="attendance-hour-dot attended" />Present</span><span><i className="attendance-hour-dot missed" />Absent</span><span><i className="attendance-hour-dot pending" />Waiting for link</span><span><i className="attendance-hour-dot upcoming" />Coming up</span></div>
    <p className="helper">Each dot shows up to one hour of a class. Tap a date on phones or open a class to see exact times.</p>
    {days.length ? <div className="attendance-calendar" aria-label="Teacher attendance calendar">
      <div className="calendar-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-grid">{Array.from({ length: leading }, (_, index) => <div className="calendar-cell empty-cell" key={`empty-${index}`} />)}
        {dates.map(date => {
          const slots = days.filter(day => day.class_date === date).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
          const totals = summarizeTeacherDay(slots);
          return <div className="calendar-cell" key={date}>
            <div className="calendar-desktop-day"><strong>{Number(date.slice(-2))}</strong>
            {slots.length > 0 && <small className="calendar-day-hours">{formatMinutes(totals.creditedMinutes)} present{totals.missedMinutes > 0 ? ` · ${formatMinutes(totals.missedMinutes)} absent` : ''}{totals.overlapMinutes > 0 ? ' · shared time counted once' : ''}</small>}
            {slots.map(slot => <details className="calendar-class-dots" key={slot.space_id}>
              <summary><span className="calendar-class-name">{slot.space_name}</span><span className="attendance-dots" role="img" aria-label={`${teacherStatus(slot.status)} for ${formatMinutes(slotMinutes(slot))}`}>
                {hourSegments(slot).map((minutes, index) => <i key={index} className={`attendance-hour-dot ${slot.status}`} title={`${teacherStatus(slot.status)} · ${formatMinutes(minutes)}`} />)}
              </span></summary>
              {slotDetail(slot)}
            </details>)}</div>
            <button type="button" className={`calendar-mobile-day ${selectedDate === date ? 'selected' : ''}`} aria-label={`${date}: ${slots.length ? `${slots.length} scheduled ${slots.length === 1 ? 'class' : 'classes'}` : 'no classes'}`} aria-pressed={selectedDate === date} onClick={() => setOpenDate(current => current === date ? null : date)}><strong>{Number(date.slice(-2))}</strong><span className="calendar-mobile-dots" aria-hidden="true">{slots.flatMap(slot => hourSegments(slot).map((_, index) => <i key={`${slot.space_id}-${index}`} className={`attendance-hour-dot ${slot.status}`} />))}</span></button>
          </div>;
        })}
      </div>
      {selectedDate && <section className="calendar-mobile-detail" aria-live="polite"><h3>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${selectedDate}T12:00:00Z`))}</h3>{selectedSlots.length ? <><p>{formatMinutes(selectedTotals.creditedMinutes)} present{selectedTotals.missedMinutes > 0 ? ` · ${formatMinutes(selectedTotals.missedMinutes)} absent` : ''}{selectedTotals.overlapMinutes > 0 ? ' · shared time counted once' : ''}</p>{selectedSlots.map(slot => <article className="calendar-mobile-class" key={slot.space_id}><strong>{slot.space_name}</strong><span className="attendance-dots" role="img" aria-label={`${teacherStatus(slot.status)} for ${formatMinutes(slotMinutes(slot))}`}>{hourSegments(slot).map((minutes, index) => <i key={index} className={`attendance-hour-dot ${slot.status}`} title={`${teacherStatus(slot.status)} · ${formatMinutes(minutes)}`} />)}</span>{slotDetail(slot)}</article>)}</> : <p>No classes scheduled.</p>}</section>}
    </div> : <p>No classes scheduled for this month.</p>}
  </>;
}

function StudentReport({ report }: { report: StudentAttendanceReport | null }) {
  const pending = report?.classes.filter(item => !item.attendance_status) || [];
  const packages = report?.packages || [];
  const remaining = packages.reduce((sum, item) => sum + Number(item.remaining), 0);
  const total = packages.reduce((sum, item) => sum + Number(item.class_count), 0);
  return <>
    {packages.length ? <><div className="student-attendance-summary"><span>Classes remaining</span><strong>{remaining}<small> / {total}</small></strong><p>Across {packages.length} {packages.length === 1 ? 'class package' : 'class packages'}</p><div className="student-attendance-meter" role="img" aria-label={`${remaining} of ${total} classes remaining`}><span style={{ width: `${total ? remaining / total * 100 : 0}%` }} /></div></div><div className="student-package-grid">{packages.map((item, index) => <article className="student-package-card" key={`${item.cohort_name}-${item.course_title}-${index}`}><span>{item.cohort_name} · {item.course_title}</span><strong>{item.remaining}<small> of {item.class_count}</small></strong><p>classes remaining</p></article>)}</div></> : <p>No class package assigned.</p>}
    <section className="student-attendance-list"><h3>Waiting for attendance <span>{pending.length}</span></h3>
    {pending.length ? pending.map(item => <div className="student-attendance-row" key={item.session_id}><div><strong>{item.title}</strong><small>{item.cohort_name} · {item.course_title} · {friendlyTime(item.starts_at)}</small></div><span className="status-tag">Not marked yet</span></div>) : <p>No classes waiting for attendance.</p>}</section>
    <section className="student-attendance-list"><h3>Recorded classes</h3>
    {report?.classes.filter(item => item.attendance_status).map(item => <div className="student-attendance-row" key={item.session_id}><div><strong>{item.title}</strong><small>{item.cohort_name} · {item.course_title} · {friendlyTime(item.starts_at)}</small></div><span className="status-tag">{studentStatus(item.attendance_status!)}</span></div>)}
    {!report?.classes.some(item => item.attendance_status) && <p>No attendance recorded yet.</p>}</section>
  </>;
}

export function TeacherAttendancePage({ teacherId }: { teacherId: string }) {
  const [month, setMonth] = useState(currentMonth);
  const [days, setDays] = useState<TeacherAttendanceDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void getTeacherAttendance(teacherId, month).then(rows => { if (!cancelled) setDays(rows); })
      .catch(failure => { if (!cancelled) setError(errorMessage(failure)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [teacherId, month]);
  return <>
    <div className="page-title"><h1>MY<br /><em>ATTENDANCE.</em></h1><p>All your learning spaces in one calendar. Times are in India Standard Time.</p></div>
    {error && <p role="alert" className="alert">{error}</p>}
    <section className="panel teacher-attendance-page"><div className="section-head"><h2>Class calendar</h2><input aria-label="Calendar month" type="month" value={month} onChange={event => setMonth(event.target.value)} /></div>
      {loading ? <p>Loading attendance…</p> : <TeacherCalendar days={days} month={month} />}
    </section>
  </>;
}

export function WorkingHoursSetup({ spaces }: { spaces: CourseSpace[] }) {
  const [spaceId, setSpaceId] = useState(spaces[0]?.id || '');
  const [hours, setHours] = useState<WorkingHours | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!spaceId) { setHours(null); return; }
    let cancelled = false;
    void getWorkingHours(spaceId).then(value => { if (!cancelled) setHours(value); })
      .catch(failure => { if (!cancelled) setError(errorMessage(failure)); });
    return () => { cancelled = true; };
  }, [spaceId]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    setBusy(true); setError(''); setNotice('');
    try {
      await saveWorkingHours(spaceId, String(values.get('starts_at')), String(values.get('ends_at')));
      setHours(await getWorkingHours(spaceId));
      setNotice('Class hours saved.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <form id="setup-hours" className="panel admin-form" onSubmit={save} key={spaceId}>
    <h2>Set class hours</h2><p>Choose the daily time for a learning space, Monday to Friday. Times are in IST.</p>
    <label>Learning space<select value={spaceId} onChange={event => setSpaceId(event.target.value)}>{spaces.map(space => <option key={space.id} value={space.id}>{space.cohortName} · {space.courseTitle}</option>)}</select></label>
    <div className="attendance-time-fields"><label>Start<input type="time" name="starts_at" required defaultValue={hours?.starts_at || ''} key={`start-${hours?.starts_at}`} /></label><label>End<input type="time" name="ends_at" required defaultValue={hours?.ends_at || ''} key={`end-${hours?.ends_at}`} /></label></div>
    {error && <p role="alert" className="alert">{error}</p>}{notice && <p role="status" className="helper">{notice}</p>}
    <button className="primary" disabled={busy || !spaceId}>Save class hours</button>
  </form>;
}

export function AdminAttendancePage({ directory }: { directory: AdminDirectory }) {
  const [kind, setKind] = useState<'teacher' | 'student'>('teacher');
  const [personId, setPersonId] = useState('');
  const [month, setMonth] = useState(currentMonth);
  const [teacherDays, setTeacherDays] = useState<TeacherAttendanceDay[]>([]);
  const [studentReport, setStudentReport] = useState<StudentAttendanceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const people = directory.profiles.filter(person => person.role === kind);

  useEffect(() => { setPersonId(''); setTeacherDays([]); setStudentReport(null); setError(''); }, [kind]);
  useEffect(() => {
    if (!personId) return;
    let cancelled = false;
    setError(''); setLoading(true); setTeacherDays([]); setStudentReport(null);
    const request = kind === 'teacher' ? getTeacherAttendance(personId, month).then(value => { if (!cancelled) setTeacherDays(value); }) : getStudentAttendance(personId).then(value => { if (!cancelled) setStudentReport(value); });
    void request.catch(failure => { if (!cancelled) setError(errorMessage(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, personId, month]);

  async function changeStatus(day: TeacherAttendanceDay, status: 'attended' | 'missed') {
    setBusy(true); setError('');
    try { await overrideTeacherAttendance(personId, day.space_id, day.class_date, status); setTeacherDays(await getTeacherAttendance(personId, month)); setNotice(`Teacher marked ${status === 'attended' ? 'present' : 'absent'}.`); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-title"><h1>ATTENDANCE<br /><em>CALENDAR.</em></h1><p>Teacher classes and student attendance. Times are in India Standard Time.</p></div>
    {error && <p role="alert" className="alert">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <div className="attendance-tabs" role="group" aria-label="Attendance type"><button className={kind === 'teacher' ? 'selected' : ''} onClick={() => setKind('teacher')}>Teachers</button><button className={kind === 'student' ? 'selected' : ''} onClick={() => setKind('student')}>Students</button></div>
    <div className="attendance-layout">
      <section className="panel roster"><div className="section-head"><h2>{kind === 'teacher' ? 'Teachers' : 'Students'}</h2><span>{people.length} total</span></div>{people.map(person => <button key={person.id} type="button" className={`student-row admin-directory-row ${personId === person.id ? 'selected' : ''}`} onClick={() => setPersonId(person.id)}><span className="student-avatar">{person.display_name.slice(0, 2).toUpperCase()}</span><span className="student-name"><strong>{person.display_name}</strong></span><span aria-hidden="true">›</span></button>)}</section>
      <section className="panel attendance-detail">
        {!personId ? <p>Select a {kind} to view attendance.</p> : <><div className="section-head"><h2>{people.find(person => person.id === personId)?.display_name}</h2>{kind === 'teacher' && <input aria-label="Calendar month" type="month" value={month} onChange={event => setMonth(event.target.value)} />}</div>
          {loading ? <p>Loading attendance…</p> : kind === 'teacher' ? <TeacherCalendar days={teacherDays} month={month} busy={busy} onChange={changeStatus} /> : <StudentReport report={studentReport} />}</>}
      </section>
    </div>
  </>;
}
