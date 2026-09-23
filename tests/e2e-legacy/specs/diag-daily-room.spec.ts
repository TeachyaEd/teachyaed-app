import { test, expect } from '@playwright/test';
import { attachErrorCollectors } from '../helpers/error-collectors';
import { login, requireTeacherCredentials } from '../helpers/auth';

// DIAGNOSTIC ONLY -- this is not a P0 gate and does not assert pass/fail
// on the outcome it probes. It exists to answer one question before
// CALL-A (call-01..call-09) is implemented: can an authenticated staging
// caller successfully invoke the `daily-room` Supabase Edge Function?
//
// Why this exists: source-tracing callContact() -> initCall() in
// index.html shows initCall() is called synchronously and unconditionally
// by callContact() (the real-UI call-initiation path), for the CALLER,
// immediately after the ring signal is sent -- before any accept/decline
// happens. initCall() does:
//   const{data,error}=await sb.functions.invoke('daily-room',{body:{roomId}});
//   if(error||!data?.url){ showToast(...); hangUp(); return; }
// hangUp() resets S._callRoomId/S._callAttemptId to null. If daily-room
// is not deployed or misconfigured on staging, every real call attempt
// through the actual UI would silently fail this way shortly after
// initiation -- which would corrupt the correlation state CALL-A's
// decline/stale-decline assertions depend on, for reasons unrelated to
// signalling correctness. This must be known before CALL-A is written.
//
// This spec calls sb.functions.invoke('daily-room', ...) directly in the
// page context (not through callContact()/initCall(), and not creating
// any call_signals row or ring/decline traffic) -- a read-only-in-effect
// diagnostic per the "only for read-only diagnostics" allowance. `sb` is
// a top-level `const` inside index.html's classic (non-module) <script>
// tag; such top-level let/const bindings are visible to code evaluated
// in the page's main JS realm the same way they're visible when typed
// directly into the browser DevTools console -- which is exactly the
// mechanism page.evaluate() uses (CDP Runtime.evaluate in the page's
// main world), so `sb` is reachable here without being a `window` property.
//
// Never logs the anon key, any JWT, or any Authorization header -- only
// booleans, elapsed time, token length (never the token itself), an
// error message/status if present, and (on success) the result URL's
// hostname/protocol, never the full URL query or path in case it embeds
// a room token.
//
// TEMPORARY ADDITION (auth-layer investigation, staging 401 on daily-room):
// Production v5's authorization logic requires a call_room_participants
// row for a 1:1 (non-"ty-cls-") roomId, which this diagnostic's random
// `diag-${uuid}` room never has -- so once authentication itself works,
// the *expected* outcome here is 403 Forbidden, not a Daily URL. This
// diagnostic does not create any call_room_participants row and is not
// intended to reach a successful room creation. Its only job right now
// is to determine, without modifying the Edge Function, whether a 401
// response is a client-side session/token-propagation problem (session
// missing, or sb.functions.invoke() not attaching the access token) or
// a staging-side gateway/JWT-validation/function-code problem (session
// and token are present and valid, but the Edge Function/gateway still
// rejects it as Unauthorized). Two probes are run against the same
// random room: Probe A is the untouched production-like call path
// (sb.functions.invoke with no explicit headers, relying on whatever
// the pinned supabase-js client does automatically); Probe B explicitly
// sets the Authorization header from the current session's access_token
// on the same invoke call, using the options shape supported by the
// pinned supabase-js@2 FunctionsClient.invoke(name, { body, headers }).

const teacherCreds = requireTeacherCredentials();

test.describe('DIAGNOSTIC -- daily-room Edge Function staging reachability (CALL-A prerequisite, not a gate)', () => {
  test('teacher: authenticated sb.functions.invoke(daily-room) probe', async ({ page }) => {
    const errors = attachErrorCollectors(page);

    await login(page, teacherCreds);
    await expect(page.locator('#app')).toBeVisible();

    const result = await page.evaluate(async () => {
      // @ts-expect-error -- sb is a page-global from index.html's own script, not declared to TypeScript here.
      const sbClient = sb;

      // --- Auth-layer evidence (no secrets/tokens logged) ---
      let authEvidence: any = {};
      try {
        const { data: sessionData, error: sessionError } = await sbClient.auth.getSession();
        const session = sessionData?.session ?? null;
        authEvidence.getSessionError = sessionError ? (sessionError.message || String(sessionError)) : null;
        authEvidence.hasSession = !!session;
        authEvidence.hasSessionUserId = !!session?.user?.id;
        authEvidence.hasAccessToken = !!session?.access_token;
        authEvidence.accessTokenLength = session?.access_token ? session.access_token.length : null;

        const { data: userData, error: userError } = await sbClient.auth.getUser();
        authEvidence.getUserError = userError ? (userError.message || String(userError)) : null;
        authEvidence.getUserSuccess = !userError && !!userData?.user;
        authEvidence.hasGetUserId = !!userData?.user?.id;

        var accessToken = session?.access_token || null;
      } catch (e: any) {
        authEvidence.thrown = true;
        authEvidence.thrownMessage = e?.message || String(e);
        var accessToken = null;
      }

      const diagRoomId = 'diag-' + crypto.randomUUID();

      async function runProbe(useExplicitHeader: boolean) {
        const startedAt = Date.now();
        try {
          const invokeOptions: any = { body: { roomId: diagRoomId } };
          if (useExplicitHeader && accessToken) {
            invokeOptions.headers = { Authorization: `Bearer ${accessToken}` };
          }
          const { data, error } = await sbClient.functions.invoke('daily-room', invokeOptions);
          const elapsedMs = Date.now() - startedAt;
          if (error) {
            return {
              ok: false,
              elapsedMs,
              errorName: error.name || null,
              errorMessage: error.message || String(error),
              errorStatus: error.status ?? error.context?.status ?? null,
            };
          }
          const hasUrl = typeof data?.url === 'string' && data.url.length > 0;
          let urlHost: string | null = null;
          let urlIsHttps: boolean | null = null;
          if (hasUrl) {
            try {
              const u = new URL(data.url);
              urlHost = u.hostname;
              urlIsHttps = u.protocol === 'https:';
            } catch {
              /* leave nulls -- url did not parse */
            }
          }
          return { ok: true, elapsedMs, hasUrl, urlHost, urlIsHttps, dataKeys: data ? Object.keys(data) : [] };
        } catch (e: any) {
          return { ok: false, elapsedMs: Date.now() - startedAt, thrown: true, errorMessage: e?.message || String(e) };
        }
      }

      const probeA = await runProbe(false);
      const probeB = await runProbe(true);

      return { authEvidence, probeA, probeB };
    });

    console.log('[diag-daily-room] auth-layer evidence (no tokens/secrets):\n' + JSON.stringify(result.authEvidence, null, 2));
    console.log('[diag-daily-room] Probe A (no explicit Authorization header) result:\n' + JSON.stringify(result.probeA, null, 2));
    console.log('[diag-daily-room] Probe B (explicit Authorization: Bearer <session access_token>) result:\n' + JSON.stringify(result.probeB, null, 2));
    console.log(
      '[diag-daily-room] page console/network errors captured during login+probe (informational only):\n' +
        JSON.stringify(errors, null, 2),
    );

    // Deliberately no expect()/assertion on `result` or `errors` -- this
    // spec's job is to surface evidence in the CI log, not to pass/fail
    // CI based on daily-room's availability. The human reviewing the log
    // decides what it means for CALL-A.
  });
});
