import type { Page } from '@playwright/test';

// Generic console/page-error/network-failure collector for the legacy
// monolith. Attach once per page, assert at the end of a test (or after
// a specific action) so failures point at what actually happened rather
// than requiring the test author to guess every failure mode up front.

export interface CollectedErrors {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: { url: string; failure: string }[];
  badResponses: { url: string; status: number }[];
}

export function attachErrorCollectors(page: Page): CollectedErrors {
  const collected: CollectedErrors = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    badResponses: [],
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      collected.consoleErrors.push(`[console.error] ${msg.text()}`);
    }
  });

  page.on('pageerror', (err) => {
    collected.pageErrors.push(`[pageerror] ${err.message}`);
  });

  page.on('requestfailed', (req) => {
    collected.requestFailures.push({
      url: req.url(),
      failure: req.failure()?.errorText ?? 'unknown',
    });
  });

  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      collected.badResponses.push({ url: res.url(), status });
    }
  });

  return collected;
}

export interface AssertOptions {
  // Regexes matched against the error/url text; matches are ignored.
  // Use sparingly and only for genuinely expected noise (e.g. a
  // known third-party script warning) -- never to hide a real bug.
  allow?: RegExp[];
}

export function assertNoUnexpectedErrors(collected: CollectedErrors, opts: AssertOptions = {}): void {
  const allow = opts.allow ?? [];
  const isAllowed = (text: string) => allow.some((rx) => rx.test(text));

  const consoleErrors = collected.consoleErrors.filter((m) => !isAllowed(m));
  const pageErrors = collected.pageErrors.filter((m) => !isAllowed(m));
  const badResponses = collected.badResponses.filter((r) => !isAllowed(r.url));
  const requestFailures = collected.requestFailures.filter((r) => !isAllowed(r.url));

  const problems = [
    ...consoleErrors,
    ...pageErrors,
    ...badResponses.map((r) => `[bad response ${r.status}] ${r.url}`),
    ...requestFailures.map((r) => `[request failed: ${r.failure}] ${r.url}`),
  ];

  if (problems.length > 0) {
    throw new Error(`Unexpected console/page/network errors:\n${problems.join('\n')}`);
  }
}
