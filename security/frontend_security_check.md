# TeachyaED — Frontend security static check

Companion to `SECURITY_BASELINE.md` §19-22, §27. Run `security/frontend_security_check.js` against the deployed `index.html` (pinned to a commit SHA, per `SECURITY_BASELINE.md` §23 — never trust a CDN-cached fetch) before a release that touches call/notify/exercise-sync code, or as part of `security/RELEASE_SECURITY_TEMPLATE.md`'s "Frontend baseline" field.

```
node security/frontend_security_check.js <path-to-index.html-or-URL>
```

## What is reliably automated (exact string-anchor checks, not fuzzy regex)

These check for the presence of specific, known call sites and confirm each one still carries `{config:{private:true}}`. A known call site is matched by an exact literal substring taken from the current source (the same anchors used to apply the private-channel patch in Security Audit v10) — if the surrounding code is refactored enough that the anchor no longer matches, the check reports the anchor as **NOT FOUND**, not a silent pass. A missing anchor is itself signal: it means this script is stale and needs a maintainer to update its anchors alongside the refactor, and the "Frontend baseline" field in the release report must fall back to a full manual review for that release.

Checked:

- All known Broadcast channel-creation sites (`notify-<profileId>` receiver, `notify-<ringId>` sender, bulk class-ring sender, both decline senders, hangup channel, exsync channel) still carry `{config:{private:true}}`.
- `S.notifyBroadcastChannel` and the `notify-pg-` topic prefix are both still present — i.e. the private-Broadcast / plain-Postgres-Changes split from Security Audit v10 has not been silently collapsed back into one mixed channel.
- The old, disproven direct-payload ring handler pattern (`({payload})=>handleIncomingCall(payload)`) has not been reintroduced.

## What is explicitly NOT reliably automated — MANUAL CHECK required

**`lvSyncInit()` / `roomKey` format changes.** The script greps for the 4 known format literals (`'ls_'+`, `'hw_'+`, `'as_'+assignId`, the raw `class_live.room_id` fallback) near `lvSyncInit(` call sites and reports whether they still look present. This is advisory only, not authoritative: a grep can confirm a known string is *still there*, but it cannot confirm that no *new* roomKey format was added, or that a changed truncation length still matches `exsync_authorized()`'s prefix-matching assumption. Writing a "smarter" parser for this would create false confidence — a regex cannot understand the actual semantics of a truncation scheme well enough to certify it's still correct.

**If this check reports the roomKey formats look unchanged:** still manually re-read `lvSyncInit()` against `SECURITY_BASELINE.md` §21 before any release that touches it, and confirm `exsync_authorized()` / `realtime_exsync_select` / `realtime_exsync_insert` were reviewed in the same change if `lvSyncInit()` changed at all.

**If this check reports the roomKey formats look different from baseline:** still manually re-read `lvSyncInit()` against `SECURITY_BASELINE.md` §21 before any release that touches it, and confirm `exsync_authorized()` / `realtime_exsync_select` / `realtime_exsync_insert` were reviewed in the same change if `lvSyncInit()` changed at all.

**Whether Broadcast payload fields are genuinely never used as authoritative identity anywhere in the frontend** (§22) is not automated at all here — it requires reading every consumer of a Broadcast `payload` object, including ones this script doesn't know to look for yet. Treat as MANUAL CHECK on any release touching call/notify code.
