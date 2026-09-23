import { test, type Page } from '@playwright/test';
import { requireTeacherCredentials, requireStudentCredentials, type Credentials } from '../helpers/auth';

// DIAGNOSTIC ONLY -- not a gate, not part of CALL-A pass/fail. Answers one
// question raised after chromium-call-a's first real run failed 100%
// reproducibly (2/2, original + retry) on:
//
//   TimeoutError: page.waitForFunction: Timeout 20000ms exceeded.
//     () => typeof (window as any).S !== 'undefined' &&
//           (window as any).S._notifyReady === true &&
//           (window as any).S._bcState === 'healthy'
//
// Working hypothesis to test here, established by static + live source
// inspection (not yet proven against the real staging app under real
// login): index.html declares `const S={...}` and `const sb=...` at the
// top level of a classic (non-module) inline <script> tag. Per ECMAScript,
// top-level `let`/`const`/`class` bindings in a classic script live in the
// Global Declarative Environment Record, which is DISTINCT from the Global
// Object Environment Record that backs `window`. Only `var` and top-level
// `function` declarations become properties of `window`. This was verified
// empirically against the live production page (https://teachyaed.github.io/,
// read-only, no login, no state change) in this same session:
//   window.S  -> undefined       (const, never exposed on window)
//   window.sb -> undefined       (const, never exposed on window)
//   bare `S`  -> "object"        (visible via direct reference in the
//                                 same realm, e.g. from page.evaluate)
//   bare `sb` -> "object"        (same)
//   window.handleIncomingCall -> "function"  (function declarations DO
//                                 become window properties, confirming the
//                                 const/function distinction, not a broader
//                                 environment issue)
//
// If this holds under a real authenticated session too, then
// `typeof (window as any).S !== 'undefined'` in p0-call-a.spec.ts can
// NEVER be true, regardless of the app's actual PG/Broadcast channel
// health -- which would fully and deterministically explain a 100%
// reproducible 20s timeout on every run, independent of Realtime state.
// p0-schedule-read.spec.ts (sched-01), which has passed on every CI run
// so far, never references `window.S` or bare `S` at all (confirmed by
// grep against its committed source) -- so its passing is not evidence
// against this hypothesis; it simply never exercised this code path.
//
// This spec deliberately does NOT use `(window as any).S`/`(window as
// any).sb`. It uses the shared-realm bare-identifier access pattern
// (`S`, `sb` referenced directly inside page.evaluate callbacks, with a
// `declare const S: any; declare const sb: any;` ambient declaration
// below to satisfy TypeScript) precisely so it can observe real
// PG/Broadcast channel state regardless of which hypothesis turns out to
// be correct.
//
// Scope discipline for this diagnostic, per explicit instruction:
//   - No call is ever initiated (no #dialBtn click, no contact click).
//   - No production/staging DB row is created, updated, or deleted by
//     this spec's own actions (login is the only real write, same as
//     every other spec in this suite).
//   - No Realtime channel policy is touched.
//   - The readiness gate/predicate itself is NOT changed anywhere by
//     this spec -- p0-call-a.spec.ts is untouched.
//   - No retries or sleeps are added beyond a single fixed
//     page.waitForTimeout(20_000) per page, which exists only to give
//     the in-page transition-sampling interval (below) the full "first
//     20 seconds after login" window the task asked for. That is an
//     observation window, not a retry of any action or assertion --
//     nothing is re-attempted, nothing is polled-until-success.
//
// Instrumentation strategy (read-only, install-before-login):
//   1. Immediately after page.goto('/') (before filling credentials or
//      clicking the login button), monkey-patch `sb.channel` in the
//      page's own realm: `const sb = ...` is a const *binding*, but the
//      object it points to is fully mutable, so `sb.channel = wrapped`
//      is legal and does not touch the app's login/subscribe logic --
//      it only wraps the method actually used by
//      `_ensurePgNotifyChannel()`/`_ensureBcNotifyChannel()` to capture
//      the channel topic and every raw `.subscribe(status, err)`
//      callback invocation, verbatim, with a timestamp. This must be
//      installed before login because `_ensurePgNotifyChannel()`/
//      `_ensureBcNotifyChannel()` are both called synchronously, back
//      to back, from `subscribeNotifications()`, which the app's own
//      login-success path calls immediately on successful auth -- there
//      is no separate "ready to instrument" hook to wait for.
//   2. Also before login, install a 50ms-interval, transition-only
//      sampler (records a row only when a value actually changes, not
//      on every tick) over `S._pgState`, `S._bcState`,
//      `S._notifyReady` -- these are exactly the three fields
//      `_ensurePgNotifyChannel`/`_ensureBcNotifyChannel` themselves
//      write to, per direct source reading of both functions in
//      index.html (reproduced in comments at each read-back call below
//      for traceability).
//   3. Perform the real login UI flow inline (not via the shared
//      login() helper) specifically so steps 1-2 can be interleaved
//      between page.goto() and the credential fill/submit -- this is
//      the only reason this spec does not reuse helpers/auth.ts login().
//   4. After #app becomes visible (real login success signal, same as
//      every other spec), wait the fixed 20s window, then read back and
//      console.log everything: final S._pgState/_bcState/_notifyReady/
//      _pgGen/_bcGen, S.profile.id, S.role, every captured subscribe
//      event (topic, status, err, ts), and every captured state
//      transition (field, from, to, ts). No call is ever initiated.

