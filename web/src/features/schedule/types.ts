/**
 * Schedule feature local types.
 *
 * Deliberately local to this feature (not the placeholder global
 * `Database` type — see src/types/database.ts's header) per the
 * domain-service convention in this folder's README.md. Column
 * names/shape here are not invented: they mirror exactly what
 * docs/SCHEDULE_MIGRATION.md's "TABLES" section documents from the
 * legacy source, re-verified against the live `schedule_events` RLS
 * policies applied in the 2026-09-18 authorization hotfix (see that
 * doc's "HOTFIX" section) — `class_id`, `teacher_id`, `school_id`
 * are exactly the columns every schedule_* RLS policy keys off.
 */

export type ScheduleStatus = 'scheduled' | 'completed' | 'cancelled';

export interface ScheduleClassOption {
  id: string;
  name: string;
  color: string | null;
}

export interface ScheduleEvent {
  id: string;
  school_id: string;
  class_id: string | null;
  teacher_id: string;
  title: string;
  event_date: string; // 'YYYY-MM-DD'
  event_time: string; // 'HH:MM'
  duration_minutes: number;
  status: ScheduleStatus;
  notes: string | null;
  /** Joined read-only via `class:class_id(name,color)` — see scheduleService. */
  class?: { name: string; color: string | null } | null;
}

/** Shape submitted by the create/edit form. Validated/normalized in api/validation.ts. */
export interface ScheduleEventFormValues {
  title: string;
  class_id: string | null;
  event_date: string;
  event_time: string;
  duration_minutes: number;
  status: ScheduleStatus;
  notes: string;
}

export const EMPTY_SCHEDULE_FORM_VALUES: ScheduleEventFormValues = {
  title: '',
  class_id: null,
  event_date: '',
  event_time: '09:00',
  duration_minutes: 60,
  status: 'scheduled',
  notes: '',
};

/**
 * Why the event list came back empty, when it's a student — mirrors
 * the two distinct legacy empty states (docs/SCHEDULE_MIGRATION.md
 * "EMPTY STATES"): no linked student row at all, vs. a linked
 * student row with zero class enrollments. `null` means "not empty"
 * or "not applicable" (non-student roles never set this).
 */
export type ScheduleEmptyReason = 'no_student_row' | 'no_enrolled_classes' | null;
