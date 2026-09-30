import * as tus from 'tus-js-client';
import { supabase, supabaseUrl } from './supabase';
import type { AdminDirectory, Completion, CourseSpace, Lesson, Profile, Role } from './types';

const db = () => {
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase;
};
const unwrap = <T,>(result: { data: T | null; error: { message: string } | null }): T => {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
};

export async function getProfile(id: string): Promise<Profile> {
  return unwrap((await db().from('profiles').select('id,display_name,role').eq('id', id).single()) as never);
}

export async function getSpaces(role: Role, userId: string): Promise<CourseSpace[]> {
  let ids: string[] | null = null;
  if (role === 'student') {
    const memberships = unwrap<Array<{ cohort_id: string }>>(await db().from('cohort_members').select('cohort_id').eq('student_id', userId));
    if (!memberships.length) return [];
    const spaces = unwrap<Array<{ id: string }>>(await db().from('cohort_courses').select('id').in('cohort_id', memberships.map(m => m.cohort_id)));
    ids = spaces.map(s => s.id);
  } else if (role === 'teacher') {
    const assignments = unwrap<Array<{ cohort_course_id: string }>>(await db().from('teacher_assignments').select('cohort_course_id').eq('teacher_id', userId));
    ids = assignments.map(a => a.cohort_course_id);
  }
  if (ids && !ids.length) return [];
  const query = db().from('cohort_courses').select('id,cohort_id,course_id');
  const rows = unwrap<Array<{ id: string; cohort_id: string; course_id: string }>>(await (ids ? query.in('id', ids) : query));
  if (!rows.length) return [];
  const [courses, cohorts] = await Promise.all([
    db().from('courses').select('id,title').in('id', [...new Set(rows.map(r => r.course_id))]),
    db().from('cohorts').select('id,name').in('id', [...new Set(rows.map(r => r.cohort_id))])
  ]);
  const courseMap = new Map(unwrap<Array<{ id: string; title: string }>>(courses).map(c => [c.id, c.title]));
  const cohortMap = new Map(unwrap<Array<{ id: string; name: string }>>(cohorts).map(c => [c.id, c.name]));
  return rows.map(r => ({ id: r.id, courseTitle: courseMap.get(r.course_id) ?? 'Course', cohortName: cohortMap.get(r.cohort_id) ?? 'Cohort' }));
}

export async function getAdminDirectory(): Promise<AdminDirectory> {
  const [profiles, cohorts, courses] = await Promise.all([
    db().from('profiles').select('id,display_name,role').order('display_name'),
    db().from('cohorts').select('id,name').order('name'),
    db().from('courses').select('id,title').order('title')
  ]);
  return {
    profiles: unwrap<Profile[]>(profiles),
    cohorts: unwrap<AdminDirectory['cohorts']>(cohorts),
    courses: unwrap<AdminDirectory['courses']>(courses)
  };
}

export async function inviteAccount(input: { displayName: string; email: string; role: 'student' | 'teacher' }): Promise<string> {
  const { data, error } = await db().functions.invoke<{ message?: string; error?: string }>('invite-account', {
    body: input
  });
  if (error) {
    const details = 'context' in error && error.context instanceof Response
      ? await error.context.json().catch(() => null) as { error?: string } | null
      : null;
    throw new Error(details?.error || error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data?.message || 'Invitation sent.';
}

export async function createCohort(name: string): Promise<void> {
  unwrap(await db().from('cohorts').insert({ name: name.trim() }));
}

export async function createCourse(title: string): Promise<void> {
  unwrap(await db().from('courses').insert({ title: title.trim() }));
}

export async function offerCourse(cohortId: string, courseId: string): Promise<void> {
  unwrap(await db().from('cohort_courses').insert({ cohort_id: cohortId, course_id: courseId }));
}

export async function assignTeacher(spaceId: string, teacherId: string): Promise<void> {
  unwrap(await db().from('teacher_assignments').insert({ cohort_course_id: spaceId, teacher_id: teacherId }));
}

export async function enrollStudent(cohortId: string, studentId: string): Promise<void> {
  unwrap(await db().from('cohort_members').insert({ cohort_id: cohortId, student_id: studentId }));
}

export async function getLessons(spaceId: string, role: Role): Promise<Lesson[]> {
  let query = db().from('lessons').select('*').eq('cohort_course_id', spaceId).order('created_at', { ascending: true });
  if (role === 'student') query = query.eq('status', 'published');
  return unwrap<Lesson[]>(await query);
}

export async function getCompletions(lessonIds: string[]): Promise<Completion[]> {
  if (!lessonIds.length) return [];
  return unwrap<Completion[]>(await db().from('lesson_progress').select('lesson_id,student_id,completed_at').in('lesson_id', lessonIds));
}

export async function getStudents(spaceId: string): Promise<Profile[]> {
  const space = unwrap<{ cohort_id: string }>(await db().from('cohort_courses').select('cohort_id').eq('id', spaceId).single());
  const members = unwrap<Array<{ student_id: string }>>(await db().from('cohort_members').select('student_id').eq('cohort_id', space.cohort_id));
  if (!members.length) return [];
  return unwrap<Profile[]>(await db().from('profiles').select('id,display_name,role').in('id', members.map(m => m.student_id)).order('display_name'));
}

export async function markComplete(studentId: string, lessonId: string): Promise<void> {
  unwrap(await db().from('lesson_progress').insert({ student_id: studentId, lesson_id: lessonId }));
}

export async function openMaterial(lesson: Lesson): Promise<void> {
  if (!lesson.storage_path) throw new Error('This lesson has no file yet.');
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const signed = unwrap<{ signedUrl: string }>(await db().storage.from('lesson-materials').createSignedUrl(lesson.storage_path, 300));
    if (tab) tab.location.href = signed.signedUrl;
    else window.location.href = signed.signedUrl;
  } catch (error) {
    tab?.close();
    throw error;
  }
}

function uploadFile(file: File, path: string, onProgress: (value: number) => void): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const { data, error } = await db().auth.getSession();
      if (error || !data.session) throw new Error('Please sign in again before uploading.');
      const project = new URL(supabaseUrl!).hostname.split('.')[0];
      const upload = new tus.Upload(file, {
        endpoint: `https://${project}.storage.supabase.co/storage/v1/upload/resumable`,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        headers: { authorization: `Bearer ${data.session.access_token}` },
        metadata: { bucketName: 'lesson-materials', objectName: path, contentType: file.type || 'application/octet-stream' },
        chunkSize: 6 * 1024 * 1024,
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => onProgress(Math.round(sent / total * 100)),
        onError: reject,
        onSuccess: () => resolve()
      });
      const previous = await upload.findPreviousUploads();
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    } catch (error) { reject(error); }
  });
}

export async function createMaterial(input: {
  spaceId: string; title: string; description: string; kind: 'recording' | 'reading';
  file: File; teacherId: string; onProgress: (value: number) => void;
}): Promise<void> {
  const lesson = unwrap<{ id: string }>(await db().from('lessons').insert({
    cohort_course_id: input.spaceId, title: input.title.trim(), description: input.description.trim() || null,
    kind: input.kind, created_by: input.teacherId
  }).select('id').single());
  const safeName = input.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${input.spaceId}/${lesson.id}/${crypto.randomUUID()}-${safeName}`;
  await uploadFile(input.file, path, input.onProgress);
  unwrap(await db().from('lessons').update({
    storage_path: path, original_name: input.file.name, status: 'published', published_at: new Date().toISOString()
  }).eq('id', lesson.id));
}