declare const S: any;
declare const sb: any;

interface SubscribeEvent {
  ts: number;
  topic: string;
  status: string;
  err: string | null;
}
interface StateTransition {
  ts: number;
  field: 'pgState' | 'bcState' | 'notifyReady';
  from: unknown;
  to: unknown;
}

async function installDiagnosticsAndLogin(page: Page, creds: Credentials, label: string): Promise<void> {
  await page.goto('/');

  // Step 1: wrap sb.channel (mutating the object sb points to, not the
  // `sb` binding itself) to capture channel topic + raw subscribe
  // callback values. Installed before any login interaction.
  await page.evaluate(() => {
    const w = window as any;
    w.__rtDiag = { events: [] as SubscribeEventLike[] };
    const origChannel = sb.channel.bind(sb);
    sb.channel = function (topic: string, opts?: unknown) {
      const ch = origChannel(topic, opts);
      const origSubscribe = ch.subscribe.bind(ch);
      ch.subscribe = function (cb?: (status: string, err?: unknown) => void) {
        const wrapped = function (status: string, err?: unknown) {
          w.__rtDiag.events.push({
            ts: Date.now(),
            topic,
            status,
            err: err ? String((err as any).message || err) : null,
          });
          return cb ? cb.apply(this, arguments as any) : undefined;
        };
        return origSubscribe(wrapped);
      };
      return ch;
    };
    type SubscribeEventLike = { ts: number; topic: string; status: string; err: string | null };
  });

  // Step 2: transition-only sampler over the exact 3 fields
  // _ensurePgNotifyChannel/_ensureBcNotifyChannel write to:
  //   _ensurePgNotifyChannel's .subscribe callback:
  //     status==='SUBSCRIBED'                    -> S._pgState='healthy'; S._notifyReady=true;
  //     status==='CLOSED'|'CHANNEL_ERROR'|'TIMED_OUT' -> S._pgState='failed'; S._notifyReady=false;
  //     (S._pgState is also set to 'connecting' synchronously at the top
  //      of _ensurePgNotifyChannel, before .subscribe() is even called)
  //   _ensureBcNotifyChannel's .subscribe callback:
  //     status==='SUBSCRIBED'                    -> S._bcState='healthy';
  //     status==='CLOSED'|'CHANNEL_ERROR'|'TIMED_OUT' -> S._bcState='failed'; (retry scheduled after 20000ms)
  //     (S._bcState is also set to 'connecting' synchronously at the top
  //      of _ensureBcNotifyChannel)
  // No other statuses are handled by either function -- any other status
  // string (e.g. an "Unauthorized" style payload that isn't literally
  // 'SUBSCRIBED'/'CLOSED'/'CHANNEL_ERROR'/'TIMED_OUT') leaves the state
  // stuck at 'connecting' forever, with no transition and no retry timer
  // armed, per direct reading of both functions -- this sampler will
  // surface that silently-stuck case as "last transition was to
  // 'connecting' and nothing after it", which the subscribe-event log
  // will also independently confirm or refute via the raw status strings.
  await page.evaluate(() => {
    const w = window as any;
    w.__stateDiag = { transitions: [] as StateTransitionLike[] };
    type StateTransitionLike = { ts: number; field: string; from: unknown; to: unknown };
    let last: Record<string, unknown> = { pgState: undefined, bcState: undefined, notifyReady: undefined };
    const sample = () => {
      const cur: Record<string, unknown> = {
        pgState: typeof S !== 'undefined' ? S._pgState : '<S undefined>',
        bcState: typeof S !== 'undefined' ? S._bcState : '<S undefined>',
        notifyReady: typeof S !== 'undefined' ? S._notifyReady : '<S undefined>',
      };
      for (const k of ['pgState', 'bcState', 'notifyReady']) {
        if (cur[k] !== last[k]) {
          w.__stateDiag.transitions.push({ ts: Date.now(), field: k, from: last[k], to: cur[k] });
        }
      }
      last = cur;
    };
    sample(); // capture pre-login baseline (S exists as soon as the page's own scripts ran, even before login)
    w.__stateDiagInterval = setInterval(sample, 50);
  });

  // Step 3: the real login UI flow (inlined, not via the shared helper --
  // see file header for why).
  await page.locator('#loginEmail').fill(creds.email);
  await page.locator('#loginPass').fill(creds.password);
  await page.getByRole('button', { name: 'ÐÐ¾Ð¹ÑÐ¸', exact: true }).click();
  await page.locator('#app').waitFor({ state: 'visible' });

  console.log(`[diag-call-a-readiness] ${label}: #app visible (login succeeded) at ${Date.now()}`);
}

