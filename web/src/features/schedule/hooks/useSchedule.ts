import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { toAppError, AppError } from '@/lib/errors';
import { observability } from '@/lib/observability';
import {
  canManageSchedule,
  createScheduleEvent,
  deleteScheduleEvent,
  downloadICalendar,
  listScheduleClasses,
  listScheduleEvents,
  updateScheduleEvent,
} from '../api/scheduleService';
import type {
  ScheduleClassOption,
  ScheduleEmptyReason,
  ScheduleEvent,
  ScheduleEventFormValues,
} from '../types';

export type ScheduleLoadStatus = 'loading' | 'ready' | 'error';

interface ScheduleState {
  status: ScheduleLoadStatus;
  events: ScheduleEvent[];
  classes: ScheduleClassOption[];
  emptyReason: ScheduleEmptyReason;
  error: string | null;
}

const INITIAL_STATE: ScheduleState = {
  status: 'loading',
  events: [],
  classes: [],
  emptyReason: null,
  error: null,
};

/**
 * Loads and mutates the Schedule feature's data for the current
 * signed-in user, and exposes it as a single hook consumed by
 * <SchedulePage>.
 *
 * Stale-request / StrictMode-safety design mirrors AuthProvider's
 * proven `generationRef` + `mountedRef` pattern exactly (see
 * web/src/features/auth/AuthProvider.tsx's own header comment for
 * the full rationale): every load is tagged with the generation
 * counter's value at the moment it STARTS, and before committing a
 * result via setState it re-checks that generation is still current
 * and the component is still mounted. A slower, older load (e.g. a
 * request that started before the user switched role/school, or a
 * duplicate StrictMode-development invocation) can never overwrite a
 * newer one, and no load can update state after unmount.
 *
 * PHASE 3A.1 data-minimization note: `listScheduleClasses` returns
 * school-wide class metadata (used only to populate the create/edit
 * form's class dropdown). Students can never create, edit, or delete
 * a Schedule event, so that dropdown is never rendered for them â
 * fetching school-wide class options for a student is unnecessary
 * over-fetch, not a security fix (the `classes` table's own SELECT
 * policy is unchanged and is out of scope here; see
 * docs/SCHEDULE_MIGRATION.md). `canManageSchedule(profile.role)` is
 * the same role check the UI already uses to decide whether to show
 * management controls at all, so it's the correct gate here too.
 */
export function useSchedule() {
  const { status: authStatus, profile } = useAuth();
  const [state, setState] = useState<ScheduleState>(INITIAL_STATE);
  const [mutating, setMutating] = useState(false);

  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!profile) return;
    const generation = ++generationRef.current;
    const isCurrent = () => mountedRef.current && generationRef.current === generation;

    if (isCurrent()) {
      setState((prev) => ({ ...prev, status: 'loading', error: null }));
    }

    try {
      const canManage = canManageSchedule(profile.role);
      const [{ events, emptyReason }, classes] = await Promise.all([
        listScheduleEvents(profile),
        canManage && profile.school_id ? listScheduleClasses(profile.school_id) : Promise.resolve([]),
      ]);
      if (isCurrent()) {
        setState({ status: 'ready', events, classes, emptyReason, error: null });
      }
    } catch (err) {
      const appErr = toAppError(err);
      observability.captureError({
        message: 'schedule load failed',
        error: appErr,
        context: { userId: profile.id },
      });
      if (isCurrent()) {
        setState({ status: 'error', events: [], classes: [], emptyReason: null, error: appErr.userMessage });
      }
    }
  }, [profile]);

  useEffect(() => {
    mountedRef.current = true;
    if (authStatus === 'signed_in' && profile) {
      // Mirrors AuthProvider.tsx's own effect: the data-fetching entry
      // point is a function declared INSIDE the effect body rather than
      // calling an externally-defined useCallback's synchronous-setState
      // path directly at the top of the effect (react-hooks/set-state-in-effect;
      // see https://react.dev/learn/you-might-not-need-an-effect). Yielding
      // one microtask before invoking `load()` keeps `load()`'s own
      // generation-guarded setState calls out of the effect's synchronous
      // execution path without changing any observable timing or the
      // stale-request/StrictMode-safety guarantees `load()` already provides.
      async function runLoad() {
        await Promise.resolve();
        await load();
      }
      void runLoad();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [authStatus, profile, load]);

  const withMutationGuard = useCallback(
    async (action: () => Promise<void>) => {
      setMutating(true);
      try {
        await action();
        await load();
      } finally {
        if (mountedRef.current) setMutating(false);
      }
    },
    [load]
  );

  const createEvent = useCallback(
    (values: ScheduleEventFormValues) => {
      if (!profile) throw new AppError('auth', 'You must be signed in.');
      return withMutationGuard(async () => {
        await createScheduleEvent(profile, values);
      });
    },
    [profile, withMutationGuard]
  );

  const updateEvent = useCallback(
    (eventId: string, values: ScheduleEventFormValues) => {
      if (!profile) throw new AppError('auth', 'You must be signed in.');
      return withMutationGuard(async () => {
        await updateScheduleEvent(profile, eventId, values);
      });
    },
    [profile, withMutationGuard]
  );

  const deleteEvent = useCallback(
    (eventId: string) => {
      if (!profile) throw new AppError('auth', 'You must be signed in.');
      return withMutationGuard(async () => {
        await deleteScheduleEvent(profile, eventId);
      });
    },
    [profile, withMutationGuard]
  );

  const exportICal = useCallback(() => {
    downloadICalendar(state.events, profile?.school_id ?? null);
  }, [state.events, profile]);

  return useMemo(
    () => ({
      status: state.status,
      events: state.events,
      classes: state.classes,
      emptyReason: state.emptyReason,
      error: state.error,
      mutating,
      canManage: canManageSchedule(profile?.role),
      refresh: load,
      createEvent,
      updateEvent,
      deleteEvent,
      exportICal,
    }),
    [state, mutating, profile, load, createEvent, updateEvent, deleteEvent, exportICal]
  );
}
