/**
 * Pure normalization helpers shared by scheduleService (writes) and
 * ical (export). Kept dependency-free and side-effect-free so they
 * are trivially unit-testable without mocking Supabase.
 *
 * Every fallback here is a deliberate parity port from legacy's
 * `saveEvent`/`exportICal`, not a new business rule — see
 * docs/SCHEDULE_MIGRATION.md "VALIDATION" and "exportICal" sections.
 * Do not "improve" a fallback (e.g. rejecting duration <= 0 instead
 * of defaulting to 60) without updating that doc first — legacy and
 * React must produce identical stored/exported data for identical
 * input.
 */

import type { ScheduleStatus } from '../types';

const VALID_STATUSES: readonly ScheduleStatus[] = ['scheduled', 'completed', 'cancelled'];

export function isValidStatus(value: string): value is ScheduleStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

/** Falls back to 'scheduled' for anything else — mirrors legacy's saveEvent fallback exactly. */
export function normalizeStatus(raw: unknown): ScheduleStatus {
  const s = String(raw ?? '');
  return isValidStatus(s) ? s : 'scheduled';
}

/** Falls back to 60 if missing/unparseable/<= 0 — mirrors legacy's saveEvent AND exportICal fallback exactly. */
export function normalizeDuration(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.trunc(n);
}

/** Defaults to '09:00' if missing, then truncates to 'HH:MM' — mirrors legacy exactly. */
export function normalizeEventTime(raw: string | null | undefined): string {
  const value = raw && raw.length > 0 ? raw : '09:00';
  return value.slice(0, 5);
}

export interface ScheduleFormValidationError {
  field: 'title' | 'event_date' | 'event_time';
  message: string;
}

/**
 * Required-field checks mirroring legacy's client-side saveEvent
 * validation (title/date/time non-empty). Returns the first error
 * found, or null if the form is valid enough to submit. This is a
 * UX convenience, not the authorization boundary — RLS/DB
 * constraints are what actually protect the data either way.
 */
export function validateScheduleForm(values: {
  title: string;
  event_date: string;
  event_time: string;
}): ScheduleFormValidationError | null {
  if (!values.title.trim()) {
    return { field: 'title', message: 'Title is required.' };
  }
  if (!values.event_date) {
    return { field: 'event_date', message: 'Date is required.' };
  }
  if (!values.event_time) {
    return { field: 'event_time', message: 'Time is required.' };
  }
  return null;
}
