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
// only. Never hardcoded, never logged, never printed. Returns null (not
// a thrown error) when unset so callers can test.skip() with a clear
// reason instead of failing the whole suite opaquely.
//
// Required secrets (see .github/workflows/staging-e2e.yml):
//   STAGING_TEACHER_EMAIL, STAGING_TEACHER_PASSWORD
//   STAGING_STUDENT_EMAIL, STAGING_STUDENT_PASSWORD

export function getTeacherCredentials(): Credentials | null {
  const email = process.env.STAGING_TEACHER_EMAIL;
  const password = process.env.STAGING_TEACHER_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

export function getStudentCredentials(): Credentials | null {
  const email = process.env.STAGING_STUDENT_EMAIL;
  const password = process.env.STAGING_STUDENT_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}
