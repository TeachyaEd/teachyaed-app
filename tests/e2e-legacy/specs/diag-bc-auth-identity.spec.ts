import { test, type Page } from '@playwright/test';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// DIAGNOSTIC ONLY -- not a gate, not part of CALL-A pass/fail. Follow-up to
// diag-bc-failure.spec.ts, which proved (via raw websocket frame capture)
// that the private Broadcast channel join for BOTH teacher and student
// receives a clean Phoenix phx_reply with:
//   { status: "error", response: { reason:
//     "Unauthorized: You do not have permissions to read from this
//      Channel topic: notify-<uuid>" } }
// while the sibling `notify-pg-<uuid>` (postgres_changes, private:false)
// channel on the SAME websocket, at the SAME moment, joins successfully.
//
// Staging/production policy-baseline comparison (done outside this repo,
// via Supabase Dashboard SQL Editor, per user report) found:
//   - realtime.messages RLS enabled in both staging and prod
//   - FORCE RLS false in both
//   - realtime_notify_select identical in both:
//       realtime.topic() = 'notify-' || auth.uid()::text
//   - grants for anon/authenticated/service_role identical in both
// i.e. no policy/grant drift explains the Unauthorized. Since production
// has historically shown the same Unauthorized, this diagnostic treats it
// as a likely shared client/auth-identity-propagation issue until
// disproven -- NOT a policy problem. No policy is read or changed here.
//
// This spec verifies the actual authentication identity used at each step
// of the private-channel join, to determine whether the JWT presented to
// Realtime on the BC phx_join actually carries the same user identity as
// the app's own session/profile state (and therefore whether
// `auth.uid()` inside the RLS policy could ever equal the topic owner).
//
// Source-trace findings (static, from index.html, cited here for
// traceability -- confirmed via full-text search of the live file, not
// assumed):
//   - Zero occurrences of `setAuth` anywhere in index.html. The app never
//     calls `sb.realtime.setAuth(...)` explicitly at any point (login,
//     token refresh, or otherwise). It relies entirely on supabase-js's
//     own internal wiring between the Auth client and the Realtime client.
//   - The only `onAuthStateChange` handler in the app is:
//       sb.auth.onAuthStateChange((event,session)=>{
//         if(event==='SIGNED_OUT'&&!session&&S.userId&&!S._loggingOut){doLogout();}
//       });
//     It reacts ONLY to SIGNED_OUT (to force a full logout/reset). It does
//     NOT react to SIGNED_IN or TOKEN_REFRESHED -- so if supabase-js's
//     automatic realtime-auth-token propagation ever misses a refresh, the
//     app has no explicit fallback that re-arms Realtime auth.
//   - Every `sb.channel(...)` call site in the file (14 found; grep
//     inventory kept in the diagnostic commit) is reached only through
//     code paths gated on already-known post-login identifiers
//     (`S.profile.id`, a room id, a school id, etc.) that are only set
//     inside/after `afterLogin(user)`. There is no code path that opens a
//     Realtime channel before login and "upgrades" it later -- channels
//     are always created fresh, post-login.
//   - Exact ordering, all 3 entry paths into afterLogin(user) traced:
//       1) Invite/password-set flow: `sb.auth.getSession()` -> if session,
//          `afterLogin(session.user)`.
//       2) Login form submit: `sb.auth.signInWithPassword(...)` -> on
//          success, `afterLogin(data.user)` (uses the sign-in response's
//          user object directly, does not re-fetch session).
//       3) Page load / session restore: `sb.auth.getUser()` -> if user,
//          `afterLogin(user)`.
//     Inside `afterLogin(user)`, after the profile row is fetched/ensured:
//       S.profile=prof; S.role=prof.role; S.schoolId=prof.school_id; S.userId=prof.id;
//       ... (UI setup) ...
//       subscribeNotifications();   // synchronous call, same tick
//     `subscribeNotifications()` synchronously calls both
//     `_ensurePgNotifyChannel()` and `_ensureBcNotifyChannel()` in the same
//     call, guarded only by `S.profile?.id`. Neither reads
//     `sb.auth.getSession()` itself -- both hand off entirely to
//     supabase-js's `sb.channel(...).subscribe()`, which internally
//     attaches whatever access token supabase-js's Realtime client
//     currently holds.
//
// This diagnostic does not change any of this -- it only *observes*: (a)
// what `sb.auth.getSession()` reports immediately after login resolves,
// and (b) what access-token claims (sub/role/exp/aud only -- never the
// raw token) actually rode along on the real BC phx_join frame already
// captured on the wire.
//
// Scope discipline (unchanged from diag-bc-failure.spec.ts, restated):
//   - Zero monkey-patching of sb/sb.channel/any app function.
//   - No call initiated, no #dialBtn/contact click.
//   - No DB/RLS/Realtime policy read or write from this spec.
//   - PG and BC channels observed independently; their lifecycles/retry
//     timers are not merged or altered.
//   - No retries beyond Playwright's own (--retries=0); one fixed 20s
//     observation window per page, concurrent.
//   - JWTs are NEVER logged in raw form. The access_token field in every
//     captured frame is redacted before logging. Where JWT claims are
//     decoded, ONLY the following whitelisted claim names are extracted
//     and logged: sub, role, exp, aud, ref, iss. All other claims
//     (including anything not on this whitelist) are discarded before
//     logging, never printed.

