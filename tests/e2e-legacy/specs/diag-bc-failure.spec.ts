import { test, type Page } from '@playwright/test';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// DIAGNOSTIC ONLY -- not a gate, not part of CALL-A pass/fail. Follow-up to
// the fixed p0-call-a.spec.ts's waitForNotifyReady, which now proves (via
// real S._notifyReady/S._bcState reads, no window.S bug) that on staging,
// for BOTH teacher and student:
//   S._notifyReady === true   (PG channel: healthy)
//   S._bcState    === 'failed' (Broadcast channel: NOT healthy)
// reproduced identically on the automatic retry. This is a real staging
// condition, not a test artifact.
//
// Source-traced from index.html (verbatim, reproduced for traceability):
//
//   function _ensureBcNotifyChannel(){
//     if(!S.profile?.id)return;
//     if(S._bcState==='connecting'||S._bcState==='healthy')return;
//     S._bcState='connecting';
//     S._bcGen=(S._bcGen||0)+1;
//     const gen=S._bcGen;
//     if(S._bcRetryTimer){clearTimeout(S._bcRetryTimer);S._bcRetryTimer=null;}
//     if(S.notifyBroadcastChannel){try{sb.removeChannel(S.notifyBroadcastChannel);}catch(e){}S.notifyBroadcastChannel=null;}
//     S.notifyBroadcastChannel=sb.channel(`notify-${S.profile.id}`,{config:{private:true}})
//       .on('broadcast',{event:'ring'}, ...)
//       .on('broadcast',{event:'decline'}, ...)
//       .subscribe(function(status){
//         if(gen!==S._bcGen)return;
//         if(status==='SUBSCRIBED'){ S._bcState='healthy'; }
//         else if(status==='CLOSED'||status==='CHANNEL_ERROR'||status==='TIMED_OUT'){
//           S._bcState='failed';
//           if(!S._bcRetryTimer){ S._bcRetryTimer=setTimeout(function(){...},20000); }
//         }
//       });
//   }
//
// Key source-level facts established by this trace, directly answering the
// task's questions 1-3 from source alone (confirmed/refuted empirically
// below):
//   - Topic is exactly `notify-${S.profile.id}` (NOT `notify-pg-...` --
//     that prefix is only used by the separate PG channel in
//     _ensurePgNotifyChannel). Client sends ('ring'/'decline' broadcasts,
//     in callContact()/declineCall()) and receives (.on('broadcast',...)
//     handlers here) on this SAME topic/channel -- symmetric send/receive,
//     one channel per profile id, not per-pair.
//   - `{config:{private:true}}` is set -- this routes Realtime Broadcast
//     through Supabase's Realtime Authorization, which requires a
//     `realtime.messages` RLS policy granting the authenticated user
//     SELECT (to receive) and/or INSERT (to send) for that topic, or the
//     private channel join is rejected.
//   - The app's own `.subscribe(function(status){...})` callback only
//     declares one parameter (`status`) and never reads the second
//     (`err`) argument supabase-js actually passes on CHANNEL_ERROR/
//     TIMED_OUT -- so the app itself silently discards any error detail
//     Realtime supplies. This diagnostic does NOT patch that callback (no
//     sb.channel monkey-patch -- that technique caused the prior
//     diag-call-a-readiness attempt to hang for 90s with zero output,
//     most likely by interfering with some other channel opened during
//     page init). Instead this spec captures the *raw websocket frames*
//     Playwright already exposes via `page.on('websocket')`, which shows
//     the actual Phoenix-protocol phx_join/phx_reply exchange with the
//     Realtime server -- this is strictly read-only observation of
//     traffic the browser already sends/receives; it changes no app
//     behavior and requires zero patching of any Supabase client code.
//
// Scope discipline, per explicit instruction:
//   - Zero monkey-patching of sb/sb.channel/any app function.
//   - No call initiated, no #dialBtn/contact click.
//   - No DB/RLS/Realtime policy read or write from this spec (no SQL, no
//     Supabase Management API calls) -- policy inspection is done
//     separately via a read-only SQL string handed to the user to run
//     themselves in the Supabase Dashboard, not executed here.
//   - PG and BC channels are observed independently; nothing here merges
//     their lifecycles or retry timers.
//   - No retries added beyond Playwright's own (this job runs
//     --retries=0); one fixed 20s observation window per page, run
//     concurrently (~20s wall-clock total), matching the BC subscribe
//     attempt already in flight from real login -- not a poll-until-
//     success, not a retry of any assertion (there are no assertions in
//     this file).
//   - Any string that looks like a JWT (three dot-separated
//     base64url segments) is redacted before being logged, in every
//     captured frame payload and every console message -- this covers
//     the `access_token` Realtime's phx_join payload carries for private
//     channels, and any Authorization-header-derived text a console
//     error might otherwise include.

