/**
 * Schedule domain service — all Supabase calls for this feature live
 * here (per web/src/features/schedule/README.md's convention). No
 * component or hook in this feature should import `@/services/supabase/client`
 * directly.
 *
 * Authorization note (read this before touching any query filter
 * below): every role-based filter in this file is a UX/early-exit
 * convenience mirroring legacy's own client-side query shape — see
 * docs/SCHEDULE_MIGRATION.md's "CURRENT LEGACY BEHAVIOR" and
 * "exportICal" sections. It is NOT the security boundary. The actual
 * boundary is the 8 explicit `schedule_*` RLS policies applied in
 * the 2026-09-18 authorization hotfix (docs/SCHEDULE_MIGRATION.md
 * "HOTFIX: Schedule Authorization Correction", SECURITY_BASELINE.md
 * §30). Removing or loosening a filter here changes what the UI
 * *requests*, not what the database *permits* — but it can still
 * produce a confusing or wasteful over-fetch, so keep these filters
 * in sync with the RLS model rather than relying on RLS alone to
 * "clean up" an unscoped query.
 *
 * Per that same hotfix, `teacher_id` on INSERT is always the
 * caller's own id (`profile.id`) — there is no teacher-picker in
 * legacy and none is added here. UPDATE never sends `teacher_id` in
 * its payload at all, for any role, matching legacy's "admin/owner
 * edit doesn't reassign ownership" behavior and the DB's own
 * `WITH CHECK` on `schedule_update_teacher`.
 */

import { supabase } from '@/services/supabase/client';
import { AppError, toAppError } from '@/lib/errors';
import { observability } from '@/lib/observability';
import type { Profile } from '@/features/auth/types';
import type {
  ScheduleClassOption,
  ScheduleEmptyReason,
  ScheduleEvent,
  ScheduleEventFormValues,
} from '../types';
import { normalizeDuration, normalizeEventTime, normalizeStatus, validateScheduleForm } from './validation';

export { buildICalendar, downloadICalendar, icalEscape } from './ical';

const SCHEDULE_EVENT_SELECT = '*, class:class_id(name,color)';

/** Mirrors legacy's defensive re-check in saveEvent/deleteEvent: only these roles may write. */
export function canManageSchedule(role: string | null | undefined): boolean {
  return role === 'teacher' || role === 'admin' || role === 'owner';
}

function assertCanManage(profile: Profile): void {
  if (!canManageSchedule(profile.role)) {
    throw new AppError('forbidden', 'You do not have permission to manage the schedule.');
  }
}

function assertSchoolContext(profile: Profile): asserts profile is Profile & { school_id: string } {
  if (!profile.school_id) {
    throw new AppError('validation', 'Your account is missing a school context.');
  }
}

/**
 * Resolves the caller's own enrolled class ids for the student read
 * scope, via the same students<->profiles email linkage already
 * proven correct on homeworks/lesson_assignments (see
 * docs/SCHEDULE_MIGRATION.md "HOTFIX" section and
 * SECURITY_BASELINE.md §30). Never accepts or trusts a
 * client-supplied student id — resolution starts from the caller's
 * own authenticated email only.
 *
 * Returns `null` if the caller has no linked `students` row at all
 * (distinct from an empty array, which means "has a student row but
 * zero enrollments") — this distinction drives the two different
 * empty states documented in docs/SCHEDULE_MIGRATION.md.
 */
async function fetchOwnEnrolledClassIds(schoolId: string): Promise<string[] | null> {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr) {
    observability.captureSupabaseRequestFailure({ message: 'auth.getUser failed', context: { code: userErr.name } });
    throw toAppError(userErr);
  }
  const authEmail = userData.user?.email;
  if (!authEmail) return null;

  const { data: studentRow, error: studentErr } = await supabase
    .from('students')
    .select('id')
    .ilike('email', authEmail)
    .maybeSingle();

  if (studentErr) {
    observability.captureSupabaseRequestFailure({
      message: 'students lookup failed',
      context: { code: studentErr.code ?? null },
    });
    throw toAppError(studentErr);
  }

  const studentId = (studentRow as { id: string } | null)?.id;
  if (!studentId) return null;

  const { data: enrollments, error: enrollErr } = await supabase
    .from('class_students')
    .select('class_id')
    .eq('school_id', schoolId)
    .eq('student_id', studentId);

  if (enrollErr) {
    observability.captureSupabaseRequestFailure({
      message: 'class_students lookup failed',
      context: { code: enrollErr.code ?? null },
    });
    throw toAppError(enrollErr);
  }

  return ((enrollments ?? []) as Array<{ class_id: string }>).map((row) => row.class_id);
}

export interface ListScheduleEventsResult {
  events: ScheduleEvent[];
  emptyReason: ScheduleEmptyReason;
}

/**
 * Loads the events the caller's role is scoped to see. See the
 * module-level authorization note above — this mirrors legacy's
 * query shape for UX/parity; RLS is the real boundary regardless of
 * what filter is or isn't applied here.
 */
