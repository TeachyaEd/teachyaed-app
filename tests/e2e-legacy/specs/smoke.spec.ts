import { test, expect } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';

// This is the ONLY spec permitted to run before staging schema/fixtures
// are provisioned. It makes zero assumptions about database contents --
// it only proves the generated artifact is the real legacy app, serves
// correctly, is configured for staging (not production), and doesn't
// explode on load. No login, no business assertions.

const PROD_REF = 'juwvlyrepwdcndkqiqna';
const STAGING_REF = process.env.STAGING_SUPABASE_REF || 'lqyetodkoxodwjyqxukq';

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

    assertNoUnexpectedErrors(errors);
  });
});
