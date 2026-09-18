import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthContext } from '@/features/auth/AuthContext';
import type { AuthContextValue } from '@/features/auth/AuthContext';
import type { Profile } from '@/features/auth/types';
import { SchedulePage } from '@/features/schedule/components/SchedulePage';
import * as scheduleService from '@/features/schedule/api/scheduleService';
import type { ScheduleEvent } from '@/features/schedule/types';

// Mocking the schedule domain service (not the Supabase client itself)
// is the same documented boundary used by AuthProvider.test.tsx. This
// proves useSchedule/SchedulePage's own state machine, role-parity
// rendering, and error handling; it does NOT prove RLS or any
// server-side authorization behavior — see
// docs/SCHEDULE_MIGRATION.md's "Runtime multi-user verification" note.
//
// No @testing-library/user-event dependency is used here (it is not
// in package.json — see web/package.json) — interactions below use
// @testing-library/react's own fireEvent, which is sufficient for the
// click/change events this component actually listens for.
vi.mock('@/features/schedule/api/scheduleService', async () => {
  const actual = await vi.importActual<typeof scheduleService>('@/features/schedule/api/scheduleService');
  return {
    ...actual,
    listScheduleEvents: vi.fn(),
    listScheduleClasses: vi.fn(),
    createScheduleEvent: vi.fn(),
    updateScheduleEvent: vi.fn(),
    deleteScheduleEvent: vi.fn(),
    downloadICalendar: vi.fn(),
  };
});

function makeAuthValue(profile: Profile | null): AuthContextValue {
  return {
    status: profile ? 'signed_in' : 'signed_out',
    userId: profile?.id ?? null,
    profile,
    error: null,
    signOut: vi.fn(),
    refresh: vi.fn(),
  };
}

function renderWithAuth(profile: Profile | null, ui: ReactNode = <SchedulePage />) {
  return render(<AuthContext.Provider value={makeAuthValue(profile)}>{ui}</AuthContext.Provider>);
}

const TEACHER: Profile = { id: 'teacher-1', school_id: 'school-1', role: 'teacher' };
const ADMIN: Profile = { id: 'admin-1', school_id: 'school-1', role: 'admin' };
const STUDENT: Profile = { id: 'student-profile-1', school_id: 'school-1', role: 'student' };

function makeEvent(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'event-1',
    school_id: 'school-1',
    class_id: null,
    teacher_id: 'teacher-1',
    title: 'Grammar lesson',
    event_date: '2026-09-21',
    event_time: '10:00',
    duration_minutes: 45,
    status: 'scheduled',
    notes: null,
    class: null,
    ...overrides,
  };
}

describe('SchedulePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state before data resolves', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockImplementation(() => new Promise(() => {}));
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(TEACHER);

    expect(screen.getByText(/loading schedule/i)).toBeInTheDocument();
  });

  it('teacher: renders own events and a "New event" control (role parity — manage surface)', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({
      events: [makeEvent({ title: 'Own lesson' })],
      emptyReason: null,
    });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(TEACHER);

    await waitFor(() => expect(screen.getByText('Own lesson')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /new event/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /edit/i }).length).toBeGreaterThan(0);
  });

  it('student: never renders create/edit/delete controls (role parity — read-only surface)', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({
      events: [makeEvent({ title: 'Enrolled class lesson' })],
      emptyReason: null,
    });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(STUDENT);

    await waitFor(() => expect(screen.getByText('Enrolled class lesson')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /new event/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('student with no student row: shows the dedicated empty state, not a generic error', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({ events: [], emptyReason: 'no_student_row' });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(STUDENT);

    await waitFor(() => expect(screen.getByText(/student profile not found/i)).toBeInTheDocument());
  });

  it('student with no enrolled classes: shows the dedicated empty state, not an empty table', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({ events: [], emptyReason: 'no_enrolled_classes' });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(STUDENT);

    await waitFor(() => expect(screen.getByText(/not enrolled in any classes/i)).toBeInTheDocument());
  });

  it('surfaces a load failure as a safe message with a retry action, not a raw error', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockRejectedValue(new Error('password=hunter2 leaked'));
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(TEACHER);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).not.toContain('hunter2');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('admin: creating an event submits with the current user as teacher_id (no teacher picker)', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({ events: [], emptyReason: null });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);
    vi.mocked(scheduleService.createScheduleEvent).mockResolvedValue(makeEvent());

    renderWithAuth(ADMIN);

    await waitFor(() => expect(screen.getByRole('button', { name: /new event/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /new event/i }));

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'New staff meeting' } });
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: '2026-09-25' } });
    fireEvent.change(screen.getByLabelText(/time/i), { target: { value: '11:00' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    });

    await waitFor(() => expect(scheduleService.createScheduleEvent).toHaveBeenCalledTimes(1));
    const [calledProfile, calledValues] = vi.mocked(scheduleService.createScheduleEvent).mock.calls[0]!;
    expect(calledProfile.id).toBe(ADMIN.id);
    expect(calledValues.title).toBe('New staff meeting');
  });

  it('a failed delete surfaces a safe forbidden-style message rather than silently succeeding', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({
      events: [makeEvent({ id: 'other-event', title: 'Another teacher event' })],
      emptyReason: null,
    });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);
    vi.mocked(scheduleService.deleteScheduleEvent).mockRejectedValue(new Error('forbidden'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithAuth(TEACHER);

    await waitFor(() => expect(screen.getByText('Another teacher event')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  // PHASE 3A.1 data-minimization coverage: students can never create,
  // edit, or delete a Schedule event, so the school-wide class dropdown
  // data has no legitimate use for them and should never be requested.
  it('student: schedule load does NOT call listScheduleClasses (data minimization)', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({
      events: [makeEvent({ title: 'Enrolled class lesson' })],
      emptyReason: null,
    });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(STUDENT);

    await waitFor(() => expect(screen.getByText('Enrolled class lesson')).toBeInTheDocument());
    expect(scheduleService.listScheduleClasses).not.toHaveBeenCalled();
  });

  it('teacher/admin: schedule load still calls listScheduleClasses (required for create/edit UI)', async () => {
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({ events: [], emptyReason: null });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    const { unmount } = renderWithAuth(TEACHER);
    await waitFor(() => expect(scheduleService.listScheduleClasses).toHaveBeenCalledWith(TEACHER.school_id));
    unmount();

    vi.clearAllMocks();
    vi.mocked(scheduleService.listScheduleEvents).mockResolvedValue({ events: [], emptyReason: null });
    vi.mocked(scheduleService.listScheduleClasses).mockResolvedValue([]);

    renderWithAuth(ADMIN);
    await waitFor(() => expect(scheduleService.listScheduleClasses).toHaveBeenCalledWith(ADMIN.school_id));
  });
});
