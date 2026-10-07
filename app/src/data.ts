import { api } from './backend';
import type { AdminDirectory, Attendance, ClassSession, Completion, CourseSpace, Lesson, PackagePayment, PackagePlan, Profile, Role, StudentPackage } from './types';

export async function getProfile(_id?: string): Promise<Profile> { return api('/me'); }
export async function getSpaces(_role?: Role, _userId?: string): Promise<CourseSpace[]> { return api('/spaces'); }
export async function getAdminDirectory(): Promise<AdminDirectory> { return api('/admin/directory'); }
export async function inviteAccount(input: { displayName: string; email: string; role: 'student' | 'teacher' }): Promise<{ message: string; setupUrl?: string; emailSent?: boolean }> {
  return api('/admin/invitations', { method: 'POST', body: JSON.stringify(input) });
}
export async function createCohort(name: string): Promise<void> { await api('/admin/cohorts', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); }
export async function createCourse(title: string): Promise<void> { await api('/admin/courses', { method: 'POST', body: JSON.stringify({ title: title.trim() }) }); }
export async function offerCourse(cohortId: string, courseId: string): Promise<void> { await api('/admin/spaces', { method: 'POST', body: JSON.stringify({ cohortId, courseId }) }); }
export async function assignTeacher(spaceId: string, teacherId: string): Promise<void> { await api('/admin/teacher-assignments', { method: 'POST', body: JSON.stringify({ spaceId, teacherId }) }); }
export async function enrollStudent(cohortId: string, studentId: string): Promise<void> { await api('/admin/enrollments', { method: 'POST', body: JSON.stringify({ cohortId, studentId }) }); }
export async function getLessons(spaceId: string, _role?: Role): Promise<Lesson[]> { return api(`/spaces/${spaceId}/lessons`); }
export async function getCompletions(lessonIds: string[]): Promise<Completion[]> {
  if (!lessonIds.length) return [];
  const groups = await Promise.all(lessonIds.map(id => api<Completion[]>(`/lessons/${id}/completions`)));
  return groups.flat();
}
export async function getStudents(spaceId: string): Promise<Profile[]> { return api(`/spaces/${spaceId}/students`); }
export async function markComplete(_studentId: string, lessonId: string): Promise<void> { await api(`/lessons/${lessonId}/complete`, { method: 'POST', body: '{}' }); }
export async function deleteMaterial(lessonId: string): Promise<void> { await api(`/lessons/${lessonId}`, { method: 'DELETE' }); }
export async function getClassSessions(spaceId: string): Promise<ClassSession[]> { return api(`/spaces/${spaceId}/sessions`); }
export async function getSpaceAttendance(spaceId: string): Promise<Attendance[]> { return api(`/spaces/${spaceId}/attendance`); }
export async function createClassSession(input: { spaceId: string; teacherId: string; title: string; startsAt: string; endsAt: string; meetingUrl: string }): Promise<void> {
  await api(`/spaces/${input.spaceId}/sessions`, { method: 'POST', body: JSON.stringify({ title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt, meetingUrl: input.meetingUrl.trim() }) });
}
export async function getSessionAttendance(sessionId: string): Promise<Attendance[]> { return api(`/sessions/${sessionId}/attendance`); }
export async function saveSessionAttendance(rows: Attendance[]): Promise<void> {
  if (rows.some(row => row.attendance_status === 'unmarked')) throw new Error('Choose an attendance status for every student.');
  if (!rows.length) return;
  await api(`/sessions/${rows[0].session_id}/attendance`, { method: 'PUT', body: JSON.stringify({ rows: rows.map(({ student_id, attendance_status, counts_toward_package }) => ({ student_id, attendance_status, counts_toward_package })) }) });
}
export async function getPackagePlans(): Promise<PackagePlan[]> { return api('/package-plans'); }
export async function getStudentPackages(spaceId: string): Promise<StudentPackage[]> { return api(`/spaces/${spaceId}/packages`); }
export async function getPackagePayments(packageIds: string[]): Promise<PackagePayment[]> {
  const rows = await Promise.all(packageIds.map(id => api<PackagePayment[]>(`/student-packages/${id}/payments`)));
  return rows.flat();
}
export async function createPackagePlan(input: { name: string; classCount: number; amount: number; adminId: string }): Promise<void> {
  await api('/admin/package-plans', { method: 'POST', body: JSON.stringify({ name: input.name, classCount: input.classCount, amount: input.amount }) });
}
export async function assignStudentPackage(input: { studentId: string; spaceId: string; planId: string; adminId: string }): Promise<void> {
  await api('/admin/student-packages', { method: 'POST', body: JSON.stringify({ studentId: input.studentId, spaceId: input.spaceId, planId: input.planId }) });
}

