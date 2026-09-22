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
//   <div id="app"> ... <button class="btn-logout" onclick="doLogout()">Выйти</button>
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
