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
// booleans, elapsed time, an error message/status if present, and (on
// success) the result URL's hostname/protocol, never the full URL query
// or path in case it embeds a room token.

const teacherCreds = requireTeacherCredentials();

test.describe('DIAGNOSTIC -- daily-room Edge Function staging reachability (CALL-A prerequisite, not a gate)', () => {
  test('teacher: authenticated sb.functions.invoke(daily-room) probe', async ({ page }) => {
    const errors = attachErrorCollectors(page);

    await login(page, teacherCreds);
    await expect(page.locator('#app')).toBeVisible();

    const result = await page.evaluate(async () => {
      const diagRoomId = 'diag-' + crypto.randomUUID();
      const startedAt = Date.now();
      try {
        // @ts-expect-error -- sb is a page-global from index.html's own script, not declared to TypeScript here.
        const { data, error } = await sb.functions.invoke('daily-room', { body: { roomId: diagRoomId } });
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
        return {
          ok: true,
          elapsedMs,
          hasUrl,
          urlHost,
          urlIsHttps,
          dataKeys: data ? Object.keys(data) : [],
        };
      } catch (e: any) {
        return {
          ok: false,
          elapsedMs: Date.now() - startedAt,
          thrown: true,
          errorMessage: e?.message || String(e),
        };
      }
    });

    console.log('[diag-daily-room] probe result:\n' + JSON.stringify(result, null, 2));
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

