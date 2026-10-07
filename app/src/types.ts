export type Role = 'student' | 'teacher' | 'admin';
export type Profile = { id: string; display_name: string; role: Role };
export type CourseSpace = { id: string; courseTitle: string; cohortName: string };
export type AdminDirectory = {
  profiles: Profile[];
  cohorts: Array<{ id: string; name: string }>;
  courses: Array<{ id: string; title: string }>;
};
export type Lesson = {
  id: string;
  cohort_course_id: string;
  title: string;
  description: string | null;
  kind: 'recording' | 'reading';
  storage_path: string | null;
  original_name: string | null;
  status: 'draft' | 'published';
  created_at: string;
};
export type Completion = { lesson_id: string; student_id: string; completed_at: string };
export type ClassSession = {
  id: string; cohort_course_id: string; title: string; starts_at: string; ends_at: string | null;
  meeting_url: string; created_by: string;
};
export type Attendance = {
  id?: string; session_id: string; student_id: string; attendance_status: 'attended' | 'missed' | 'cancelled' | 'unmarked';
  counts_toward_package: boolean; marked_by: string; marked_at?: string;
};
export type PackagePlan = { id: string; name: string; class_count: number; amount: number; active: boolean };
export type StudentPackage = {
  id: string; student_id: string; cohort_course_id: string; plan_id: string; sessions_attended: number;
  status: 'active' | 'payment_due' | 'locked_future';
  package_plans: PackagePlan; profiles?: { display_name: string };
};
export type PackagePayment = { id: string; student_package_id: string; amount: number; paid_at: string; reference: string | null; receipt_path: string | null; confirmed_at: string };
