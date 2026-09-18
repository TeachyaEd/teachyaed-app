import type { ScheduleEvent } from '../types';

interface ScheduleEventListProps {
  events: ScheduleEvent[];
  canManage: boolean;
  onEdit: (event: ScheduleEvent) => void;
  onDelete: (event: ScheduleEvent) => void;
}

/** Purely presentational — no Supabase access, no hooks beyond props. */
export function ScheduleEventList({ events, canManage, onEdit, onDelete }: ScheduleEventListProps) {
  if (events.length === 0) {
    return <p>No schedule events.</p>;
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Date</th>
          <th style={{ textAlign: 'left' }}>Time</th>
          <th style={{ textAlign: 'left' }}>Title</th>
          <th style={{ textAlign: 'left' }}>Class</th>
          <th style={{ textAlign: 'left' }}>Status</th>
          {canManage && <th />}
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id} data-testid="schedule-event-row">
            <td>{event.event_date}</td>
            <td>{event.event_time}</td>
            <td>{event.title}</td>
            <td>{event.class?.name ?? '—'}</td>
            <td>{event.status}</td>
            {canManage && (
              <td>
                <button type="button" onClick={() => onEdit(event)}>
                  Edit
                </button>
                <button type="button" onClick={() => onDelete(event)}>
                  Delete
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
