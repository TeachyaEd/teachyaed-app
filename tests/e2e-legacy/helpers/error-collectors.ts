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

// A single, exact, structured exception for one specific bad HTTP response.
// Deliberately NOT a regex: every field must match exactly, so this can
// never silently widen to cover a URL, host, or status it wasn't written
// for. Intended for narrow, documented, per-spec exceptions only (see
// specs/smoke.spec.ts for the one case this exists for today) -- never
// apply this at the collector level or by default.
export interface AllowedBadResponse {
  hostname: string; // exact match, e.g. '127.0.0.1' -- never a wildcard/pattern
  status: number; // exact match, e.g. 404
  path: string; // exact, decoded pathname match, e.g. '/${_escHtml(safeUrl)}'
}

export interface AssertOptions {
  // Regexes matched against console/page-error text or request URLs;
  // matches are ignored. Use sparingly and only for genuinely expected
  // noise (e.g. a known third-party script warning) -- never to hide a
  // real bug. Prefer allowBadResponses (below) for known bad HTTP
  // responses, since it is exact/structured rather than pattern-based.
  allow?: RegExp[];
  // Exact, structured exceptions for specific known bad HTTP responses.
  // Each entry must match hostname + status + decoded path exactly.
  // Also budgets an equal number of the generic browser-emitted
  // "Failed to load resource: the server responded with a status of
  // 404 (Not Found)" console.error messages (which carry no URL of
  // their own in msg.text()), so the exception can never absorb more
  // generic 404 console noise than there are legitimately allowed bad
  // responses this run. All other console errors, page errors, and
  // request failures are unaffected.
  allowBadResponses?: AllowedBadResponse[];
}

const GENERIC_RESOURCE_404_CONSOLE_TEXT =
  '[console.error] Failed to load resource: the server responded with a status of 404 (Not Found)';

export function assertNoUnexpectedErrors(collected: CollectedErrors, opts: AssertOptions = {}): void {
  const allow = opts.allow ?? [];
  const allowBadResponses = opts.allowBadResponses ?? [];
  const isAllowed = (text: string) => allow.some((rx) => rx.test(text));

  const matchesAllowedBadResponse = (url: string, status: number): boolean =>
    allowBadResponses.some((rule) => {
      if (rule.status !== status) return false;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.hostname !== rule.hostname) return false;
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(parsed.pathname);
      } catch {
        decodedPath = parsed.pathname;
      }
      return decodedPath === rule.path;
    });

  const badResponses = collected.badResponses.filter(
    (r) => !isAllowed(r.url) && !matchesAllowedBadResponse(r.url, r.status),
  );
  // Exactly as many generic "Failed to load resource" console.error
  // messages are excused as there are legitimately allowed bad
  // responses this run -- never more, never based on text pattern alone.
  let genericBudget = collected.badResponses.length - badResponses.length;

  const consoleErrors = collected.consoleErrors.filter((m) => {
    if (isAllowed(m)) return false;
    if (m === GENERIC_RESOURCE_404_CONSOLE_TEXT && genericBudget > 0) {
      genericBudget -= 1;
      return false;
    }
    return true;
  });

  const pageErrors = collected.pageErrors.filter((m) => !isAllowed(m));
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
