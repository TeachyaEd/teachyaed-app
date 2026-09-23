import { test, expect, type Page } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';
import { attachRequestStormDetector, attachRealtimeSubscriptionTracker } from '../helpers/request-storm-detector';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// CALL-A -- 1:1 call signalling stability (call-01..call-09), without
// accept/Daily-media assertions (that is CALL-B, not implemented here).
//
// Source-traced against live index.html (real UI, real call_signals, real
// Realtime, real daily-room invocation on the caller side -- no internal
// function is invoked directly for a user action; the only functions
// called from test code are read-only diagnostics or the construction of
// one deliberately-stale Realtime broadcast in scenario B, explained in
// detail at that point below).
//
// UI path traced from index.html:
//   - Caller: click a `.ev-class-card` on the teacher's "Классы" screen
//     (the default post-login landing screen) -> onclick="enterClassLesson(classId)"
//     -> openClassroomView(...) shows #classroomView (adds class "open") and
//     wires `#cv_callPanel .cv-call-btn` to cvCallStudent() for the teacher
//     role (source: `_cvCallBtn.setAttribute('onclick','cvCallStudent()')`
//     when role !== student). Note: the legacy global `#dialBtn` +
//     `#contactPicker` dial-anyone UI is dead code -- CSS-hidden
//     (`display:none`) with nothing in the app ever un-hiding it after
//     task "Remove out-of-class calling entry points"; it is NOT used here.
//   - cvCallStudent(): if the class has exactly one student, calls them
//     directly; otherwise falls back to opening `#contactPicker` (same
//     picker markup/rows as before) for a manual pick. Either way it ends
//     by calling callContact(id,name,role) -- callContact is the real,
//     unmodified app function invoked by a real click, not by test code.
//   - callContact(): sets S._callRoomId/S._callAttemptId (attemptId =
//     crypto.randomUUID(), used as call_signals.id), inserts the
//     call_signals row (fire-and-forget .then(), NOT awaited before
//     initCall() runs -- a real race condition in the app's own code,
//     observed and reported here if it manifests, not worked around),
//     sends a 'ring' broadcast on `notify-<recipientId>`, then awaits
//     initCall(roomId,name,false) which invokes the daily-room Edge
//     Function for the caller.
//   - Recipient: handleIncomingCall(payload) is reached via up to three
//     independent delivery paths (a 1.5s poll, a postgres_changes INSERT
//     subscription, and a Broadcast 'ring' handler that re-queries the DB
//     rather than trusting the broadcast payload) -- all three source
//     `payload.from_id` from the DB's `from_profile_id` column (never
//     from client-supplied broadcast data), which is what call-04 checks.
//     A built-in guard (`if(S.inCall||S.pendingRoom)return;`) means only
//     the first delivery path to arrive actually shows the incoming-call
//     UI (#incomingCall gets class "show"); the others silently no-op.
//   - Recipient declines via the real "â ÐÑÐºÐ»Ð¾Ð½Ð¸ÑÑ" button
//     (onclick="declineCall()"). declineCall() captures the then-current
//     S.pendingRoom/S.pendingCallAttemptId/S.pendingCallerId, clears
//     that state, and sends a 'decline' broadcast on
//     `notify-<callerId>` with {room_id, attempt_id}.
//   - Caller's decline handler (inside _ensureBcNotifyChannel) only calls
//     hangUp() if the incoming decline's room_id AND attempt_id both
//     strictly equal the caller's *current* S._callRoomId/S._callAttemptId
//     -- this exact check is what call-09 (stale decline immunity) below
//     exercises for real, not a re-implementation of it.
//
// Instrumentation strategy (read-only observation, never used to trigger
// a user action or to bypass any correlation/authorization logic):
//   - window.handleIncomingCall, window.declineCall, window.hangUp are
//     `function` declarations at the top level of index.html's classic
//     (non-module) <script> tag, so -- unlike the `const sb` binding --
//     they ARE plain `window` properties (function declarations create
//     global-object properties; `const`/`let` do not). Each is wrapped
//     here to push a timestamped record of the *real* arguments/state the
//     app itself observed, then the wrapper calls straight through to the
//     original via .apply(this, arguments) -- functional behavior is
//     completely unchanged, this only adds an observer.
//   - Every real HTTP request is already visible via Playwright's
//     page.on('request'/'response') events (also how the existing
//     request-storm detector and error collectors work); call-02's
//     "exactly one call_signals INSERT" is asserted by counting real
//     POST requests to '/rest/v1/call_signals' the browser actually sent,
//     not by re-querying the row afterward (the row is intentionally
//     short-lived -- deleted by whichever delivery path wins -- so
//     querying it back is racy and was deliberately avoided).
//
// Scenario B's stale-decline construction (documented in detail at its
// call site below) sends one real Realtime broadcast frame, via the same
// `sb.channel(name,{config:{private:true}}).send({type:'broadcast',...})`
// API declineCall() itself uses, carrying attempt 1's now-superseded
// {room_id, attempt_id}. This is real wire traffic processed by the
// real, unmodified caller-side handler; only the *sender* of an
// already-late duplicate is synthesized (standing in for a real-world
// network retry/race), never the receiver's correlation logic, and
// hangUp() is never called directly by test code anywhere in this file.

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

