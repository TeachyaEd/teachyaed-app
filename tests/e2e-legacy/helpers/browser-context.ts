import type { Browser, BrowserContext, Page } from '@playwright/test';

// Two isolated browser contexts (separate cookie jars / storage / auth
// sessions) for scenarios that need two logged-in parties at once --
// teacher<->student calls, incoming-call-while-on-a-second-tab, etc.
// Each party gets its own context so login state never leaks between
// them, matching two real people on two real devices.

export interface PartyContext {
  context: BrowserContext;
  page: Page;
}

export interface TwoPartySession {
  caller: PartyContext;
  callee: PartyContext;
  closeAll(): Promise<void>;
}

export async function createTwoPartyContexts(browser: Browser): Promise<TwoPartySession> {
  const callerContext = await browser.newContext();
  const calleeContext = await browser.newContext();
  const callerPage = await callerContext.newPage();
  const calleePage = await calleeContext.newPage();

  return {
    caller: { context: callerContext, page: callerPage },
    callee: { context: calleeContext, page: calleePage },
    async closeAll() {
      await Promise.all([callerContext.close(), calleeContext.close()]);
    },
  };
}
