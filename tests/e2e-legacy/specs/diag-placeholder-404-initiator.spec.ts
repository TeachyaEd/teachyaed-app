import { test } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { login, logout, requireTeacherCredentials } from '../helpers/auth';

// Diagnostic-only. No assertions about whether bad requests occur.
// Captures CDP-level request initiator data for the four known
// literal-placeholder request patterns.
//
// Does NOT touch p0-teacher-student.spec.ts or any product code.
// Reproduces only its existing teacher navigation/teardown steps.

const BAD_PATTERNS = [
  /\$\{_iUrl\}/,
  /\$\{_escHtml\(safeUrl\)\}/,
  /\$\{_escHtml\(b\.image\)\}/,
  /(^|\/)x($|\?)/,
];

function matchesBadPattern(rawUrl: string): boolean {
  let decodedPath = rawUrl;
  try {
    const u = new URL(rawUrl);
    decodedPath = decodeURIComponent(u.pathname);
  } catch {
    try {
      decodedPath = decodeURIComponent(rawUrl);
    } catch {
      decodedPath = rawUrl;
    }
  }
  return BAD_PATTERNS.some((re) => re.test(rawUrl) || re.test(decodedPath));
}

const OUT_FILE = process.env.DIAG_OUT_FILE || 'diag-initiator-capture.jsonl';

test('diag: capture initiator for literal-placeholder requests', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  cdp.on('Network.requestWillBeSent', (event: any) => {
    const url: string = event.request?.url || '';
    if (!matchesBadPattern(url)) return;

    const record = {
      ts: new Date().toISOString(),
      url,
      requestId: event.requestId,
      documentURL: event.documentURL,
      frameId: event.frameId,
      type: event.type,
      initiator: {
        type: event.initiator?.type,
        url: event.initiator?.url,
        lineNumber: event.initiator?.lineNumber,
        columnNumber: event.initiator?.columnNumber,
        stack: event.initiator?.stack
          ? JSON.stringify(event.initiator.stack)
          : undefined,
      },
    };

    appendFileSync(OUT_FILE, JSON.stringify(record) + '\n');
    console.log('[diag-initiator] MATCH', JSON.stringify(record));
  });

  const teacherCreds = requireTeacherCredentials();
  await login(page, teacherCreds);

  await page.waitForSelector('#evClassesGrid');
  await page.locator('.ev-class-card:not(.ev-class-create)').first().click();

  await page.waitForSelector('#classroomView.open');
  await page.waitForTimeout(5000);

  await page.getByRole('button', { name: /Выйти из урока/ }).click();
  await page.waitForSelector('#classroomView:not(.open)');
  await logout(page);
});
