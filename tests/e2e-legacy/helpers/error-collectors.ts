import type { Page, Request } from '@playwright/test';

// Generic console/page-error/network-failure collector for the legacy
// monolith. Attach once per page, assert at the end of a test (or after
// a specific action) so failures point at what actually happened rather
// than requiring the test author to guess every failure mode up front.

export interface CollectedErrors {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: { url: string; method: string; failure: string; respondedStatus?: number }[];
  badResponses: { url: string; status: number }[];
}

export function attachErrorCollectors(page: Page): CollectedErrors {
  const collected: CollectedErrors = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    badResponses: [],
  };

  // Tracks the HTTP status of the 'response' event for each request, so a
  // later 'requestfailed' handler for that same request can tell whether a
  // response was actually received before the failure. This is the
  // evidence AllowedRequestFailure below requires -- see its doc comment
  // for the one documented case this exists for. Confirmed event order for
  // that case (Chromium reporting net::ERR_ABORTED on an already-answered
  // 204 request): 'request' -> 'response' -> 'requestfailed', and
  // 'requestfinished' never fires. Keyed on the live Request object via a
  // WeakMap so entries are released once a request is GC'd; never read
  // anywhere outside this file.
  const respondedStatusByRequest = new WeakMap<Request, number>();

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
      method: req.method(),
      failure: req.failure()?.errorText ?? 'unknown',
      respondedStatus: respondedStatusByRequest.get(req),
    });
  });

  page.on('response', (res) => {
    respondedStatusByRequest.set(res.request(), res.status());
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

// A single, exact, structured exception for one specific request that
// fails *after* it already received a response. Deliberately NOT a regex
// and deliberately NOT a general requestfailed allow-list: every field
// must match exactly, including the exact HTTP status the request itself
// received, so this can never silently widen to cover a different URL,
// method, failure text, or -- critically -- a request that never received
// a response at all. A request with no response is always treated as a
// real failure: see the mandatory check in assertNoUnexpectedErrors below,
// which is not something any field on this interface can bypass.
//
// The one documented case this exists for: Chromium's network stack
// reports `net::ERR_ABORTED` via the CDP 'requestfailed' event for a
// fetch that already received an HTTP 204 No Content response -- purely a
// Chromium/CDP-level artifact of how 204 responses are handled, not a
// real failure. The page's own fetch() promise resolves normally and the
// app proceeds correctly; this is a confirmed, independently reported
// upstream Chromium/Playwright behavior, not an app defect:
//   - https://github.com/microsoft/playwright/issues/42786
//     ("browser_click takes ~5s longer when the click's fetch gets a 204
//     No Content")
//   - https://github.com/microsoft/playwright/pull/42787
//     ("Chromium ends a fetch answered with 204 No Content in
//     Network.loadingFailed (net::ERR_ABORTED), even though the page's
//     fetch resolves normally. The request emits response, then
//     requestfailed.")
// Playwright 1.48.0 (pinned by this suite's package.json) predates the fix
// proposed in that PR (still open/unmerged as of Sep 2026), and in this
// version Response.finished() only resolves on 'requestfinished' -- never
// on 'requestfailed' -- so it cannot be used to wait past this failure;
// see the 2026-09-23 diagnosis note in helpers/auth.ts (logout()) for the
// full event-order evidence and why response.finished() was tried once
// and reverted.
//
// Supabase's own GoTrue /auth/v1/logout endpoint returns 204 No Content on
// a successful logout, which is exactly this case. This exception is
// intentionally applied only in specs/p0-teacher-student.spec.ts, which is
// the only spec that calls logout(). specs/smoke.spec.ts's own allow-list
// (a separate, pre-existing AllowedBadResponse case) is untouched by this
// change and must never gain this exception.
export interface AllowedRequestFailure {
  method: string; // exact match, e.g. 'POST'
  url: string; // exact match, full URL including query string
  failure: string; // exact match, e.g. 'net::ERR_ABORTED'
  requireRespondedStatus: number; // exact HTTP status the request's own
  // 'response' event must have reported. Not optional: a request that
  // never received any response can never match by omitting this field.
}

export interface AssertOptions {
  // Regexes matched against console/page-error text or request URLs;
  // matches are ignored. Use sparingly and only for genuinely expected
  // noise (e.g. a known third-party script warning) -- never to hide a
  // real bug. Prefer allowBadResponses/allowRequestFailures (below) for
  // known bad HTTP responses or known post-response request failures,
  // since both are exact/structured rather than pattern-based.
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
  // Exact, structured exceptions for a request that fails after already
  // receiving a response on the same request. See AllowedRequestFailure
  // above -- deliberately separate from `allow` (regex) and
  // `allowBadResponses` (bad HTTP status on a successful response), since
  // this covers a distinct failure shape with its own required evidence
  // (a prior 'response' event for the exact same request). All other
  // request failures -- in particular any with no prior response at all --
  // are unaffected and remain fatal.
  allowRequestFailures?: AllowedRequestFailure[];
}

const GENERIC_RESOURCE_404_CONSOLE_TEXT =
  '[console.error] Failed to load resource: the server responded with a status of 404 (Not Found)';

export function assertNoUnexpectedErrors(collected: CollectedErrors, opts: AssertOptions = {}): void {
  const allow = opts.allow ?? [];
  const allowBadResponses = opts.allowBadResponses ?? [];
  const allowRequestFailures = opts.allowRequestFailures ?? [];
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

  const matchesAllowedRequestFailure = (rf: CollectedErrors['requestFailures'][number]): boolean =>
    allowRequestFailures.some((rule) => {
      // Mandatory, cannot be bypassed by any rule field: a request failure
      // with no recorded response is always a real failure.
      if (rf.respondedStatus === undefined) return false;
      if (rf.respondedStatus !== rule.requireRespondedStatus) return false;
      if (rf.method !== rule.method) return false;
      if (rf.url !== rule.url) return false;
      if (rf.failure !== rule.failure) return false;
      return true;
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
  const requestFailures = collected.requestFailures.filter(
    (r) => !isAllowed(r.url) && !matchesAllowedRequestFailure(r),
  );

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
