import { describe, expect, it } from 'vitest';
import {
  isValidStatus,
  normalizeDuration,
  normalizeEventTime,
  normalizeStatus,
  validateScheduleForm,
} from '@/features/schedule/api/validation';

describe('normalizeStatus', () => {
  it('passes through valid statuses unchanged', () => {
    expect(normalizeStatus('scheduled')).toBe('scheduled');
    expect(normalizeStatus('completed')).toBe('completed');
    expect(normalizeStatus('cancelled')).toBe('cancelled');
  });

  it('falls back to scheduled for anything else, mirroring legacy saveEvent', () => {
    expect(normalizeStatus('bogus')).toBe('scheduled');
    expect(normalizeStatus(undefined)).toBe('scheduled');
    expect(normalizeStatus(null)).toBe('scheduled');
    expect(normalizeStatus('')).toBe('scheduled');
  });
});

describe('isValidStatus', () => {
  it('narrows correctly', () => {
    expect(isValidStatus('scheduled')).toBe(true);
    expect(isValidStatus('nope')).toBe(false);
  });
});

describe('normalizeDuration', () => {
  it('parses valid positive numbers/numeric strings', () => {
    expect(normalizeDuration(45)).toBe(45);
    expect(normalizeDuration('45')).toBe(45);
  });

  it('falls back to 60 for missing/unparseable/<= 0, mirroring legacy saveEvent and exportICal', () => {
    expect(normalizeDuration(undefined)).toBe(60);
    expect(normalizeDuration(null)).toBe(60);
    expect(normalizeDuration('')).toBe(60);
    expect(normalizeDuration('not-a-number')).toBe(60);
    expect(normalizeDuration(0)).toBe(60);
    expect(normalizeDuration(-5)).toBe(60);
  });

  it('truncates fractional input', () => {
    expect(normalizeDuration(45.9)).toBe(45);
  });
});

describe('normalizeEventTime', () => {
  it('defaults to 09:00 when missing', () => {
    expect(normalizeEventTime(undefined)).toBe('09:00');
    expect(normalizeEventTime(null)).toBe('09:00');
    expect(normalizeEventTime('')).toBe('09:00');
  });

  it('truncates to HH:MM', () => {
    expect(normalizeEventTime('14:30:00')).toBe('14:30');
    expect(normalizeEventTime('14:30')).toBe('14:30');
  });
});

describe('validateScheduleForm', () => {
  const valid = { title: 'Lesson', event_date: '2026-09-20', event_time: '10:00' };

  it('returns null for a fully valid form', () => {
    expect(validateScheduleForm(valid)).toBeNull();
  });

  it('requires a non-empty (trimmed) title', () => {
    expect(validateScheduleForm({ ...valid, title: '' })?.field).toBe('title');
    expect(validateScheduleForm({ ...valid, title: '   ' })?.field).toBe('title');
  });

  it('requires a date', () => {
    expect(validateScheduleForm({ ...valid, event_date: '' })?.field).toBe('event_date');
  });

  it('requires a time', () => {
    expect(validateScheduleForm({ ...valid, event_time: '' })?.field).toBe('event_time');
  });
});
