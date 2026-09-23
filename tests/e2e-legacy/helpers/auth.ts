import type { Page } from '@playwright/test';

// Selectors below are taken directly from the live production index.html
// (fetched and inspected 2026-09-22, commit main HEAD), not guessed:
//
//   <div id="loginForm">
//     <input type="email" id="loginEmail" ...>
//     <input type="password" id="loginPass" ...>
//     <button class="btn-login" onclick="doLogin()">Войти</button>
//     <div id="loginErr">Неверный email или пароль</div>
//   ...
//   <div id="app"> ... <button class="btn-sm btn-logout" onclick="doLogout()">Выйти</button>
//
// The logout button lives inside #sidebar. #sidebar's base (desktop) CSS
// rule is a normal in-flow flex child (width:210px, no position:fixed);
// the position:fixed/left:-260px off-canvas variant only applies inside
// `@media(max-width:767px)`, toggled by the .mobile-open class. Playwright's
// chromium/webkit projects here use devices['Desktop Chrome']/['Desktop
// Safari'] (desktop viewport), so the sidebar -- and this button -- is
// visible without calling toggleSidebar() first. Re-verify if the E2E
// viewport is ever changed to a mobile size.
//
// 2026-09-23 fix: the first real Chromium P0 run against staging failed
// before authentication -- button.btn-login matched 3 buttons on the live
// page (Войти / Отправить ссылку / Войти в систему →), which Playwright's
// strict mode correctly rejected as ambiguous. Replaced with an
// unambiguous role+name selector scoped to the exact login button text.
// Do not revert to the class selector.
//
// 2026-09-23 logout sync fix: doLogout() in index.html does
// `await sb.auth.signOut()` before resetting the DOM (#loginForm becomes
// visible only after that await resolves), so the app itself is not
// racing its own UI ahead of the call. The POST to /auth/v1/logout
// consistently shows up in requestFailures as [request failed:
// net::ERR_ABORTED], on every single P0 attempt, teacher and student
// alike, regardless of timing -- added a page.waitForResponse() wait
// (started before the click) as a first attempt at closing what looked
// like a teardown race. It did not fix the underlying signal (see next
// note); kept here only because it is harmless and does no waiting
// beyond the response headers arriving.
//
// 2026-09-23 diagnosis (response.finished() tried and reverted): a
// second attempt added `await response.finished()` after the above wait,
// hypothesizing the abort happened *after* headers but the response
// hadn't fully completed on the wire. That made every P0 attempt hang
// for the full 90s test timeout instead of failing fast, with zero
// additional signal -- `response.finished()` never resolved.
//
// Root cause, confirmed against upstream Playwright source/issues:
// Supabase's GoTrue /auth/v1/logout endpoint returns HTTP 204 No Content
// on success. Chromium's own network stack has a long-standing,
// independently confirmed quirk (microsoft/playwright#42786, fix
// proposed in microsoft/playwright#42787, unmerged as of Playwright
// 1.48.0 which this suite pins): for a fetch answered with 204 No
// Content, Chromium reports Network.loadingFailed / net::ERR_ABORTED to
// the CDP client *after* the response has already been delivered to the
// page -- even though the page's own `fetch()` promise resolves
// normally and the app proceeds correctly (confirmed: doLogout()'s
// `await sb.auth.signOut()` completes and the UI transitions to
// #loginForm on every run). Playwright's `Response.finished()` in 1.48.0
// only resolves on the `requestfinished` event, never on `requestfailed`
// -- so for a request that fails *after* its response (exactly this
// case), `finished()` never settles. This is a Chromium/CDP-level false
// failure signal on a 204 response, not an app defect, not a test race,
// and not something `finished()` can wait past in this Playwright
// version. Do not reintroduce `response.finished()` here -- see the P0
// diagnosis delivered 2026-09-23 for the full event-order evidence and
// the proposed (not yet applied) fix.

export interface Credentials {
  email: string;
  password: string;
}

export async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/');
  await page.locator('#loginEmail').fill(creds.email);
  await page.locator('#loginPass').fill(creds.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  // App shell root becomes visible on successful login.
  await page.locator('#app').waitFor({ state: 'visible' });
}

export async function assertLoginFailed(page: Page): Promise<void> {
  await page.locator('#loginErr').waitFor({ state: 'visible' });
}

export async function logout(page: Page): Promise<void> {
  const logoutResponse = page.waitForResponse(
    (res) => res.url().includes('/auth/v1/logout') && res.request().method() === 'POST',
  );
  await page.locator('button.btn-logout').click();
  await logoutResponse;
  await page.locator('#loginForm').waitFor({ state: 'visible' });
}

// Dedicated staging-only P0 test identities, read from CI/local env vars
// only. Never hardcoded, never logged, never printed.
//
// Deliberately fail-fast, not skip-on-missing: a release-quality P0 gate
// must not report green with both authenticated tests silently skipped.
// If a required var is unset, these throw immediately (at spec module
// load time, since callers assign the result to a top-level const --
// see specs/p0-teacher-student.spec.ts) naming exactly which variable(s)
// are missing. Values are never included in the thrown message.
//
// Required secrets (see .github/workflows/staging-e2e.yml, which also
// runs its own preflight step naming the same variables before any of
// this code even executes):
//   STAGING_TEACHER_EMAIL, STAGING_TEACHER_PASSWORD
//   STAGING_STUDENT_EMAIL, STAGING_STUDENT_PASSWORD

function requireEnvVars(names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required staging P0 credential environment variable(s): ${missing.join(', ')}. ` +
        `Set them as GitHub Actions secrets (see .github/workflows/staging-e2e.yml) for CI, or in ` +
        `the local shell env for a local run. This P0 suite fails fast on missing credentials ` +
        `rather than skipping -- a green run with both authenticated tests silently skipped is ` +
        `not an acceptable release gate.`,
    );
  }
  const result: Record<string, string> = {};
  for (const n of names) result[n] = process.env[n]!;
  return result;
}

export function requireTeacherCredentials(): Credentials {
  const vars = requireEnvVars(['STAGING_TEACHER_EMAIL', 'STAGING_TEACHER_PASSWORD']);
  return { email: vars.STAGING_TEACHER_EMAIL, password: vars.STAGING_TEACHER_PASSWORD };
}

export function requireStudentCredentials(): Credentials {
  const vars = requireEnvVars(['STAGING_STUDENT_EMAIL', 'STAGING_STUDENT_PASSWORD']);
  return { email: vars.STAGING_STUDENT_EMAIL, password: vars.STAGING_STUDENT_PASSWORD };
}
