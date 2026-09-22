// TEMPORARY DIAGNOSTIC INSTRUMENTATION -- added to answer a single question:
// which DOM element / code path issues the 4 known suspicious requests seen
// during the staging smoke run, without ever printing page source, env vars,
// Supabase config, or request headers/cookies/authorization to CI stdout.
//
// REMOVE this file and its call site in specs/smoke.spec.ts once the root
// cause is proven and either fixed, or explicitly approved (in a SEPARATE
// change) for an allow-list. Do not let this ship as part of the real
// quality gate.
//
// Safe-logging contract enforced throughout this file:
//   - never print request headers, cookies, or Authorization values
//   - never print document.documentElement.outerHTML or full page source
//   - never print inline <script> contents
//   - only print the 4 known suspicious literal strings and metadata about
//     the single DOM element / network event that touches them

import type { Page, CDPSession } from '@playwright/test';

export const SUSPICIOUS_VALUES = [
  '${_escHtml(safeUrl)}',
  '${_escHtml(b.image)}',
  '${_iUrl}',
  'x',
] as const;
// Matches a request URL path against one of the 4 known suspicious cases.
function matchSuspicious(url: string): string | null {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    for (const v of SUSPICIOUS_VALUES) {
      if (v === 'x') {
        if (path === 'x') return v;
      } else if (path === v || path.endsWith(v)) {
        return v;
      }
    }
  } catch {
    /* ignore unparsable URLs */
  }
  return null;
}

function safeDiagLog(tag: string, data: Record<string, unknown>) {
  console.log(`[DIAG:${tag}] ${JSON.stringify(data)}`);
}

export async function attachSuspiciousRequestDiagnostics(page: Page, browserName: string) {
  let domContentLoadedAt: number | null = null;
  let loadAt: number | null = null;
  const t0 = Date.now();

  page.on('domcontentloaded', () => {
    domContentLoadedAt = Date.now() - t0;
  });
  page.on('load', () => {
    loadAt = Date.now() - t0;
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[DIAG:page]')) {
      console.log(text);
    }
  });

  page.on('request', (request) => {
    const match = matchSuspicious(request.url());
    if (!match) return;
    safeDiagLog('pw-request', {
      matched: match,
      method: request.method(),
      resourceType: request.resourceType(),
      frameUrl: request.frame().url(),
      tMs: Date.now() - t0,
      beforeDomContentLoaded: domContentLoadedAt === null,
      beforeLoad: loadAt === null,
    });
  });
  let cdp: CDPSession | null = null;
  if (browserName === 'chromium') {
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (params: any) => {
        const match = matchSuspicious(params.request?.url || '');
        if (!match) return;
        const initiator = params.initiator || {};
        safeDiagLog('cdp-initiator', {
          matched: match,
          url: params.request?.url,
          method: params.request?.method,
          documentURL: params.documentURL,
          tMs: Date.now() - t0,
          initiatorType: initiator.type,
          initiatorUrl: initiator.url,
          initiatorLineNumber: initiator.lineNumber,
          initiatorColumnNumber: initiator.columnNumber,
          initiatorStack: initiator.stack
            ? initiator.stack.callFrames?.map((f: any) => ({
                functionName: f.functionName,
                url: f.url,
                lineNumber: f.lineNumber,
                columnNumber: f.columnNumber,
              }))
            : null,
        });
      });
    } catch (e) {
      safeDiagLog('cdp-unavailable', { error: String(e) });
    }
  }
  await page.addInitScript((suspicious: string[]) => {
    const TAG = '[DIAG:page]';
    function truncate(s: string, n = 300) {
      return s.length > n ? s.slice(0, n) + `...(${s.length} chars total)` : s;
    }
    function describeElement(el: Element) {
      const parent = el.parentElement;
      return {
        tagName: el.tagName,
        id: (el as HTMLElement).id || null,
        className: (el as HTMLElement).className || null,
        srcAttr: el.getAttribute('src'),
        hrefAttr: el.getAttribute('href'),
        outerHTMLTruncated: truncate(el.outerHTML || ''),
        isConnected: (el as any).isConnected === true,
        parent: parent
          ? { tagName: parent.tagName, id: parent.id || null, className: parent.className || null }
          : null,
      };
    }
    function isSuspiciousValue(v: string | null): string | null {
      if (v == null) return null;
      for (const s of suspicious) {
        if (s === 'x' ? v === 'x' : v === s || v.endsWith(s)) return s;
      }
      return null;
    }
    function scanDom(label: string) {
      try {
        const nodes = Array.from(
          document.querySelectorAll('img[src*="${"], img[src="x"], script[src*="${"], link[href*="${"]'),
        );
        for (const el of nodes) {
          console.log(`${TAG}:dom-scan:${label} ${JSON.stringify(describeElement(el))}`);
        }
      } catch (e) {
        console.log(`${TAG}:dom-scan-error ${String(e)}`);
      }
    }
    document.addEventListener('DOMContentLoaded', () => scanDom('DOMContentLoaded'));
    window.addEventListener('load', () => scanDom('load'));
    window.addEventListener(
      'error',
      (ev) => {
        const target = ev.target as Element | null;
        if (!target || !('tagName' in target)) return;
        const tag = target.tagName;
        if (tag !== 'IMG' && tag !== 'SCRIPT' && tag !== 'LINK') return;
        const val =
          (target as any).src || target.getAttribute?.('src') || target.getAttribute?.('href');
        let pathOnly: string | null = null;
        if (val) {
          try {
            pathOnly = new URL(val, location.href).pathname.replace(/^\/+/, '');
          } catch {
            pathOnly = val;
          }
        }
        const matched = isSuspiciousValue(pathOnly);
        if (!matched) return;
        console.log(`${TAG}:resource-error ${JSON.stringify({ matched, ...describeElement(target) })}`);
      },
      true,
    );
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (origSrcDesc && origSrcDesc.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...origSrcDesc,
        set(this: HTMLImageElement, value: string) {
          const matched = isSuspiciousValue(value);
          if (matched) {
            console.log(
              `${TAG}:src-setter ${JSON.stringify({ matched, value, stack: new Error().stack })}`,
            );
          }
          origSrcDesc.set!.call(this, value);
        },
      });
    }

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      if ((name === 'src' || name === 'href') && isSuspiciousValue(value)) {
        console.log(
          `${TAG}:setAttribute ${JSON.stringify({ name, value, tagName: this.tagName, stack: new Error().stack })}`,
        );
      }
      return origSetAttribute.call(this, name, value);
    };
  }, SUSPICIOUS_VALUES as unknown as string[]);

  return { cdp };
}