test.describe('DIAGNOSTIC -- CALL-A PG/Broadcast readiness (not a gate)', () => {
  test('capture PG vs Broadcast channel readiness separately for teacher and student, no call initiated', async ({ browser }) => {
    const teacherCreds = requireTeacherCredentials();
    const studentCreds = requireStudentCredentials();

    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();

    try {
      await Promise.all([
        installDiagnosticsAndLogin(teacherPage, teacherCreds, 'teacher'),
        installDiagnosticsAndLogin(studentPage, studentCreds, 'student'),
      ]);

      // Fixed 20s observation window per page -- not a retry, not a
      // poll-until-success; the sampler above is already running and
      // recording every transition with its own timestamp regardless of
      // when this resolves. Run both waits concurrently so the window is
      // ~20s wall-clock total, not 40s.
      await Promise.all([
        teacherPage.waitForTimeout(20_000),
        studentPage.waitForTimeout(20_000),
      ]);

      async function readBack(page: Page, label: string) {
        const result = await page.evaluate(() => {
          const w = window as any;
          clearInterval(w.__stateDiagInterval);
          const hasS = typeof S !== 'undefined';
          const hasSb = typeof sb !== 'undefined';
          return {
            hasS,
            hasSb,
            windowSTypeof: typeof w.S, // expected 'undefined' if the const/window hypothesis holds
            windowSbTypeof: typeof w.sb, // expected 'undefined' if the const/window hypothesis holds
            profileId: hasS ? (S.profile?.id ?? null) : null,
            role: hasS ? (S.role ?? null) : null,
            pgState: hasS ? (S._pgState ?? null) : null,
            bcState: hasS ? (S._bcState ?? null) : null,
            notifyReady: hasS ? (S._notifyReady ?? null) : null,
            pgGen: hasS ? (S._pgGen ?? null) : null,
            bcGen: hasS ? (S._bcGen ?? null) : null,
            pgRetryTimerArmed: hasS ? (S._pgRetryTimer != null) : null,
            bcRetryTimerArmed: hasS ? (S._bcRetryTimer != null) : null,
            notifyChannelTopic: hasS ? (S.notifyChannel?.topic ?? null) : null,
            notifyBroadcastChannelTopic: hasS ? (S.notifyBroadcastChannel?.topic ?? null) : null,
            subscribeEvents: w.__rtDiag?.events ?? [],
            stateTransitions: w.__stateDiag?.transitions ?? [],
            // exact gate predicate as written in p0-call-a.spec.ts, evaluated
            // both ways for direct comparison -- neither form is changed
            // anywhere else; this is read-only observation of both.
            gatePredicate_windowS: typeof w.S !== 'undefined' && w.S?._notifyReady === true && w.S?._bcState === 'healthy',
            gatePredicate_bareS: hasS && S._notifyReady === true && S._bcState === 'healthy',
          };
        });
        console.log(
          `[diag-call-a-readiness] ${label} FINAL STATE:\n` +
            JSON.stringify(
              {
                hasS: result.hasS,
                hasSb: result.hasSb,
                windowSTypeof: result.windowSTypeof,
                windowSbTypeof: result.windowSbTypeof,
                role: result.role,
                profileIdPresent: !!result.profileId, // presence only, not the UUID value pattern-matched against anything sensitive -- UUID itself is fine per task instructions ("UUID/role only, no token")
                profileId: result.profileId,
                pgState: result.pgState,
                bcState: result.bcState,
                notifyReady: result.notifyReady,
                pgGen: result.pgGen,
                bcGen: result.bcGen,
                pgRetryTimerArmed: result.pgRetryTimerArmed,
                bcRetryTimerArmed: result.bcRetryTimerArmed,
                notifyChannelTopic: result.notifyChannelTopic,
                notifyBroadcastChannelTopic: result.notifyBroadcastChannelTopic,
                gatePredicate_windowS_asWrittenInCallASpec: result.gatePredicate_windowS,
                gatePredicate_bareS_ifSpecUsedBareIdentifier: result.gatePredicate_bareS,
              },
              null,
              2,
            ),
        );
        console.log(
          `[diag-call-a-readiness] ${label} SUBSCRIBE EVENTS (raw, chronological):\n` +
            JSON.stringify(result.subscribeEvents, null, 2),
        );
        console.log(
          `[diag-call-a-readiness] ${label} STATE TRANSITIONS (pgState/bcState/notifyReady, chronological):\n` +
            JSON.stringify(result.stateTransitions, null, 2),
        );
      }

      await readBack(teacherPage, 'teacher');
      await readBack(studentPage, 'student');
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });
});