interface IncomingRecord {
  ts: number;
  wouldProceed: boolean;
  payload: { from_id: string | null; from_name: string | null; from_role: string | null; room_id: string | null; attempt_id: string | null };
}
interface DeclineRecord {
  ts: number;
  room_id: string | null;
  attempt_id: string | null;
  caller_id: string | null;
}
interface HangupRecord {
  ts: number;
  callRoomId: string | null;
  callAttemptId: string | null;
  inCall: boolean;
}
interface CallSignalsInsertRecord {
  url: string;
  ts: number;
  // Parsed from the real POST body via request.postDataJSON() -- the
  // actual call_signals row the app tried to insert, which is the
  // authoritative per-attempt identity (see header comment). Never
  // includes headers (auth/apikey live there, not the body).
  body: {
    id: string | null;
    room_id: string | null;
    to_profile_id: string | null;
    from_name: string | null;
    from_role: string | null;
  } | null;
}

declare const S: any;
declare const sb: any;

async function waitForNotifyReady(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S._notifyReady === true && S._bcState === 'healthy',
      null,
      { timeout: 20_000 },
    );
  } catch (err) {
    const diag = await page.evaluate(() => {
      const hasS = typeof S !== 'undefined';
      return {
        hasS,
        notifyReady: hasS ? (S._notifyReady ?? null) : null,
        bcState: hasS ? (S._bcState ?? null) : null,
        profileId: hasS ? (S.profile?.id ?? null) : null,
        profileRole: hasS ? (S.role ?? null) : null,
      };
    });
    console.log('[call-a] waitForNotifyReady timeout diagnostics:\n' + JSON.stringify(diag, null, 2));
    throw err;
  }
}

async function getOwnProfile(page: Page): Promise<{ id: string; first_name: string; last_name: string }> {
  return page.evaluate(() => {
    const s = S;
    return { id: s.profile.id, first_name: s.profile.first_name, last_name: s.profile.last_name };
  });
}

async function installStudentDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__diag = { incoming: [] as any[], declines: [] as any[] };
    const origHandle = w.handleIncomingCall;
    w.handleIncomingCall = function (payload: any) {
      const s = S;
      const wouldProceed = !(s.inCall || s.pendingRoom);
      w.__diag.incoming.push({
        ts: Date.now(),
        wouldProceed,
        payload: {
          from_id: payload?.from_id ?? null,
          from_name: payload?.from_name ?? null,
          from_role: payload?.from_role ?? null,
          room_id: payload?.room_id ?? null,
          attempt_id: payload?.attempt_id ?? null,
        },
      });
      return origHandle.apply(this, arguments as any);
    };
    const origDecline = w.declineCall;
    w.declineCall = function () {
      const s = S;
      w.__diag.declines.push({
        ts: Date.now(),
        room_id: s.pendingRoom ?? null,
        attempt_id: s.pendingCallAttemptId ?? null,
        caller_id: s.pendingCallerId ?? null,
      });
      return origDecline.apply(this, arguments as any);
    };
  });
}

