import { test, expect } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';

// This is the ONLY spec permitted to run before staging schema/fixtures
// are provisioned. It makes zero assumptions about database contents --
// it only proves the generated artifact is the real legacy app, serves
// correctly, is configured for staging (not production), and doesn't
// explode on load. No login, no business assertions.

const PROD_REF = 'juwvlyrepwdcndkqiqna';
const STAGING_REF = process.env.STAGING_SUPABASE_REF || 'lqyetodkoxodwjyqxukq';

// Narrow, documented, smoke-only exception -- investigated at length in a
// forensic session (2026-09-22) before being added here. These 4 local
// 404s are issued by Chromium's speculative HTML preload scanner while
// scanning the large inline <script> element on the ephemeral local
// server only:
//   - proven via DOMParser that the <script> element is never
//     prematurely terminated (zero literal "</script" occurrences
//     anywhere in its ~525k characters, in both the generated staging
//     artifact and the production-configured source);
//   - the 4 literal strings never become real DOM nodes and no matching
//     <img> element exists anywhere in the parsed document;
//   - the requests fire before DOMContentLoaded, with CDP
//     initiatorType "parser" (not "script"), before any application JS
//     has run;
//   - not observed on a clean production load.
// This is local-server/browser-parser noise for the pre-login smoke,
// not evidence of broken application functionality. The exception below
// is deliberately narrow and structured (exact hostname + status + path
// match, not a regex or wildcard) -- see AllowedBadResponse in
// helpers/error-collectors.ts. It applies ONLY to this smoke spec and
// must NOT be copied into the future authenticated P0 specs, which stay
// zero-tolerance by default. The `src="x"` timer trick is intentional
// legacy behavior for quiz/PD time limits; any exception it needs there
// must be scoped to those specific authenticated tests, not granted here.
const SMOKE_ONLY_ALLOWED_BAD_RESPONSES = [
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(safeUrl)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(b.image)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_iUrl}' },
  { hostname: '127.0.0.1', status: 404, path: '/x' },
];

test.describe('legacy app smoke (pre-fixture, staging-config only)', () => {
  test('serves, loads, initializes without an uncaught error, and targets staging not production', async ({ page }) => {
    const errors = attachErrorCollectors(page);

    const response = await page.goto('/');
    expect(response, 'index.html did not return a response').not.toBeNull();
    expect(response?.ok(), `expected 2xx response, got ${response?.status()}`).toBeTruthy();

    // Confirms this is actually the legacy monolith, not a blank/wrong page.
    await expect(page).toHaveTitle(/TeachyaED/i);
    await expect(page.locator('#loginForm')).toBeVisible();

    // Confirms the generation-time substitution is reflected in what the
    // browser actually received and parsed -- not just what the file on
    // disk said, closing the loop between ci/generate-staging-artifact.mjs
    // and the real served/rendered document.
    const html = await page.content();
    expect(html, 'served HTML does not reference the staging Supabase ref').toContain(STAGING_REF);
    expect(html, 'served HTML still references the production Supabase ref').not.toContain(PROD_REF);

    // Give the app's init script (Supabase client construction, initial
    // auth check, etc.) a moment to run and surface any immediate error.
    await page.waitForTimeout(1500);

    assertNoUnexpectedErrors(errors, { allowBadResponses: SMOKE_ONLY_ALLOWED_BAD_RESPONSES });
  });
});
