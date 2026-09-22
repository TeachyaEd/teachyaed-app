import { test, expect } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';
// TEMPORARY DIAGNOSTIC -- remove this import and its call site below once the
// root cause of the 4 suspicious staging-smoke requests is proven and either
// fixed, or explicitly approved (in a SEPARATE change) for an allow-list.
import { attachSuspiciousRequestDiagnostics } from '../helpers/diagnostic-suspicious-requests';

// This is the ONLY spec permitted to run before staging schema/fixtures
// are provisioned. It makes zero assumptions about database contents --
// it only proves the generated artifact is the real legacy app, serves
// correctly, is configured for staging (not production), and doesn't
// explode on load. No login, no business assertions.

const PROD_REF = 'juwvlyrepwdcndkqiqna';
const STAGING_REF = process.env.STAGING_SUPABASE_REF || 'lqyetodkoxodwjyqxukq';

test.describe('legacy app smoke (pre-fixture, staging-config only)', () => {
  test('serves, loads, initializes without an uncaught error, and targets staging not production', async ({ page, browserName }) => {
    const errors = attachErrorCollectors(page);
    // TEMPORARY DIAGNOSTIC -- see helpers/diagnostic-suspicious-requests.ts.
    // Does not weaken assertNoUnexpectedErrors below; only adds console.log
    // (never console.error) output for 4 known suspicious request paths.
    await attachSuspiciousRequestDiagnostics(page, browserName);

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

    assertNoUnexpectedErrors(errors);
  });
});