async function installTeacherDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__diag = { hangups: [] as { ts: number; callRoomId: any; callAttemptId: any; inCall: any }[] };
    const origHang = w.hangUp;
    w.hangUp = function () {
      const s = S;
      w.__diag.hangups.push({ ts: Date.now(), callRoomId: s._callRoomId ?? null, callAttemptId: s._callAttemptId ?? null, inCall: s.inCall });
      return origHang.apply(this, arguments as any);
    };
  });
}

// Staging fixture has exactly one student in this class, so the real
// cvCallStudent() path (source-traced above) rings the student directly
// and #contactPicker never opens -- no fixed dead-wait is spent on it.
// Structural fallback kept only in case a multi-student fixture is ever
// used: race the picker actually opening against the student's real
// incoming-call UI (the actual signal the test needs), bounded by the
// same ceiling as the incoming-call assertion at the call site below --
// never an artificial sleep before reading call state.
async function ringPickerOrIncoming(teacherPage: Page, studentPage: Page, studentProfileId: string): Promise<void> {
  const which = await Promise.race([
    teacherPage
      .locator('#contactPicker.open')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => 'picker' as const)
      .catch(() => null),
    studentPage
      .locator('#incomingCall.show')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => 'incoming' as const)
      .catch(() => null),
  ]);
  if (which === 'picker') {
    await teacherPage.locator(`.contact-item[data-cid="${studentProfileId}"]`).click();
  }
}