function putWithProgress(url: string, file: File, onProgress: (value: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader('etag')) : reject(new Error(`Upload failed (${xhr.status}).`));
    xhr.onerror = () => reject(new Error('Upload connection interrupted. Retry to resume.'));
    xhr.send(file);
  });
}
export async function uploadPaymentReceipt(packageId: string, file: File): Promise<string> {
  const auth = await api<{ key: string; uploadUrl: string }>(`/student-packages/${packageId}/receipt-upload`, { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size }) });
  await putWithProgress(auth.uploadUrl, file, () => undefined);
  return auth.key;
}
export async function deletePaymentReceipt(path: string): Promise<void> {
  const match = path.match(/^receipts\/([^/]+)\//);
  if (!match) throw new Error('Invalid receipt path.');
  await api(`/student-packages/${match[1]}/receipt`, { method: 'DELETE', body: JSON.stringify({ key: path }) });
}
export async function confirmPackagePayment(input: { packageId: string; amount: number; paidAt: string; reference: string; receiptPath: string | null }): Promise<void> {
  await api(`/admin/student-packages/${input.packageId}/confirm-payment`, { method: 'POST', body: JSON.stringify({ amount: input.amount, paidAt: input.paidAt, reference: input.reference.trim(), receiptPath: input.receiptPath }) });
}
export async function getPaymentReceiptUrl(path: string): Promise<string> {
  const result = await api<{ signedUrl: string }>(`/payment-receipts?key=${encodeURIComponent(path)}`);
  return result.signedUrl;
}
export async function openMaterial(lesson: Lesson): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const result = await api<{ signedUrl: string }>(`/lessons/${lesson.id}/file`);
    if (tab) tab.location.href = result.signedUrl;
    else window.location.href = result.signedUrl;
  } catch (error) { tab?.close(); throw error; }
}

type UploadState = { lessonId: string; uploadId: string; key: string };
const identity = (spaceId: string, title: string, file: File) => `lms-upload:${spaceId}:${title}:${file.name}:${file.size}:${file.lastModified}`;
export async function createMaterial(input: {
  spaceId: string; title: string; description: string; kind: 'recording' | 'reading'; file: File; teacherId: string; onProgress: (value: number) => void;
}): Promise<void> {
  const stateKey = identity(input.spaceId, input.title, input.file);
  let state: UploadState | null = null;
  try { state = JSON.parse(localStorage.getItem(stateKey) || 'null') as UploadState | null; } catch { state = null; }
  if (!state) {
    const draft = await api<{ id: string }>(`/spaces/${input.spaceId}/lessons`, { method: 'POST', body: JSON.stringify({ title: input.title.trim(), description: input.description.trim(), kind: input.kind }) });
    const auth = await api<{ key: string; uploadId?: string; uploadUrl?: string; partSize?: number }>(`/lessons/${draft.id}/upload`, { method: 'POST', body: JSON.stringify({ fileName: input.file.name, contentType: input.file.type }) });
    state = { lessonId: draft.id, uploadId: auth.uploadId || '', key: auth.key };
    localStorage.setItem(stateKey, JSON.stringify(state));
    if (auth.uploadUrl) {
      await putWithProgress(auth.uploadUrl!, input.file, input.onProgress);
      await api(`/lessons/${state.lessonId}/publish`, { method: 'POST', body: JSON.stringify({ fileName: input.file.name }) });
      localStorage.removeItem(stateKey);
      return;
    }
  }
  if (!state.uploadId) {
    const upload = await api<{ key: string; uploadUrl: string }>(`/lessons/${state.lessonId}/upload`, { method: 'POST', body: JSON.stringify({ fileName: input.file.name, contentType: input.file.type }) });
    await putWithProgress(upload.uploadUrl, input.file, input.onProgress);
    await api(`/lessons/${state.lessonId}/publish`, { method: 'POST', body: JSON.stringify({ fileName: input.file.name }) });
    localStorage.removeItem(stateKey);
    return;
  }
  if (!state.uploadId) throw new Error('The saved upload state is invalid. Start the upload again.');
  const init = await api<{ partSize: number }>(`/lessons/${state.lessonId}/upload`, { method: 'POST', body: JSON.stringify({ fileName: input.file.name, contentType: input.file.type }) });
  const partsAlready = await api<Array<{ partNumber: number; etag: string }>>(`/lessons/${state.lessonId}/upload/${state.uploadId}/parts`);
  const finished = new Map(partsAlready.map(part => [part.partNumber, part.etag]));
  const count = Math.ceil(input.file.size / init.partSize);
  for (let partNumber = 1; partNumber <= count; partNumber++) {
    if (finished.has(partNumber)) { input.onProgress(Math.round(finished.size / count * 100)); continue; }
    const url = await api<{ url: string }>(`/lessons/${state.lessonId}/upload/${state.uploadId}/part-url`, { method: 'POST', body: JSON.stringify({ partNumber }) });
    const chunk = input.file.slice((partNumber - 1) * init.partSize, Math.min(partNumber * init.partSize, input.file.size));
    const completedBefore = finished.size;
    const etag = await putWithProgress(url.url, new File([chunk], input.file.name, { type: input.file.type }), partProgress => input.onProgress(Math.round((completedBefore + partProgress / 100) / count * 100)));
    if (!etag) throw new Error('Storage did not return a multipart part identifier.');
    finished.set(partNumber, etag);
  }
  await api(`/lessons/${state.lessonId}/upload/${state.uploadId}/complete`, { method: 'POST', body: JSON.stringify({ parts: [...finished].map(([partNumber, etag]) => ({ partNumber, etag })) }) });
  await api(`/lessons/${state.lessonId}/publish`, { method: 'POST', body: JSON.stringify({ fileName: input.file.name }) });
  localStorage.removeItem(stateKey);
  input.onProgress(100);
}