const JWT_RE = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
function redact(s: string): string {
  return s.replace(JWT_RE, '[REDACTED_JWT]');
}

// Decode ONLY the whitelisted, non-sensitive claims from a JWT's middle
// (payload) segment. Never returns the raw token, header, or signature,
// and never returns any claim not on the whitelist (e.g. this
// deliberately drops anything email/phone/app_metadata/user_metadata-like
// that some Supabase JWTs may carry).
const CLAIM_WHITELIST = ['sub', 'role', 'exp', 'aud', 'ref', 'iss'] as const;
function decodeJwtClaimsSafe(token: string): Partial<Record<(typeof CLAIM_WHITELIST)[number], unknown>> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const full = JSON.parse(json);
    const safe: Partial<Record<(typeof CLAIM_WHITELIST)[number], unknown>> = {};
    for (const k of CLAIM_WHITELIST) {
      if (k in full) safe[k] = full[k];
    }
    return safe;
  } catch (_e) {
    return null;
  }
}

interface WsFrameRecord {
  ts: number;
  direction: 'sent' | 'received';
  topic: string | null;
  event: string | null;
  ref: string | null;
  payloadRedacted: string;
  /** Only populated for 'sent' phx_join frames whose payload carried an access_token; whitelisted claims only, never the raw token. */
  jwtClaims: Partial<Record<(typeof CLAIM_WHITELIST)[number], unknown>> | null;
}

// FIXED (previous run): the raw websocket frame is NOT the classic Phoenix
// v2 positional array `[join_ref, ref, topic, event, payload]`. Playwright's
// raw frame capture for this app's Realtime traffic is actually a JSON
// OBJECT with named keys: `{ topic, event, payload, ref, join_ref }` --
// confirmed directly from a captured frame's raw text in the prior
// diag-bc-failure.spec.ts run (payloadRedacted showed `"topic":"realtime:
// notify-...","event":"phx_join","payload":{...},"ref":"2","join_ref":"2"`).
// The previous version of this file assumed the array format, so
// `Array.isArray(arr)` was always false, topic/event/ref were always parsed
// as null, and the `f.event === 'phx_join'` filter in the test body never
// matched -- bcJoinFrame came back null for both teacher and student even
// though the frames themselves were captured correctly in `payloadRedacted`.
// This fix handles the actual object shape (falling back to the array shape
// too, defensively, in case a different frame type ever uses it).
function parsePhoenixFrame(raw: string): { topic: string | null; event: string | null; ref: string | null; rawPayload: unknown } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 4) {
      return { topic: String(parsed[2] ?? null), event: String(parsed[3] ?? null), ref: parsed[1] != null ? String(parsed[1]) : null, rawPayload: parsed[4] };
    }
    if (parsed && typeof parsed === 'object') {
      const p = parsed as any;
      if ('topic' in p || 'event' in p) {
        return {
          topic: p.topic != null ? String(p.topic) : null,
          event: p.event != null ? String(p.event) : null,
          ref: p.ref != null ? String(p.ref) : null,
          rawPayload: p.payload ?? null,
        };
      }
    }
  } catch (_e) {
    // not JSON / not a recognized frame shape -- ignore parse failure
  }
  return { topic: null, event: null, ref: null, rawPayload: null };
}