test.describe('CALL-A -- 1:1 call signalling stability (call-01..call-09, no accept/media)', () => {
  test('teacher -> student: real call, student declines; then a second call proves stale-decline immunity', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();

    const teacherErrors = attachErrorCollectors(teacherPage);
    const studentErrors = attachErrorCollectors(studentPage);
    const teacherStorm = attachRequestStormDetector(teacherPage);
    const studentStorm = attachRequestStormDetector(studentPage);
    const teacherRt = attachRealtimeSubscriptionTracker(teacherPage);
    const studentRt = attachRealtimeSubscriptionTracker(studentPage);

    // Real network evidence for call-02 ("exactly one call_signals INSERT
    // per call attempt") -- counts actual POST requests the browser sent,
    // not a re-query of the (intentionally short-lived) row afterward.
    const teacherCallSignalsInserts: CallSignalsInsertRecord[] = [];
    teacherPage.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/rest/v1/call_signals')) {
        // Capture the real INSERT body the app actually sent -- this is
        // the authoritative per-attempt identity going forward (see
        // header comment), not the caller's post-hoc S._callRoomId/
        // S._callAttemptId reads, which hangUp() intentionally clears.
        // Supabase's REST client has sent single-row inserts as either a
        // bare object or a one-element array depending on version; handle
        // both shapes as actually observed at runtime, never assume one.
        // Never touch req.headers() here -- auth/apikey live there, not
        // in the body, and are never captured or logged.
        let body: CallSignalsInsertRecord['body'] = null;
        try {
          const parsed = req.postDataJSON();
          const row = Array.isArray(parsed) ? parsed[0] : parsed;
          if (row && typeof row === 'object') {
            body = {
              id: row.id ?? null,
              room_id: row.room_id ?? null,
              to_profile_id: row.to_profile_id ?? null,
              from_name: row.from_name ?? null,
              from_role: row.from_role ?? null,
            };
          }
        } catch {
          body = null;
        }
        teacherCallSignalsInserts.push({ url: req.url(), ts: Date.now(), body });
      }
    });

    // ---- DIAGNOSTIC-ONLY network instrumentation (not app code) ----
    // Wraps window.fetch via addInitScript so it is active from first
    // paint, before any app code runs. Captures real request/response
    // timing and ordering between the awaited call_signals INSERT and the
    // daily-room invocation, plus auth state at the moment daily-room
    // fires. Never logs a raw JWT -- only decoded iat/exp/sub/session_id
    // claims read from the Authorization header already being sent.
    await teacherPage.addInitScript(() => {
      (window as any).__netDiag = [];
      const origFetch = window.fetch.bind(window);
      (window as any).fetch = async function (input: any, init: any) {
        let url = '';
        let method = 'GET';
        try {
          url = typeof input === 'string' ? input : input.url;
          method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
        } catch { /* ignore */ }
        const isDailyRoom = url.includes('/functions/v1/daily-room');
        const isCallSignals = url.includes('/rest/v1/call_signals');
        if (!isDailyRoom && !isCallSignals) return origFetch(input, init);
        const entry: any = { url, method, startTs: Date.now() };
        try {
          const h = new Headers((init && init.headers) || (typeof input !== 'string' ? input.headers : undefined));
          const auth = h.get('authorization') || h.get('Authorization');
          entry.hasAuthHeader = !!auth;
          if (auth && auth.startsWith('Bearer ')) {
            const parts = auth.slice(7).split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
              entry.jwt = { iat: payload.iat, exp: payload.exp, sub: payload.sub, session_id: payload.session_id };
            }
          }
        } catch (e) { entry.authDecodeError = String(e); }
        if (isDailyRoom && method === 'POST') {
          try {
            const r = await sb.auth.getUser();
            entry.getUserBeforeSend = {
              hasUser: !!r?.data?.user,
              userId: r?.data?.user?.id ?? null,
              errorName: r?.error ? (r.error.name || r.error.message || 'error') : null,
            };
          } catch (e) { entry.getUserBeforeSendError = String(e); }
        }
        (window as any).__netDiag.push(entry);
        const resp = await origFetch(input, init);
        entry.endTs = Date.now();
        entry.status = resp.status;
        try { entry.body = await resp.clone().text(); } catch { /* ignore */ }
        console.log('[netdiag] ' + JSON.stringify(entry));
        return resp;
      };
    });

    try {
      // 1. Login teacher and student in two simultaneous, independent contexts.
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);

      // 2. Wait until both sides' real Realtime subscriptions (postgres_changes
      // AND broadcast) are healthy before placing any call.
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);

      const teacherProfile = await getOwnProfile(teacherPage);
      const studentProfile = await getOwnProfile(studentPage);

      await installStudentDiagnostics(studentPage);
      await installTeacherDiagnostics(teacherPage);

      // Teacher's contact list (loaded by the real loadContacts()) must
      // include the student before the real dial UI can be used.
      await teacherPage.waitForFunction(
        (sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid),
        studentProfile.id,
        { timeout: 20_000 },
      );

      // ---------- ATTEMPT 1: real call, real decline ----------
      const attempt1InsertCountBefore = teacherCallSignalsInserts.length;
      const attempt1RingTs = Date.now();

      // 3. Teacher initiates one real call through the real UI: enter the
      // class (real UI path: click `.ev-class-card` -> enterClassLesson()
      // -> openClassroomView() shows #classroomView and wires
      // #cv_callPanel .cv-call-btn to cvCallStudent() for the teacher role),
      // then click the real call button.
      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await expect(teacherPage.locator('#classroomView')).toHaveClass(/open/);
      const callBtn = teacherPage.locator('#cv_callPanel .cv-call-btn');
      await expect(callBtn).toBeVisible();
      await expect(callBtn).toBeEnabled();
      await callBtn.click();
      // cvCallStudent() rings the sole student in the class directly, or --
      // if the class has more than one student -- opens the real
      // #contactPicker for a manual pick (same picker used by the old
      // global dial UI). Handle both real outcomes, no guessing.
      await ringPickerOrIncoming(teacherPage, studentPage, studentProfile.id);

      // 6. Student gets incoming-call UI.
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      // 4. Exactly one call_signals INSERT for this attempt.
      const attempt1InsertCountAfter = teacherCallSignalsInserts.length;
      expect(attempt1InsertCountAfter - attempt1InsertCountBefore).toBe(1);

      // Authoritative attempt identity: the actual call_signals INSERT
      // body the app sent (captured via request.postDataJSON() above),
      // NOT S._callRoomId/S._callAttemptId -- those are the caller's own
      // transient scratch state, explicitly zeroed by hangUp() on any
      // call termination (success, decline, or daily-room failure), so
      // reading them after the fact is not a valid correlation source
      // (source-traced in detail; see the callContact()/hangUp() trace).
      const attempt1Insert = teacherCallSignalsInserts[attempt1InsertCountBefore];
      expect(attempt1Insert).toBeTruthy();
      expect(attempt1Insert.body).toBeTruthy();
      const attempt1 = {
        id: attempt1Insert.body!.id,
        roomId: attempt1Insert.body!.room_id,
        toProfileId: attempt1Insert.body!.to_profile_id,
      };
      expect(attempt1.id).toBeTruthy();
      expect(attempt1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i); // UUID-shaped
      expect(attempt1.roomId).toBeTruthy();
      expect(attempt1.toProfileId).toBe(studentProfile.id);

      // 7. Authoritative caller identity: the incoming-call payload's
      // from_id is (per the source-traced code in all three delivery
      // paths) always read from the DB's call_signals.from_profile_id
      // column -- never the client-claimed broadcast sender -- so
      // asserting it equals the teacher's real profile id here is
      // asserting the DB-authoritative identity, not a client claim.
      const studentDiagAfterRing = await studentPage.evaluate(() => (window as any).__diag);
      const provenIncoming = (studentDiagAfterRing.incoming as IncomingRecord[]).filter((r) => r.wouldProceed);
      expect(provenIncoming.length).toBe(1); // call-03: exactly one shown incoming ring
      expect(provenIncoming[0].payload.from_id).toBe(teacherProfile.id);
      expect(provenIncoming[0].payload.room_id).toBe(attempt1.roomId);
      expect(provenIncoming[0].payload.attempt_id).toBe(attempt1.id);

      // 5. call_room_participants trigger side effect, if observable
      // safely (best-effort, informational -- not fatal if RLS/timing
      // makes it unreadable from here, per "if observable safely").
      let participantsObserved: unknown = null;
      try {
        participantsObserved = await studentPage.evaluate(
          async ({ roomId }) => {
            const { data } = await sb
              .from('call_room_participants')
              .select('profile_id,room_id')
              .eq('room_id', roomId);
            return data;
          },
          { roomId: attempt1.roomId },
        );
      } catch (e) {
        participantsObserved = { observeError: String(e) };
      }
      console.log('[call-a] call_room_participants observation (best-effort):\n' + JSON.stringify(participantsObserved, null, 2));

      // 8. Caller-side daily-room must succeed for this real (now-member)
      // room and must NOT self-hang-up. Poll for a real Daily URL; also
      // watch for hangUp() firing in the meantime as the failure signal.
      let jitsiSrc: string | null = null;
      const daily_deadline = Date.now() + 15_000;
      while (Date.now() < daily_deadline) {
        jitsiSrc = await teacherPage.evaluate(() => (document.getElementById('jitsiFrame') as HTMLIFrameElement | null)?.src ?? null);
        if (jitsiSrc && jitsiSrc !== 'about:blank') break;
        const hangupsSoFar = await teacherPage.evaluate(() => (window as any).__diag.hangups.length);
        if (hangupsSoFar > 0) break;
        await teacherPage.waitForTimeout(250);
      }
      const teacherDiagAfterCall = await teacherPage.evaluate(() => (window as any).__diag);
      // DIAGNOSTIC-ONLY: dump the captured call_signals/daily-room network
      // timeline BEFORE any assertion can throw, so it is always present
      // in the CI log even when this test fails.
      const netDiagAttempt1 = await teacherPage.evaluate(() => (window as any).__netDiag);
      console.log('[call-a] netDiag (call_signals + daily-room timeline) attempt-1:\n' + JSON.stringify(netDiagAttempt1, null, 2));
      console.log(
        '[call-a] attempt-1 caller state:\n' +
          JSON.stringify({ attempt1, jitsiSrc, hangups: teacherDiagAfterCall.hangups }, null, 2),
      );
      expect(teacherDiagAfterCall.hangups.length).toBe(0);
      expect(jitsiSrc).toBeTruthy();
      expect(jitsiSrc).not.toBe('about:blank');

      // Explicit proof the real caller has not self-terminated before the
      // student even attempts to decline -- if this is false, that is a
      // real app/runtime failure (the caller dropped the call on its
      // own), not a test-correlation problem, and must be reported as
      // such rather than papered over.
      const callerStillActiveBeforeDecline = await teacherPage.evaluate(() => ({
        inCall: S.inCall,
        hangupsSoFar: (window as any).__diag.hangups.length,
      }));
      expect(callerStillActiveBeforeDecline.hangupsSoFar).toBe(0);
      expect(callerStillActiveBeforeDecline.inCall).toBe(true);

      // 9. Student declines through the real UI.
      const attempt1DeclineTs = Date.now();
      await studentPage.locator('#incomingCall .btn-red').click();

      // 11. Caller UI closes (hangUp fires on the correlated decline).
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      // 10. Decline correlated to the exact attempt.
      const studentDiagAfterDecline = await studentPage.evaluate(() => (window as any).__diag);
      const decline1 = (studentDiagAfterDecline.declines as DeclineRecord[])[0];
      expect(decline1).toBeTruthy();
      expect(decline1.room_id).toBe(attempt1.roomId);
      expect(decline1.attempt_id).toBe(attempt1.id);
      expect(decline1.caller_id).toBe(teacherProfile.id);

      const teacherDiagAfterDecline = await teacherPage.evaluate(() => (window as any).__diag);
      const hangup1 = (teacherDiagAfterDecline.hangups as HangupRecord[])[0];
      expect(hangup1).toBeTruthy();
      const attempt1CloseTs = hangup1.ts;

      // 12. Both sides return to idle.
      await expect.poll(async () => teacherPage.evaluate(() => S.inCall)).toBe(false);
      await expect.poll(async () => studentPage.evaluate(() => S.pendingRoom)).toBeNull();
      await expect(studentPage.locator('#incomingCall')).not.toHaveClass(/show/);

      console.log(
        '[call-a] attempt 1 timeline:\n' +
          JSON.stringify(
            { attemptId: attempt1.id, roomId: attempt1.roomId, recipientId: studentProfile.id, fromProfileId: provenIncoming[0].payload.from_id, ringTs: attempt1RingTs, declineTs: attempt1DeclineTs, callerCloseTs: attempt1CloseTs },
            null,
            2,
          ),
      );

      // ---------- ATTEMPT 2: immediate second call to the same student ----------
      const attempt2InsertCountBefore = teacherCallSignalsInserts.length;
      const attempt2RingTs = Date.now();

      const callBtn2 = teacherPage.locator('#cv_callPanel .cv-call-btn');
      await expect(callBtn2).toBeVisible();
      await expect(callBtn2).toBeEnabled();
      await callBtn2.click();
      await ringPickerOrIncoming(teacherPage, studentPage, studentProfile.id);

      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const attempt2InsertCountAfter = teacherCallSignalsInserts.length;
      expect(attempt2InsertCountAfter - attempt2InsertCountBefore).toBe(1);

      const attempt2Insert = teacherCallSignalsInserts[attempt2InsertCountBefore];
      expect(attempt2Insert).toBeTruthy();
      expect(attempt2Insert.body).toBeTruthy();
      const attempt2 = {
        id: attempt2Insert.body!.id,
        roomId: attempt2Insert.body!.room_id,
        toProfileId: attempt2Insert.body!.to_profile_id,
      };
      expect(attempt2.id).toBeTruthy();
      expect(attempt2.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i); // UUID-shaped
      expect(attempt2.id).not.toBe(attempt1.id); // call-08: a distinct per-attempt id
      expect(attempt2.roomId).toBe(attempt1.roomId); // same participant pair -> same deterministic room id
      expect(attempt2.toProfileId).toBe(studentProfile.id);

      const studentDiagAfterRing2 = await studentPage.evaluate(() => (window as any).__diag);
      const provenIncoming2 = (studentDiagAfterRing2.incoming as IncomingRecord[]).filter((r) => r.wouldProceed);
      expect(provenIncoming2.length).toBe(2); // one more than attempt 1's count
      const latestIncoming2 = provenIncoming2[1];
      expect(latestIncoming2.payload.from_id).toBe(teacherProfile.id);
      expect(latestIncoming2.payload.attempt_id).toBe(attempt2.id);

      // call-09: prove a STALE decline from attempt 1 cannot terminate
      // attempt 2. Real-signalling construction (documented in the file
      // header): send one genuine Realtime broadcast frame on the same
      // channel/event/payload shape declineCall() itself uses, carrying
      // attempt 1's now-superseded {room_id, attempt_id} -- attempt 1's
      // own pending-call state was already cleared by its real decline
      // above, so there is no UI control left to replay it through; this
      // constructs the equivalent of a late-arriving duplicate off the
      // wire and hands it to the real, unmodified caller-side handler.
      // hangUp() is never called directly here.
      await studentPage.evaluate(
        ({ callerId, roomId, attemptId }) => {
          const sb = (window as any).sb;
          return new Promise<void>((resolve, reject) => {
            const ch = sb.channel(`notify-${callerId}`, { config: { private: true } });
            const timeout = setTimeout(() => reject(new Error('stale-decline channel subscribe timed out')), 10_000);
            ch.subscribe((status: string) => {
              if (status === 'SUBSCRIBED') {
                clearTimeout(timeout);
                ch.send({ type: 'broadcast', event: 'decline', payload: { room_id: roomId, attempt_id: attemptId } }).then(() => {
                  setTimeout(() => sb.removeChannel(ch), 1000);
                  resolve();
                });
              } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(timeout);
                reject(new Error(`stale-decline channel subscribe failed: ${status}`));
              }
            });
          });
        },
        { callerId: teacherProfile.id, roomId: attempt1.roomId, attemptId: attempt1.id },
      );

      // Give the stale event time to arrive and (correctly) be ignored;
      // assert the caller's live attempt-2 state and UI are unaffected.
      await teacherPage.waitForTimeout(3_000);
      const teacherDiagAfterStale = await teacherPage.evaluate(() => (window as any).__diag);
      // Still exactly 1 (from attempt 1's real decline above, same page/
      // same __diag accumulator for the whole test) -- the stale decline
      // must NOT have added a second hangup entry.
      expect(teacherDiagAfterStale.hangups.length).toBe(1);
      const liveStateAfterStale = await teacherPage.evaluate(() => ({ inCall: S.inCall, roomId: S._callRoomId, attemptId: S._callAttemptId }));
      expect(liveStateAfterStale.inCall).toBe(true);
      expect(liveStateAfterStale.roomId).toBe(attempt2.roomId);
      expect(liveStateAfterStale.attemptId).toBe(attempt2.id);
      await expect(teacherPage.locator('#callWindow')).toHaveClass(/visible/);

      // Decline attempt 2 normally through the real UI.
      const attempt2DeclineTs = Date.now();
      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      const studentDiagAfterDecline2 = await studentPage.evaluate(() => (window as any).__diag);
      const decline2 = (studentDiagAfterDecline2.declines as DeclineRecord[])[1];
      expect(decline2).toBeTruthy();
      expect(decline2.room_id).toBe(attempt2.roomId);
      expect(decline2.attempt_id).toBe(attempt2.id);

      const teacherDiagFinal = await teacherPage.evaluate(() => (window as any).__diag);
      expect(teacherDiagFinal.hangups.length).toBe(2); // hangup #1 (attempt 1's real decline) + hangup #2 (attempt 2's real decline); the stale decline in between added none
      const hangup2 = (teacherDiagFinal.hangups as HangupRecord[])[1];
      expect(hangup2).toBeTruthy();
      const attempt2CloseTs = hangup2.ts;

      // Clean idle state again.
      await expect.poll(async () => teacherPage.evaluate(() => S.inCall)).toBe(false);
      await expect.poll(async () => studentPage.evaluate(() => S.pendingRoom)).toBeNull();
      await expect(studentPage.locator('#incomingCall')).not.toHaveClass(/show/);

      console.log(
        '[call-a] attempt 2 timeline:\n' +
          JSON.stringify(
            { attemptId: attempt2.id, roomId: attempt2.roomId, recipientId: studentProfile.id, fromProfileId: latestIncoming2.payload.from_id, ringTs: attempt2RingTs, staleDeclineFromAttempt1: { roomId: attempt1.roomId, attemptId: attempt1.id }, declineTs: attempt2DeclineTs, callerCloseTs: attempt2CloseTs },
            null,
            2,
          ),
      );

      // 13. Zero-tolerance error/storm/duplicate-subscription checks on
      // both pages, covering the whole scenario.
      teacherStorm.assertNoStorm();
      studentStorm.assertNoStorm();
      teacherRt.assertNoDuplicateSubscriptions();
      studentRt.assertNoDuplicateSubscriptions();
      assertNoUnexpectedErrors(teacherErrors);
      assertNoUnexpectedErrors(studentErrors);

      console.log('[call-a] full teacher call_signals INSERT requests:\n' + JSON.stringify(teacherCallSignalsInserts, null, 2));
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });
});