const JWT_RE = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
function redact(s: string): string {
  return s.replace(JWT_RE, '[REDACTED_JWT]');
}

interface WsFrameRecord {
  ts: number;
  direction: 'sent' | 'received';
  topic: string | null;
  event: string | null;
  ref: string | null;
  payloadRedacted: string;
}
interface ConsoleRecord {
  ts: number;
  type: string;
  textRedacted: string;
}
interface StateTransition {
  ts: number;
  field: 'pgState' | 'bcState';
  from: unknown;
  to: unknown;
}

function parsePhoenixFrame(raw: string): { topic: string | null; event: string | null; ref: string | null } {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length >= 4) {
      // Phoenix v2 wire format: [join_ref, ref, topic, event, payload]
      return { topic: String(arr[2] ?? null), event: String(arr[3] ?? null), ref: arr[1] != null ? String(arr[1]) : null };
    }
  } catch (_e) {
    // not JSON / not a phoenix frame (e.g. heartbeat ack in a different shape) -- ignore parse failure, keep raw
  }
  return { topic: null, event: null, ref: null };
}

async function setupAndLogin(page: Page, creds: { email: string; password: string }, label: string): Promise<{ frames: WsFrameRecord[]; consoleMsgs: ConsoleRecord[] }> {
  const frames: WsFrameRecord[] = [];
  const consoleMsgs: ConsoleRecord[] = [];

  page.on('websocket', (ws) => {
    const url = ws.url();
    // Only Realtime traffic is relevant; Supabase Realtime endpoint path contains /realtime/v1/websocket.
    const isRealtime = url.includes('/realtime/');
    ws.on('framesent', (f) => {
      if (!isRealtime) return;
      const raw = typeof f.payload === 'string' ? f.payload : String(f.payload);
      const parsed = parsePhoenixFrame(raw);
      frames.push({ ts: Date.now(), direction: 'sent', ...parsed, payloadRedacted: redact(raw).slice(0, 2000) });
    });
    ws.on('framereceived', (f) => {
      if (!isRealtime) return;
      const raw = typeof f.payload === 'string' ? f.payload : String(f.payload);
      const parsed = parsePhoenixFrame(raw);
      frames.push({ ts: Date.now(), direction: 'received', ...parsed, payloadRedacted: redact(raw).slice(0, 2000) });
    });
  });

  page.on('console', (msg) => {
    const text = msg.text();
    // Keep the noise down -- only capture messages plausibly related to
    // realtime/channel/subscribe/error, still read-only, still no
    // behavior change.
    if (/realtime|channel|subscribe|broadcast|websocket|CHANNEL_ERROR|TIMED_OUT|unauthorized/i.test(text)) {
      consoleMsgs.push({ ts: Date.now(), type: msg.type(), textRedacted: redact(text).slice(0, 2000) });
    }
  });

  await login(page, creds);
  console.log(`[diag-bc-failure] ${label}: #app visible (login succeeded) at ${Date.now()}`);

  return { frames, consoleMsgs };
}

declare const S: any;

