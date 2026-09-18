import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { toAppError } from '@/lib/errors';
import { useSchedule } from '../hooks/useSchedule';
import { EMPTY_SCHEDULE_FORM_VALUES } from '../types';
import type { ScheduleEvent, ScheduleEventFormValues } from '../types';
import { ScheduleEventForm } from './ScheduleEventForm';
import { ScheduleEventList } from './ScheduleEventList';

type ModalState = { mode: 'create' } | { mode: 'edit'; event: ScheduleEvent } | null;

function toFormValues(event: ScheduleEvent): ScheduleEventFormValues {
  return {
    title: event.title,
    class_id: event.class_id,
    event_date: event.event_date,
    event_time: event.event_time,
    duration_minutes: event.duration_minutes,
    status: event.status,
    notes: event.notes ?? '',
  };
}

/**
 * Schedule feature's top-level page. Role parity with legacy
 * (docs/SCHEDULE_MIGRATION.md "ROLE BEHAVIOR"): a student sees a
 * read-only list scoped to their enrolled classes (or one of the two
 * documented empty states) and never sees create/edit/delete
 * controls; teacher/admin/owner see the full CRUD surface, scoped by
 * `useSchedule().canManage` and, for writes, by the RLS boundary
 * (not by this component).
 */
export function SchedulePage() {
  const schedule = useSchedule();
  const [modal, setModal] = useState<ModalState>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (schedule.status === 'loading') {
    return <LoadingSpinner label="Loading schedule…" />;
  }

  if (schedule.status === 'error') {
    return (
      <div role="alert">
        <p>{schedule.error ?? 'Something went wrong loading the schedule.'}</p>
        <button type="button" onClick={() => void schedule.refresh()}>
          Retry
        </button>
      </div>
    );
  }

  if (schedule.emptyReason === 'no_student_row') {
    return <p>Student profile not found.</p>;
  }

  async function handleCreate(values: ScheduleEventFormValues) {
    setActionError(null);
    try {
      await schedule.createEvent(values);
      setModal(null);
    } catch (err) {
      setActionError(toAppError(err).userMessage);
    }
  }

  async function handleUpdate(eventId: string, values: ScheduleEventFormValues) {
    setActionError(null);
    try {
      await schedule.updateEvent(eventId, values);
      setModal(null);
    } catch (err) {
      setActionError(toAppError(err).userMessage);
    }
  }

  async function handleDelete(event: ScheduleEvent) {
    if (!window.confirm(`Delete "${event.title}"?`)) return;
    setActionError(null);
    try {
      await schedule.deleteEvent(event.id);
    } catch (err) {
      setActionError(toAppError(err).userMessage);
    }
  }

  return (
    <section>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Schedule</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" onClick={() => schedule.exportICal()}>
            Export .ics
          </button>
          {schedule.canManage && (
            <button type="button" onClick={() => setModal({ mode: 'create' })}>
              New event
            </button>
          )}
        </div>
      </header>

      {actionError && <div role="alert">{actionError}</div>}

      {schedule.emptyReason === 'no_enrolled_classes' ? (
        <p>You are not enrolled in any classes yet.</p>
      ) : (
        <ScheduleEventList
          events={schedule.events}
          canManage={schedule.canManage}
          onEdit={(event) => setModal({ mode: 'edit', event })}
          onDelete={(event) => void handleDelete(event)}
        />
      )}

      {modal?.mode === 'create' && (
        <ScheduleEventForm
          initialValues={EMPTY_SCHEDULE_FORM_VALUES}
          classes={schedule.classes}
          submitting={schedule.mutating}
          submitLabel="Create"
          onSubmit={(values) => void handleCreate(values)}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.mode === 'edit' && (
        <ScheduleEventForm
          initialValues={toFormValues(modal.event)}
          classes={schedule.classes}
          submitting={schedule.mutating}
          submitLabel="Save"
          onSubmit={(values) => void handleUpdate(modal.event.id, values)}
          onCancel={() => setModal(null)}
        />
      )}
    </section>
  );
}