function extractAccessToken(rawPayload: unknown): string | null {
  if (rawPayload && typeof rawPayload === 'object') {
    const p = rawPayload as any;
    if (typeof p.access_token === 'string') return p.access_token;
    if (p.payload && typeof p.payload.access_token === 'string') return p.payload.access_token;
  }
  return null;
}

async function setupAndLogin(page: Page, creds: { email: string; password: string }, label: string): Promise<{ frames: WsFrameRecord[] }> {
  const frames: WsFrameRecord[] = [];

  page.on('websocket', (ws) => {
    const url = ws.url();
    const isRealtime = url.includes('/realtime/');
    ws.on('framesent', (f) => {
      if (!isRealtime) return;
      const raw = typeof f.payload === 'string' ? f.payload : String(f.payload);
      const parsed = parsePhoenixFrame(raw);
      const token = extractAccessToken(parsed.rawPayload);
      frames.push({
        ts: Date.now(),
        direction: 'sent',
        topic: parsed.topic,
        event: parsed.event,
        ref: parsed.ref,
        payloadRedacted: redact(raw).slice(0, 2000),
        jwtClaims: token ? decodeJwtClaimsSafe(token) : null,
      });
    });
    ws.on('framereceived', (f) => {
      if (!isRealtime) return;
      const raw = typeof f.payload === 'string' ? f.payload : String(f.payload);
      const parsed = parsePhoenixFrame(raw);
      frames.push({ ts: Date.now(), direction: 'received', topic: parsed.topic, event: parsed.event, ref: parsed.ref, payloadRedacted: redact(raw).slice(0, 2000), jwtClaims: null });
    });
  });

  await login(page, creds);
  console.log(`[diag-bc-auth-identity] ${label}: #app visible (login succeeded) at ${Date.now()}`);

  return { frames };
}

declare const S: any;

