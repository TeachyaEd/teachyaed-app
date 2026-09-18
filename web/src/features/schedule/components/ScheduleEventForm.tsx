import { useState } from 'react';
import type { FormEvent } from 'react';
import { EMPTY_SCHEDULE_FORM_VALUES } from '../types';
import type { ScheduleClassOption, ScheduleEventFormValues, ScheduleStatus } from '../types';

const STATUS_OPTIONS: readonly ScheduleStatus[] = ['scheduled', 'completed', 'cancelled'];

interface ScheduleEventFormProps {
  initialValues?: ScheduleEventFormValues;
  classes: ScheduleClassOption[];
  submitting: boolean;
  submitLabel: string;
  onSubmit: (values: ScheduleEventFormValues) => void;
  onCancel: () => void;
}

/**
 * Create/edit form for a single schedule event. Purely presentational
 * + local form state — all Supabase interaction happens in
 * useSchedule/scheduleService, not here. Client-side validation here
 * (see api/validation.ts's validateScheduleForm) is a UX convenience;
 * it is not the authorization or data-integrity boundary.
 */
export function ScheduleEventForm({
  initialValues,
  classes,
  submitting,
  submitLabel,
  onSubmit,
  onCancel,
}: ScheduleEventFormProps) {
  const [values, setValues] = useState<ScheduleEventFormValues>(initialValues ?? EMPTY_SCHEDULE_FORM_VALUES);
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!values.title.trim()) {
      setFormError('Title is required.');
      return;
    }
    if (!values.event_date) {
      setFormError('Date is required.');
      return;
    }
    if (!values.event_time) {
      setFormError('Time is required.');
      return;
    }
    setFormError(null);
    onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 420 }}>
      {formError && (
        <div role="alert" style={{ color: '#b00020' }}>
          {formError}
        </div>
      )}

      <label>
        Title
        <input
          type="text"
          value={values.title}
          onChange={(e) => setValues((prev) => ({ ...prev, title: e.target.value }))}
          disabled={submitting}
        />
      </label>

      <label>
        Class
        <select
          value={values.class_id ?? ''}
          onChange={(e) => setValues((prev) => ({ ...prev, class_id: e.target.value || null }))}
          disabled={submitting}
        >
          <option value="">(no class)</option>
          {classes.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>

      <label>
        Date
        <input
          type="date"
          value={values.event_date}
          onChange={(e) => setValues((prev) => ({ ...prev, event_date: e.target.value }))}
          disabled={submitting}
        />
      </label>

      <label>
        Time
        <input
          type="time"
          value={values.event_time}
          onChange={(e) => setValues((prev) => ({ ...prev, event_time: e.target.value }))}
          disabled={submitting}
        />
      </label>

      <label>
        Duration (minutes)
        <input
          type="number"
          min={1}
          value={values.duration_minutes}
          onChange={(e) =>
            setValues((prev) => ({ ...prev, duration_minutes: Number(e.target.value) || 60 }))
          }
          disabled={submitting}
        />
      </label>

      <label>
        Status
        <select
          value={values.status}
          onChange={(e) => setValues((prev) => ({ ...prev, status: e.target.value as ScheduleStatus }))}
          disabled={submitting}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label>
        Notes
        <textarea
          value={values.notes}
          onChange={(e) => setValues((prev) => ({ ...prev, notes: e.target.value }))}
          disabled={submitting}
        />
      </label>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
