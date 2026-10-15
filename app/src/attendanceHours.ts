import type { TeacherAttendanceDay } from './types';

const minuteOfDay = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export const slotMinutes = (day: TeacherAttendanceDay) => minuteOfDay(day.ends_at) - minuteOfDay(day.starts_at);
export const hourSegments = (day: TeacherAttendanceDay) => Array.from(
  { length: Math.ceil(slotMinutes(day) / 60) },
  (_, index) => Math.min(60, slotMinutes(day) - index * 60),
);

export function summarizeTeacherDay(days: TeacherAttendanceDay[]) {
  const attended = days.filter(day => day.status === 'attended');
  const attendedSlotMinutes = attended.reduce((total, day) => total + slotMinutes(day), 0);
  const scheduledMinutes = days.reduce((total, day) => total + slotMinutes(day), 0);
  const missedMinutes = days.filter(day => day.status === 'missed').reduce((total, day) => total + slotMinutes(day), 0);
  const intervals = attended.map(day => [minuteOfDay(day.starts_at), minuteOfDay(day.ends_at)] as const)
    .sort((a, b) => a[0] - b[0]);
  let creditedMinutes = 0;
  let coveredUntil = 0;
  for (const [start, end] of intervals) {
    creditedMinutes += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return {
    attendedSpaces: attended.length,
    scheduledMinutes,
    missedMinutes,
    creditedMinutes,
    overlapMinutes: attendedSlotMinutes - creditedMinutes,
  };
}

export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours && remainder ? `${hours}h ${remainder}m` : hours ? `${hours}h` : `${remainder}m`;
}
