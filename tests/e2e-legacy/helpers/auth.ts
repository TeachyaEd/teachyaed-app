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
// Still unverified against a *running* instance (only against source text),
// so the first real Playwright run is the actual confirmation step --
// if any of these turn out wrong, fix them here, do not silently
// loosen the smoke/P0 specs to route around it.

export interface Credentials {
  email: string;
  password: string;
}

export async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/');
  await page.locator('#loginEmail').fill(creds.email);
  await page.locator('#loginPass').fill(creds.password);
  await page.locator('button.btn-login').click();
  // App shell root becomes visible on successful login.
  await page.locator('#app').waitFor({ state: 'visible' });
}

export async function assertLoginFailed(page: Page): Promise<void> {
  await page.locator('#loginErr').waitFor({ state: 'visible' });
}

export async function logout(page: Page): Promise<void> {
  await page.locator('button.btn-logout').click();
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
