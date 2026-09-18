# TeachyaED — React/TypeScript Migration Plan (Discovery Output)

Companion to `MIGRATION_INVENTORY.md` (facts) and `SECURITY_BASELINE.md` (invariants this plan must not violate). This document is a **plan**, not code — no migration work has started. Per the requester's explicit instruction, PHASE 2+ does not begin until this plan is reviewed and approved.

## Strategy: strangler migration, not a rewrite

Legacy `index.html` and the new React app run side by side against the same Supabase backend, same tables, same RLS, same Realtime channels, same Edge Functions. Nothing in the backend changes to accommodate the migration — the frontend is the only thing moving. Cutover happens feature-by-feature; legacy and React must be able to coexist indefinitely if a slice stalls.

## Target architecture

React + TypeScript + Vite + `@supabase/supabase-js`. No Redux by default — React state, Context, and custom hooks, plus a thin domain-services layer so UI components stay presentational.

```
src/
  app/{router,providers,guards}
  features/{auth,dashboard,profile,students,staff,classes,lessons,homework,schedule,materials,chat,calls,live-lessons,admin}
  components/{ui,layout}
  services/{supabase,realtime,storage,daily}
  hooks/
  lib/
  types/
tests/{unit,e2e}
docs/
security/
```

No monolithic `App.tsx` — routing/guards live in `app/`, each feature owns its own state and UI.

Domain services (`authService`, `studentService`, `classService`, `lessonService`, `homeworkService`, `chatService`, `callService`, `storageService`) wrap Supabase calls (`.from()`, `.rpc()`, `.functions.invoke()`, and the two raw-`fetch()` Edge Function calls found in the inventory — both calling conventions get one consistent wrapper going forward) so components never talk to Supabase directly.

Auth contract carried forward unchanged: `auth.uid() → profiles → school_id/role` is the only authoritative identity chain. Route guards in `app/guards` are UX convenience only — they hide nav items and redirect, they are never the actual security boundary. RLS remains the real boundary, exactly as in the legacy app and exactly as documented in `SECURITY_BASELINE.md`.

Realtime invariants carried forward unchanged, enforced by a `services/realtime` wrapper so every feature gets them automatically instead of re-implementing per channel: every security-sensitive Broadcast channel (`notify-*`, room/call channels, `exsync-*`) is created with `{config:{private:true}}`; Broadcast payload is never treated as authoritative identity, even on a private channel; the `exsync_authorized()` / `roomKey` prefix-matching contract and the `call_signals → enforce_call_signal_identity → record_call_room_participants → daily-room` chain are not touched.

## 8-phase roadmap

- **PHASE 0 — Discovery.** This document + `MIGRATION_INVENTORY.md`. Complete pending your review.
- **PHASE 1 — Staging + CI.** Blocked today — see Staging section below. Must exist before any feature touching Realtime/calls/Storage/RLS-sensitive writes is cut over to React in production.
- **PHASE 2 — React foundation.** Vite + TS scaffold, `services/supabase` client, `auth` feature + route guards, deployed alongside legacy at a separate path/subdomain, doing nothing user-facing yet. No production cutover in this phase.
- **PHASE 3 — Low-risk features.** Schedule, PD module, exercise-checker utilities (pure functions), Materials (read/browse first, then upload). These have no Realtime dependency and narrow RLS surfaces — best first real cutover candidates.
- **PHASE 4 — Chat / Storage.** Messenger + lesson chat + `chat-files`/`materials` Storage flows. Moderate risk (private bucket, Realtime present but not identity-sensitive Broadcast).
- **PHASE 5 — Realtime abstraction hardening.** Build and test the `services/realtime` private-channel wrapper against the low/moderate-risk channels already migrated in Phases 3-4 before it's trusted with calls/exsync.
- **PHASE 6 — Calls + Live Lessons + Exercise Sync (highest risk, last).** Requires the full 12-scenario mixed-client (legacy caller × React callee, all 4 combinations, teacher/student roles) regression pass from `RELEASE_SECURITY_TEMPLATE.md` on staging before any production traffic touches it.
- **PHASE 7 — Canary + cutover.** Percentage-based or per-school rollout, legacy kept deployable as instant rollback until React has run in production for calls/live-lessons through at least one full week of real usage without a security-relevant regression.

## Deployment/CI discipline (carried forward)

Same verification discipline that applied throughout the security audits applies to every migration commit: never trust "commit created" as proof — verify via the GitHub API after each deploy. After any change that touches the DB surface, re-run `security/security_baseline.sql`. After any change that touches Broadcast/notify/exsync code, re-run `security/frontend_security_check.js` against the deployed commit SHA (fetched via Contents API, not raw.githubusercontent.com). `security/RELEASE_SECURITY_TEMPLATE.md` is filled out for every release from PHASE 3 onward, same as it will be for legacy releases now.

## First safe migration slice (proposed)

**Schedule feature**, ported to `features/schedule` behind a feature flag / separate route, running alongside the legacy Schedule screen. Rationale: no Realtime, no privileged writes beyond the signed-in user's own school's events, small function surface (`renderSchedule, openAddEventOnDate, saveEvent, deleteEvent, exportICal`), easy to demo working end-to-end against production data without any security-model change, and a clean template for the domain-services + feature-folder pattern before tackling anything Realtime-dependent.

This does not require PHASE 1 (staging) to *start* scaffolding, but production cutover of even this low-risk slice should wait until a staging environment exists, per the blocker below — legacy stays authoritative for Schedule until then.

## Blockers

1. **No staging Supabase project and no CI pipeline exist today.** All deploys are manual GitHub web-upload commits directly to `main`, which GitHub Pages then serves. This blocks PHASE 1 by definition and blocks PHASE 6 (calls/live-lessons) entirely — production must never substitute for staging on the identity-sensitive mixed-client regression tests. See `STAGING.md` for what's needed to unblock this.
2. **No automated test suite of any kind exists** for the legacy frontend, so there's no regression baseline to diff React output against beyond manual/staging QA.

Neither blocker prevents PHASE 0 (this document) or the early scaffolding part of PHASE 2 — they gate production cutovers, not planning or local development.
