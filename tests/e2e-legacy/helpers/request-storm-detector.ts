import type { Page, WebSocket } from '@playwright/test';

// Generic HTTP request-storm detector: flags any URL-key firing more
// than `maxPerWindow` times inside a sliding `windowMs` window. Tune
// the thresholds once real staging behavior has been observed in the
// first live run -- these defaults are a starting point, not a
// verified-correct baseline.

export interface StormDetectorOptions {
  windowMs?: number;
  maxPerWindow?: number;
  keyFn?: (url: string) => string;
}

export interface StormDetector {
  events: { key: string; url: string; ts: number }[];
  getCounts(): Record<string, number>;
  assertNoStorm(): void;
}

export function attachRequestStormDetector(page: Page, opts: StormDetectorOptions = {}): StormDetector {
  const windowMs = opts.windowMs ?? 10_000;
  const maxPerWindow = opts.maxPerWindow ?? 8;
  const keyFn = opts.keyFn ?? ((url: string) => url.split('?')[0]);

  const events: { key: string; url: string; ts: number }[] = [];
  page.on('request', (req) => {
    events.push({ key: keyFn(req.url()), url: req.url(), ts: Date.now() });
  });

  return {
    events,
    getCounts() {
      const now = Date.now();
      const counts: Record<string, number> = {};
      for (const e of events) {
        if (now - e.ts <= windowMs) counts[e.key] = (counts[e.key] || 0) + 1;
      }
      return counts;
    },
    assertNoStorm() {
      const counts = this.getCounts();
      const offenders = Object.entries(counts).filter(([, c]) => c > maxPerWindow);
      if (offenders.length > 0) {
        throw new Error(
          `Request storm detected (>${maxPerWindow} requests/${windowMs}ms):\n` +
            offenders.map(([k, c]) => `  ${k}: ${c} requests`).join('\n'),
        );
      }
    },
  };
}

// Supabase Realtime duplicate-subscription detector. Watches Phoenix
// channel-join frames on the websocket connection and flags a second
// "phx_join" to the same topic that isn't preceded by a "phx_leave" --
// i.e. a genuine duplicate subscription, not a legitimate resubscribe
// after an intentional leave (e.g. on logout/navigation).

export interface RealtimeSubscriptionTracker {
  joinsByTopic: Map<string, number>;
  leavesByTopic: Map<string, number>;
  duplicateJoinEvents: { topic: string; ts: number }[];
  assertNoDuplicateSubscriptions(): void;
}

export function attachRealtimeSubscriptionTracker(page: Page): RealtimeSubscriptionTracker {
  const joinsByTopic = new Map<string, number>();
  const leavesByTopic = new Map<string, number>();
  const duplicateJoinEvents: { topic: string; ts: number }[] = [];
  const openTopics = new Set<string>();

  const handleFrame = (raw: string) => {
    // Phoenix wire format: [join_ref, ref, topic, event, payload]
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length < 4) return;
    const [, , topic, event] = parsed as [unknown, unknown, string, string];
    if (typeof topic !== 'string') return;

    if (event === 'phx_join') {
      joinsByTopic.set(topic, (joinsByTopic.get(topic) ?? 0) + 1);
      if (openTopics.has(topic)) {
        duplicateJoinEvents.push({ topic, ts: Date.now() });
      }
      openTopics.add(topic);
    } else if (event === 'phx_leave' || event === 'phx_close') {
      leavesByTopic.set(topic, (leavesByTopic.get(topic) ?? 0) + 1);
      openTopics.delete(topic);
    }
  };

  page.on('websocket', (ws: WebSocket) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string') handleFrame(f.payload);
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string') handleFrame(f.payload);
    });
  });

  return {
    joinsByTopic,
    leavesByTopic,
    duplicateJoinEvents,
    assertNoDuplicateSubscriptions() {
      if (duplicateJoinEvents.length > 0) {
        throw new Error(
          `Duplicate Realtime subscription(s) detected (phx_join to an already-open topic without an intervening phx_leave):\n` +
            duplicateJoinEvents.map((e) => `  topic=${e.topic}`).join('\n'),
        );
      }
    },
  };
}