test.describe('DIAGNOSTIC -- Broadcast (_bcState) subscribe failure (not a gate)', () => {
  test('capture raw Realtime websocket frames for the private Broadcast channel, teacher and student, no call initiated', async ({ browser }) => {
    const teacherCreds = requireTeacherCredentials();
    const studentCreds = requireStudentCredentials();

    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();

    try {
      const [teacherCapture, studentCapture] = await Promise.all([
        setupAndLogin(teacherPage, teacherCreds, 'teacher'),
        setupAndLogin(studentPage, studentCreds, 'student'),
      ]);

      // Read-only transition sampler over _pgState/_bcState only (no
      // sb.channel patch) -- installed after login since we only need
      // the state timeline during the observation window, not a
      // pre-login baseline this time.
      await Promise.all(
        [teacherPage, studentPage].map((page) =>
          page.evaluate(() => {
            const w = window as any;
            w.__stateDiag = { transitions: [] as StateTransition[] };
            let last: Record<string, unknown> = { pgState: undefined, bcState: undefined };
            const sample = () => {
              const cur: Record<string, unknown> = {
                pgState: typeof S !== 'undefined' ? S._pgState : '<S undefined>',
                bcState: typeof S !== 'undefined' ? S._bcState : '<S undefined>',
              };
              for (const k of ['pgState', 'bcState']) {
                if (cur[k] !== last[k]) {
                  w.__stateDiag.transitions.push({ ts: Date.now(), field: k, from: last[k], to: cur[k] });
                }
              }
              last = cur;
            };
            sample();
            w.__stateDiagInterval = setInterval(sample, 50);
          }),
        ),
      );

      // Fixed 20s observation window, concurrent -- not a retry, not a
      // poll-until-success. Matches the BC channel's own first subscribe
      // attempt already in flight from login; the 20000ms BC retry timer
      // (source-traced above) means we expect to observe at most the
      // first attempt's result within this window, which is sufficient
      // to answer "every .subscribe() status callback value" for the
      // in-flight attempt.
      await Promise.all([teacherPage.waitForTimeout(20_000), studentPage.waitForTimeout(20_000)]);

      async function readBack(page: Page, label: string, capture: { frames: WsFrameRecord[]; consoleMsgs: ConsoleRecord[] }) {
        const result = await page.evaluate(() => {
          const w = window as any;
          clearInterval(w.__stateDiagInterval);
          const hasS = typeof S !== 'undefined';
          return {
            hasS,
            profileId: hasS ? (S.profile?.id ?? null) : null,
            role: hasS ? (S.role ?? null) : null,
            pgState: hasS ? (S._pgState ?? null) : null,
            bcState: hasS ? (S._bcState ?? null) : null,
            bcRetryTimerArmed: hasS ? (S._bcRetryTimer != null) : null,
            notifyBroadcastChannelTopic: hasS ? (S.notifyBroadcastChannel?.topic ?? null) : null,
            notifyBroadcastChannelState: hasS ? (S.notifyBroadcastChannel?.state ?? null) : null,
            stateTransitions: w.__stateDiag?.transitions ?? [],
          };
        });
        console.log(
          `[diag-bc-failure] ${label} FINAL STATE:\n` +
            JSON.stringify(
              {
                hasS: result.hasS,
                role: result.role,
                profileIdPresent: !!result.profileId,
                profileId: result.profileId,
                pgState: result.pgState,
                bcState: result.bcState,
                bcRetryTimerArmed: result.bcRetryTimerArmed,
                notifyBroadcastChannelTopic: result.notifyBroadcastChannelTopic,
                notifyBroadcastChannelState: result.notifyBroadcastChannelState,
              },
              null,
              2,
            ),
        );
        console.log(`[diag-bc-failure] ${label} STATE TRANSITIONS (pgState/bcState, chronological):\n` + JSON.stringify(result.stateTransitions, null, 2));
        console.log(`[diag-bc-failure] ${label} WEBSOCKET FRAMES (Realtime only, JWT-redacted, chronological):\n` + JSON.stringify(capture.frames, null, 2));
        console.log(`[diag-bc-failure] ${label} CONSOLE MESSAGES (realtime/channel-related only, redacted):\n` + JSON.stringify(capture.consoleMsgs, null, 2));
      }

      await readBack(teacherPage, 'teacher', teacherCapture);
      await readBack(studentPage, 'student', studentCapture);
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });
});

