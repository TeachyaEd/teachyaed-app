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
//   - Caller: click #dialBtn -> toggleDialer() -> renderContacts() builds
//     `.contact-item[data-cid="<profile id>"]` rows in #contactList from
//     S.contacts (loaded by loadContacts(), called once right after
//     login alongside subscribeNotifications()); each row's onclick calls
//     callContact(id,name,role) -- callContact is the real, unmodified
//     app function invoked by a real click, not by test code.
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

async function waitForNotifyReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).S !== 'undefined' && (window as any).S._notifyReady === true && (window as any).S._bcState === 'healthy',
    null,
    { timeout: 20_000 },
  );
}

async function getOwnProfile(page: Page): Promise<{ id: string; first_name: string; last_name: string }> {
  return page.evaluate(() => {
    const s = (window as any).S;
    return { id: s.profile.id, first_name: s.profile.first_name, last_name: s.profile.last_name };
  });
}

async function installStudentDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__diag = { incoming: [] as any[], declines: [] as any[] };
    const origHandle = w.handleIncomingCall;
    w.handleIncomingCall = function (payload: any) {
      const s = w.S;
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
      const s = w.S;
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
      const s = w.S;
      w.__diag.hangups.push({ ts: Date.now(), callRoomId: s._callRoomId ?? null, callAttemptId: s._callAttemptId ?? null, inCall: s.inCall });
      return origHang.apply(this, arguments as any);
    };
  });
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
    const teacherCallSignalsInserts: { url: string; ts: number }[] = [];
    teacherPage.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/rest/v1/call_signals')) {
        teacherCallSignalsInserts.push({ url: req.url(), ts: Date.now() });
      }
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
        (sid) => Array.isArray((window as any).S.contacts) && (window as any).S.contacts.some((c: any) => c.id === sid),
        studentProfile.id,
        { timeout: 20_000 },
      );

      // ---------- ATTEMPT 1: real call, real decline ----------
      const attempt1InsertCountBefore = teacherCallSignalsInserts.length;
      const attempt1RingTs = Date.now();

      // 3. Teacher initiates one real call through the real UI.
      await teacherPage.locator('#dialBtn').click();
      await expect(teacherPage.locator('#contactPicker')).toHaveClass(/open/);
      await teacherPage.locator(`.contact-item[data-cid="${studentProfile.id}"]`).click();

      // 6. Student gets incoming-call UI.
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      // 4. Exactly one call_signals INSERT for this attempt.
      const attempt1InsertCountAfter = teacherCallSignalsInserts.length;
      expect(attempt1InsertCountAfter - attempt1InsertCountBefore).toBe(1);

      // Pull the live correlation state the app itself is using for this
      // attempt (read-only diagnostic reads of S, same pattern as
      // waitForNotifyReady above -- not an action).
      const attempt1 = await teacherPage.evaluate(() => ({
        roomId: (window as any).S._callRoomId,
        attemptId: (window as any).S._callAttemptId,
      }));
      expect(attempt1.roomId).toBeTruthy();
      expect(attempt1.attemptId).toBeTruthy();

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
      expect(provenIncoming[0].payload.attempt_id).toBe(attempt1.attemptId);

      // 5. call_room_participants trigger side effect, if observable
      // safely (best-effort, informational -- not fatal if RLS/timing
      // makes it unreadable from here, per "if observable safely").
      let participantsObserved: unknown = null;
      try {
        participantsObserved = await studentPage.evaluate(
          async ({ roomId }) => {
            const { data } = await (window as any).sb
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
      console.log(
        '[call-a] attempt-1 caller state:\n' +
          JSON.stringify({ attempt1, jitsiSrc, hangups: teacherDiagAfterCall.hangups }, null, 2),
      );
      expect(teacherDiagAfterCall.hangups.length).toBe(0);
      expect(jitsiSrc).toBeTruthy();
      expect(jitsiSrc).not.toBe('about:blank');

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
      expect(decline1.attempt_id).toBe(attempt1.attemptId);
      expect(decline1.caller_id).toBe(teacherProfile.id);

      const teacherDiagAfterDecline = await teacherPage.evaluate(() => (window as any).__diag);
      const hangup1 = (teacherDiagAfterDecline.hangups as HangupRecord[])[0];
      expect(hangup1).toBeTruthy();
      const attempt1CloseTs = hangup1.ts;

      // 12. Both sides return to idle.
      await expect.poll(async () => teacherPage.evaluate(() => (window as any).S.inCall)).toBe(false);
      await expect.poll(async () => studentPage.evaluate(() => (window as any).S.pendingRoom)).toBeNull();
      await expect(studentPage.locator('#incomingCall')).not.toHaveClass(/show/);

      console.log(
        '[call-a] attempt 1 timeline:\n' +
          JSON.stringify(
            { attemptId: attempt1.attemptId, roomId: attempt1.roomId, recipientId: studentProfile.id, fromProfileId: provenIncoming[0].payload.from_id, ringTs: attempt1RingTs, declineTs: attempt1DeclineTs, callerCloseTs: attempt1CloseTs },
            null,
            2,
          ),
      );

      // ---------- ATTEMPT 2: immediate second call to the same student ----------
      const attempt2InsertCountBefore = teacherCallSignalsInserts.length;
      const attempt2RingTs = Date.now();

      await teacherPage.locator('#dialBtn').click();
      await expect(teacherPage.locator('#contactPicker')).toHaveClass(/open/);
      await teacherPage.locator(`.contact-item[data-cid="${studentProfile.id}"]`).click();

      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const attempt2InsertCountAfter = teacherCallSignalsInserts.length;
      expect(attempt2InsertCountAfter - attempt2InsertCountBefore).toBe(1);

      const attempt2 = await teacherPage.evaluate(() => ({
        roomId: (window as any).S._callRoomId,
        attemptId: (window as any).S._callAttemptId,
      }));
      expect(attempt2.attemptId).toBeTruthy();
      expect(attempt2.attemptId).not.toBe(attempt1.attemptId); // call-08: a distinct per-attempt id
      expect(attempt2.roomId).toBe(attempt1.roomId); // same participant pair -> same deterministic room id

      const studentDiagAfterRing2 = await studentPage.evaluate(() => (window as any).__diag);
      const provenIncoming2 = (studentDiagAfterRing2.incoming as IncomingRecord[]).filter((r) => r.wouldProceed);
      expect(provenIncoming2.length).toBe(2); // one more than attempt 1's count
      const latestIncoming2 = provenIncoming2[1];
      expect(latestIncoming2.payload.from_id).toBe(teacherProfile.id);
      expect(latestIncoming2.payload.attempt_id).toBe(attempt2.attemptId);

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
        { callerId: teacherProfile.id, roomId: attempt1.roomId, attemptId: attempt1.attemptId },
      );

      // Give the stale event time to arrive and (correctly) be ignored;
      // assert the caller's live attempt-2 state and UI are unaffected.
      await teacherPage.waitForTimeout(3_000);
      const teacherDiagAfterStale = await teacherPage.evaluate(() => (window as any).__diag);
      // Still exactly 1 (from attempt 1's real decline above, same page/
      // same __diag accumulator for the whole test) -- the stale decline
      // must NOT have added a second hangup entry.
      expect(teacherDiagAfterStale.hangups.length).toBe(1);
      const liveStateAfterStale = await teacherPage.evaluate(() => ({ inCall: (window as any).S.inCall, roomId: (window as any).S._callRoomId, attemptId: (window as any).S._callAttemptId }));
      expect(liveStateAfterStale.inCall).toBe(true);
      expect(liveStateAfterStale.roomId).toBe(attempt2.roomId);
      expect(liveStateAfterStale.attemptId).toBe(attempt2.attemptId);
      await expect(teacherPage.locator('#callWindow')).toHaveClass(/visible/);

      // Decline attempt 2 normally through the real UI.
      const attempt2DeclineTs = Date.now();
      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      const studentDiagAfterDecline2 = await studentPage.evaluate(() => (window as any).__diag);
      const decline2 = (studentDiagAfterDecline2.declines as DeclineRecord[])[1];
      expect(decline2).toBeTruthy();
      expect(decline2.room_id).toBe(attempt2.roomId);
      expect(decline2.attempt_id).toBe(attempt2.attemptId);

      const teacherDiagFinal = await teacherPage.evaluate(() => (window as any).__diag);
      expect(teacherDiagFinal.hangups.length).toBe(2); // hangup #1 (attempt 1's real decline) + hangup #2 (attempt 2's real decline); the stale decline in between added none
      const hangup2 = (teacherDiagFinal.hangups as HangupRecord[])[1];
      expect(hangup2).toBeTruthy();
      const attempt2CloseTs = hangup2.ts;

      // Clean idle state again.
      await expect.poll(async () => teacherPage.evaluate(() => (window as any).S.inCall)).toBe(false);
      await expect.poll(async () => studentPage.evaluate(() => (window as any).S.pendingRoom)).toBeNull();
      await expect(studentPage.locator('#incomingCall')).not.toHaveClass(/show/);

      console.log(
        '[call-a] attempt 2 timeline:\n' +
          JSON.stringify(
            { attemptId: attempt2.attemptId, roomId: attempt2.roomId, recipientId: studentProfile.id, fromProfileId: latestIncoming2.payload.from_id, ringTs: attempt2RingTs, staleDeclineFromAttempt1: { roomId: attempt1.roomId, attemptId: attempt1.attemptId }, declineTs: attempt2DeclineTs, callerCloseTs: attempt2CloseTs },
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
