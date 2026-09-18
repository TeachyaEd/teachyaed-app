/**
 * iCal (.ics) export — byte-for-byte parity port of legacy's
 * `exportICal`/`_icalEsc`. See docs/SCHEDULE_MIGRATION.md's
 * "exportICal" section for the exact spec this implements,
 * including the deliberately-preserved floating-local-time ambiguity
 * (no `Z`/`TZID` on DTSTART/DTEND) — that is NOT a bug to fix here.
 *
 * `buildICalendar` is pure (no DOM/Blob access) specifically so it
 * can be unit-tested directly. `downloadICalendar` is the thin,
 * browser-only side-effecting wrapper.
 */

import type { ScheduleEvent } from '../types';
import { normalizeDuration } from './validation';

const ICS_FILENAME = 'teachyaed-schedule.ics';
const ICS_MIME_TYPE = 'text/calendar;charset=utf-8';

/**
 * RFC 5545 TEXT escaping, in this EXACT order (backslash first, so
 * the backslashes introduced by the later replacements are not
 * themselves re-escaped) — mirrors legacy's `_icalEsc` precisely.
 */
export function icalEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Floating local time, 'YYYYMMDDTHHMMSS' — deliberately no trailing
 * 'Z' and no TZID, reading the Date's own local getters (mirrors
 * legacy's construction via `new Date(event_date + 'T' + time +
 * ':00')`, which is itself parsed as local time with no timezone).
 */
function formatFloatingLocal(d: Date): string {
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

/**
 * Builds the full .ics file content for the given events. Events
 * with a falsy `event_date`, or whose constructed start Date is
 * invalid, are silently skipped — exactly as legacy does (not an
 * error condition). No status-based filtering: scheduled, completed,
 * and cancelled events are all included; only `STATUS:` differs
 * (CANCELLED vs CONFIRMED — no TENTATIVE or other mapping exists).
 */
export function buildICalendar(events: readonly ScheduleEvent[], schoolId: string | null): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//TeachyaED//TeachyaED//EN',
    `X-WR-CALNAME:${icalEscape('TeachyaED')}`,
    'METHOD:PUBLISH',
  ];

  for (const event of events) {
    if (!event.event_date) continue;

    const time = (event.event_time && event.event_time.length > 0 ? event.event_time : '09:00').slice(0, 5);
    const start = new Date(`${event.event_date}T${time}:00`);
    if (Number.isNaN(start.getTime())) continue;

    const durationMinutes = normalizeDuration(event.duration_minutes);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    const status = event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED';
    const uid = `${event.id}@${schoolId || 'school'}.teachyaed`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART:${formatFloatingLocal(start)}`,
      `DTEND:${formatFloatingLocal(end)}`,
      `SUMMARY:${icalEscape(event.title)}`,
      `DESCRIPTION:${icalEscape(event.notes || '')}`,
      `STATUS:${status}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  // CRLF line joins per RFC 5545, trailing CRLF at end of file — mirrors legacy exactly.
  return lines.join('\r\n') + '\r\n';
}

/**
 * Browser-only download trigger (Blob + object URL + synthetic
 * `<a download>` click). The exact delivery mechanism is not asserted
 * to match legacy byte-for-byte per docs/SCHEDULE_MIGRATION.md — only
 * the resulting file content (`buildICalendar`'s output) must match.
 */
export function downloadICalendar(events: readonly ScheduleEvent[], schoolId: string | null): void {
  const content = buildICalendar(events, schoolId);
  const blob = new Blob([content], { type: ICS_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = ICS_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
