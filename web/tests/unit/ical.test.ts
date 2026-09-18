import { describe, expect, it } from 'vitest';
import { buildICalendar, icalEscape } from '@/features/schedule/api/ical';
import type { ScheduleEvent } from '@/features/schedule/types';

function baseEvent(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'event-1',
    school_id: 'school-1',
    class_id: null,
    teacher_id: 'teacher-1',
    title: 'Lesson',
    event_date: '2026-09-20',
    event_time: '10:00',
    duration_minutes: 45,
    status: 'scheduled',
    notes: null,
    ...overrides,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function expectedFloatingLocal(d: Date): string {
  return (
    String(d.getFullYear()) +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    'T' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

describe('icalEscape', () => {
  it('escapes backslash, semicolon, comma, and newline in that exact order', () => {
    // A literal backslash introduced by escaping ';' must NOT itself be
    // re-escaped by the later replacements — this exercises exactly
    // that ordering requirement (backslash first).
    expect(icalEscape('a;b')).toBe('a\\;b');
    expect(icalEscape('a,b')).toBe('a\\,b');
    expect(icalEscape('a\nb')).toBe('a\\nb');
    expect(icalEscape('a\\b')).toBe('a\\\\b');
    expect(icalEscape('a\\;b')).toBe('a\\\\\\;b');
  });

  it('leaves plain text untouched', () => {
    expect(icalEscape('Plain title')).toBe('Plain title');
  });
});

describe('buildICalendar', () => {
  it('produces the fixed VCALENDAR header/footer with CRLF line joins and a trailing CRLF', () => {
    const ics = buildICalendar([], 'school-1');
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[1]).toBe('VERSION:2.0');
    expect(lines[2]).toBe('CALSCALE:GREGORIAN');
    expect(lines[3]).toBe('PRODID:-//TeachyaED//TeachyaED//EN');
    expect(lines[4]).toBe('X-WR-CALNAME:TeachyaED');
    expect(lines[5]).toBe('METHOD:PUBLISH');
    expect(lines[lines.length - 2]).toBe('END:VCALENDAR');
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('skips events with a falsy event_date without throwing', () => {
    const ics = buildICalendar([baseEvent({ event_date: '' })], 'school-1');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('skips events whose constructed start date is invalid', () => {
    const ics = buildICalendar([baseEvent({ event_date: 'not-a-date' })], 'school-1');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('maps cancelled to STATUS:CANCELLED and every other status to STATUS:CONFIRMED', () => {
    const cancelled = buildICalendar([baseEvent({ status: 'cancelled' })], 'school-1');
    expect(cancelled).toContain('STATUS:CANCELLED');

    const scheduled = buildICalendar([baseEvent({ status: 'scheduled' })], 'school-1');
    expect(scheduled).toContain('STATUS:CONFIRMED');

    const completed = buildICalendar([baseEvent({ status: 'completed' })], 'school-1');
    expect(completed).toContain('STATUS:CONFIRMED');
  });

  it('formats UID as "<id>@<schoolId>.teachyaed", falling back to "school" when schoolId is null', () => {
    const withSchool = buildICalendar([baseEvent({ id: 'abc' })], 'school-xyz');
    expect(withSchool).toContain('UID:abc@school-xyz.teachyaed');

    const withoutSchool = buildICalendar([baseEvent({ id: 'abc' })], null);
    expect(withoutSchool).toContain('UID:abc@school.teachyaed');
  });

  it('writes DTSTART/DTEND as floating local time with no Z suffix and no TZID', () => {
    const event = baseEvent({ event_date: '2026-09-20', event_time: '10:00', duration_minutes: 30 });
    const ics = buildICalendar([event], 'school-1');

    const start = new Date('2026-09-20T10:00:00');
    const end = new Date(start.getTime() + 30 * 60000);

    expect(ics).toContain(`DTSTART:${expectedFloatingLocal(start)}`);
    expect(ics).toContain(`DTEND:${expectedFloatingLocal(end)}`);
    expect(ics).not.toMatch(/DTSTART:[^\r\n]*Z/);
    expect(ics).not.toContain('TZID');
  });

  it('defaults duration to 60 minutes when duration_minutes is missing/invalid/<= 0', () => {
    const event = baseEvent({ event_date: '2026-09-20', event_time: '10:00', duration_minutes: 0 });
    const ics = buildICalendar([event], 'school-1');

    const start = new Date('2026-09-20T10:00:00');
    const end = new Date(start.getTime() + 60 * 60000);

    expect(ics).toContain(`DTEND:${expectedFloatingLocal(end)}`);
  });

  it('escapes SUMMARY and DESCRIPTION and defaults DESCRIPTION to empty when notes is null', () => {
    const event = baseEvent({ title: 'A; B, C\nD', notes: null });
    const ics = buildICalendar([event], 'school-1');

    expect(ics).toContain('SUMMARY:A\\; B\\, C\\nD');
    expect(ics).toContain('DESCRIPTION:');
  });

  it('includes no status-based filtering: scheduled, completed, and cancelled events all appear', () => {
    const events = [
      baseEvent({ id: 'e1', status: 'scheduled' }),
      baseEvent({ id: 'e2', status: 'completed' }),
      baseEvent({ id: 'e3', status: 'cancelled' }),
    ];
    const ics = buildICalendar(events, 'school-1');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3);
  });
});
