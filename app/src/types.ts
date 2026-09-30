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