test.describe('DIAGNOSTIC -- Broadcast auth identity propagation (not a gate)', () => {
  test('verify session identity vs profile id vs BC join JWT sub vs topic uid, teacher and student, no call initiated', async ({ browser }) => {
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

      // Session identity read -- as close to "immediately after login" as
      // this spec can reach from outside the app's own synchronous
      // afterLogin() call (subscribeNotifications() fires synchronously
      // inside afterLogin, before login() here observes #app visible, so
      // by construction the BC .subscribe() call has already been made by
      // the time this evaluate runs; this still faithfully answers
      // "what does sb.auth.getSession() report for the session that was
      // current at/around the BC subscribe call", since Playwright's
      // login() helper does not await anything past app-visible).
      const [teacherSession, studentSession] = await Promise.all(
        [teacherPage, studentPage].map((page) =>
          page.evaluate(async () => {
            const hasS = typeof S !== 'undefined';
            const { data, error } = await sb.auth.getSession();
            return {
              hasSession: !!data?.session,
              sessionUserId: data?.session?.user?.id ?? null,
              hasAccessToken: !!data?.session?.access_token,
              getSessionError: error ? String(error.message ?? error) : null,
              profileId: hasS ? (S.profile?.id ?? null) : null,
            };
          }),
        ),
      );

      // Fixed 20s observation window (unchanged from diag-bc-failure.spec.ts).
      await Promise.all([teacherPage.waitForTimeout(20_000), studentPage.waitForTimeout(20_000)]);

      async function readBack(page: Page, label: string, capture: { frames: WsFrameRecord[] }, sessionInfo: (typeof teacherSession)) {
        const finalState = await page.evaluate(() => {
          const hasS = typeof S !== 'undefined';
          return {
            hasS,
            profileId: hasS ? (S.profile?.id ?? null) : null,
            bcState: hasS ? (S._bcState ?? null) : null,
            notifyBroadcastChannelTopic: hasS ? (S.notifyBroadcastChannel?.topic ?? null) : null,
          };
        });

        // The BC channel's own phx_join frame is the 'sent' frame whose
        // topic is `realtime:notify-<uuid>` WITHOUT the `-pg-` infix
        // (that infix belongs to the sibling postgres_changes channel).
        const bcJoinFrame = capture.frames.find((f) => f.direction === 'sent' && f.event === 'phx_join' && f.topic != null && /^realtime:notify-(?!pg-)/.test(f.topic));

        const topicUuid = finalState.notifyBroadcastChannelTopic ? finalState.notifyBroadcastChannelTopic.replace(/^realtime:notify-/, '') : null;

        // Debug counters -- kept small and non-sensitive (counts only), so
        // that if the frame filter still misses for any reason, that is
        // visible in the log instead of silently reporting null.
        const sentPhxJoinCount = capture.frames.filter((f) => f.direction === 'sent' && f.event === 'phx_join').length;

        console.log(
          `[diag-bc-auth-identity] ${label} IDENTITY COMPARISON:\n` +
            JSON.stringify(
              {
                'session.hasSession': sessionInfo.hasSession,
                'session.user.id': sessionInfo.sessionUserId,
                'session.hasAccessToken': sessionInfo.hasAccessToken,
                'session.getSessionError': sessionInfo.getSessionError,
                'S.profile.id (at session-read time)': sessionInfo.profileId,
                'S.profile.id (at end of 20s window)': finalState.profileId,
                'BC join frame found': bcJoinFrame != null,
                'BC join frame has access_token': !!bcJoinFrame && bcJoinFrame.jwtClaims != null,
                'BC join JWT claims (whitelisted only)': bcJoinFrame?.jwtClaims ?? null,
                'BC topic (from S.notifyBroadcastChannel.topic)': finalState.notifyBroadcastChannelTopic,
                'BC topic uuid suffix': topicUuid,
                bcState: finalState.bcState,
                allFourMatch:
                  bcJoinFrame?.jwtClaims?.sub != null &&
                  sessionInfo.sessionUserId === bcJoinFrame.jwtClaims.sub &&
                  sessionInfo.profileId === bcJoinFrame.jwtClaims.sub &&
                  topicUuid === bcJoinFrame.jwtClaims.sub,
                debug_totalFrames: capture.frames.length,
                debug_sentPhxJoinCount: sentPhxJoinCount,
              },
              null,
              2,
            ),
        );
        console.log(`[diag-bc-auth-identity] ${label} BC phx_join FRAME (topic/event/ref + whitelisted JWT claims only, raw token redacted):\n` + JSON.stringify(bcJoinFrame ?? null, null, 2));
        if (!bcJoinFrame) {
          // Fallback visibility: dump event/topic/direction only (never
          // payloadRedacted/jwtClaims here would be redundant, but this at
          // least shows what WAS captured if the primary filter misses).
          console.log(
            `[diag-bc-auth-identity] ${label} ALL SENT phx_join FRAMES (topic/event/ref only, fallback debug):\n` +
              JSON.stringify(
                capture.frames.filter((f) => f.direction === 'sent' && f.event === 'phx_join').map((f) => ({ topic: f.topic, event: f.event, ref: f.ref })),
                null,
                2,
              ),
          );
        }
      }

      await readBack(teacherPage, 'teacher', teacherCapture, teacherSession);
      await readBack(studentPage, 'student', studentCapture, studentSession);
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });
});