export async function listScheduleEvents(profile: Profile): Promise<ListScheduleEventsResult> {
  if (!profile.school_id) {
    return { events: [], emptyReason: null };
  }

  if (profile.role === 'student') {
    const classIds = await fetchOwnEnrolledClassIds(profile.school_id);
    if (classIds === null) {
      return { events: [], emptyReason: 'no_student_row' };
    }
    if (classIds.length === 0) {
      return { events: [], emptyReason: 'no_enrolled_classes' };
    }
    const { data, error } = await supabase
      .from('schedule_events')
      .select(SCHEDULE_EVENT_SELECT)
      .eq('school_id', profile.school_id)
      .in('class_id', classIds)
      .order('event_date', { ascending: true })
      .order('event_time', { ascending: true });

    if (error) {
      observability.captureSupabaseRequestFailure({
        message: 'schedule_events select (student) failed',
        context: { code: error.code ?? null },
      });
      throw toAppError(error);
    }
    return { events: (data ?? []) as unknown as ScheduleEvent[], emptyReason: null };
  }

  let query = supabase
    .from('schedule_events')
    .select(SCHEDULE_EVENT_SELECT)
    .eq('school_id', profile.school_id);

  if (profile.role === 'teacher') {
    query = query.eq('teacher_id', profile.id);
  }
  // admin/owner: no additional filter — school-wide, matching RLS.

  const { data, error } = await query
    .order('event_date', { ascending: true })
    .order('event_time', { ascending: true });

  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'schedule_events select failed',
      context: { code: error.code ?? null },
    });
    throw toAppError(error);
  }
  return { events: (data ?? []) as unknown as ScheduleEvent[], emptyReason: null };
}

/** Light class list for the create/edit form's class dropdown and display legend. */
export async function listScheduleClasses(schoolId: string): Promise<ScheduleClassOption[]> {
  const { data, error } = await supabase
    .from('classes')
    .select('id, name, color')
    .eq('school_id', schoolId)
    .order('name', { ascending: true });

  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'classes select failed',
      context: { code: error.code ?? null },
    });
    throw toAppError(error);
  }
  return (data ?? []) as unknown as ScheduleClassOption[];
}

function buildWritePayload(values: ScheduleEventFormValues) {
  return {
    class_id: values.class_id || null,
    title: values.title.trim(),
    event_date: values.event_date,
    event_time: normalizeEventTime(values.event_time),
    duration_minutes: normalizeDuration(values.duration_minutes),
    status: normalizeStatus(values.status),
    notes: values.notes.trim() ? values.notes.trim() : null,
  };
}

/**
 * Creates a new event. `teacher_id` is always `profile.id` — the
 * caller's own id — for every role, including admin/owner: there is
 * no teacher-picker in legacy and none is added here (see
 * docs/SCHEDULE_MIGRATION.md "Correction to the previous pass").
 */
export async function createScheduleEvent(
  profile: Profile,
  values: ScheduleEventFormValues
): Promise<ScheduleEvent> {
  assertCanManage(profile);
  assertSchoolContext(profile);

  const validationError = validateScheduleForm(values);
  if (validationError) {
    throw new AppError('validation', validationError.message);
  }

  const payload = {
    ...buildWritePayload(values),
    school_id: profile.school_id,
    teacher_id: profile.id,
  };

  const { data, error } = await supabase
    .from('schedule_events')
    .insert(payload)
    .select(SCHEDULE_EVENT_SELECT)
    .single();

  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'schedule_events insert failed',
      context: { code: error.code ?? null },
    });
    throw toAppError(error);
  }
  return data as unknown as ScheduleEvent;
}

/**
 * Updates an existing event. Never sends `teacher_id` in the update
 * payload, for any role — mirrors legacy's "strip teacher_id from
 * the update payload" behavior exactly, and matches the DB's own
 * `WITH CHECK` on `schedule_update_teacher`, which requires it to
 * stay equal to `auth.uid()` regardless. A plain teacher's update is
 * additionally scoped to their own `teacher_id` client-side, mirroring
 * legacy; RLS enforces the same boundary independently.
 */
export async function updateScheduleEvent(
  profile: Profile,
  eventId: string,
  values: ScheduleEventFormValues
): Promise<ScheduleEvent> {
  assertCanManage(profile);
  assertSchoolContext(profile);

  const validationError = validateScheduleForm(values);
  if (validationError) {
    throw new AppError('validation', validationError.message);
  }

  let query = supabase
    .from('schedule_events')
    .update(buildWritePayload(values))
    .eq('id', eventId)
    .eq('school_id', profile.school_id);

  if (profile.role === 'teacher') {
    query = query.eq('teacher_id', profile.id);
  }

  const { data, error } = await query.select(SCHEDULE_EVENT_SELECT).maybeSingle();

  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'schedule_events update failed',
      context: { code: error.code ?? null },
    });
    throw toAppError(error);
  }
  if (!data) {
    // Zero rows affected — mirrors legacy's row-count check: surfaced
    // as a forbidden-style message, not a silent success. This is a
    // client-side signal only; schedule_update_teacher/admin_owner
    // RLS is the real boundary (docs/SCHEDULE_MIGRATION.md "HOTFIX").
    throw new AppError('forbidden', 'You do not have permission to edit this event.');
  }
  return data as unknown as ScheduleEvent;
}

/**
 * Deletes an event. A plain teacher's delete is additionally scoped
 * to their own `teacher_id` client-side, mirroring legacy; RLS
 * enforces the same boundary independently.
 */
export async function deleteScheduleEvent(profile: Profile, eventId: string): Promise<void> {
  assertCanManage(profile);
  assertSchoolContext(profile);

  let query = supabase
    .from('schedule_events')
    .delete()
    .eq('id', eventId)
    .eq('school_id', profile.school_id);

  if (profile.role === 'teacher') {
    query = query.eq('teacher_id', profile.id);
  }

  const { data, error } = await query.select('id');

  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'schedule_events delete failed',
      context: { code: error.code ?? null },
    });
    throw toAppError(error);
  }
  if (!data || data.length === 0) {
    // Same "zero rows affected -> forbidden" signal as legacy's
    // deleteEvent row-count check — see updateScheduleEvent above.
    throw new AppError('forbidden', 'You do not have permission to delete this event.');
  }
}
