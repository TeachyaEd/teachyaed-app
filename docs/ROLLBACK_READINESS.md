# Calling System Rollback Readiness

_Last updated: 2026-09-25. Read-only investigation; no production changes made while producing this document._

## Current production working pair (validated, live)

- **Client**: `main:index.html` @ commit `e46577a` ("FORWARD-FIX: redeploy validated call_attempts client (index.html @ 5c4a173)"), byte-identical to `5c4a173` on `call-attempts-architecture`.
- **Edge Function**: `daily-room` **v6**, production-only CORS (`https://teachyaed.github.io`), issuer `https://juwvlyrepwdcndkqiqna.supabase.co/auth/v1`.
- **DB**: `call_attempts` table + 5 SECURITY DEFINER RPCs (`start_call`/`accept_call`/`decline_call`/`end_call`/`fail_call`), additive `realtime.messages` policies (`call_room_broadcast_insert`/`select`), plus `GRANT SELECT ON public.call_room_participants TO authenticated` (2026-09-25 fix for the `realtime_room_select`/`insert` permissive-policy evaluation issue).
- Forward (teacher→student) and reverse (student→teacher) production smoke both passed on this exact pair.

**This client/Edge-Function pair is the only known-good production combination. It should not be changed without going through the same controlled process used to establish it.**

## Legacy client incompatibility (proven, not theoretical)

`75fab4e` (the pre-`call_attempts` production client) is **deterministically incompatible** with `daily-room v6`. Its only `daily-room` call site sends `{"roomId":...}` with no `attemptId` field, unconditionally, for every 1:1 call in both directions — confirmed via full source trace (`sb.functions.invoke('daily-room',{body:{roomId}})`, no `attemptId` anywhere in the file) and via production Realtime/Edge Function logs showing a 100% correlation between missing `attemptId` (41-byte request bodies) and HTTP 400 from `daily-room v6`, across both users, both directions, repeatedly, on 2026-09-25.

**Do not roll the client back to `75fab4e` while `daily-room v6` remains deployed.** That combination is proven broken for all 1:1 calling, not a hypothetical risk.

## Safe rollback rule

A client rollback to `75fab4e` (or any pre-`call_attempts` client) is **only safe if a compatible true `daily-room v5`** (the `call_signals`/`call_room_participants`-based Edge Function that `75fab4e` was built against) **is restored to production first, in the same maintenance window, before the client changes.** Never roll back the client alone.

## Missing rollback asset: exact `daily-room v5` source

**`daily-room v5`'s exact deployed source is not recoverable.** Confirmed via three independent read-only checks on 2026-09-25:

1. **Supabase dashboard**: the Edge Functions UI (`/functions/daily-room/details`) offers a "Download" of the *currently deployed* function only. There is no version-history browser; deploying v6 overwrote v5's source with no retained snapshot.
2. **`main` branch**: `git ls-tree` (via GitHub API, recursive) contains no `supabase/functions/daily-room` path or any Edge Function source file anywhere in the tree — Edge Functions in this project were always deployed ad hoc via the Supabase dashboard's in-browser editor, never via `supabase functions deploy` from a repo-tracked file.
3. **`call-attempts-architecture` branch**: same check, same result — no tracked Edge Function source on this branch either.

Consequently: **reconstructing v5 from memory or description is explicitly out of scope** (per standing instruction) because there is no way to verify a reconstruction's authorization logic against the real deployed original. Until a verified v5 source is obtained by some other means (e.g. a local backup the account owner may hold outside this repo, or Supabase support/audit-log access this session does not have), **there is no safe path to revert the Edge Function to v5**, and therefore no safe path to revert the client to `75fab4e`.

## Additive DB objects: rollback constraint

`call_attempts`, its 5 RPCs, its `SELECT` grants, its Realtime publication membership, and the two additive `call_room_broadcast_*` policies **must never be dropped as part of an emergency rollback.** They are inert (harmless) if the client/Edge-Function pair is ever reverted to a pre-`call_attempts` combination; dropping them destroys data and forecloses forward-fixing. The only path back to `call_signals`-based calling, if ever needed, is client+Edge-Function revert together — not a DB rollback.

## Emergency fallback if a critical *unrelated* regression is found in the current client

Per standing instruction: the safe fallback is to **temporarily disable the 1:1 calling UI** in the current client (feature-flag or hide the call entry points) while investigating, **not** to restore the known-incompatible `75fab4e`/`daily-room v6` combination. That combination has zero working 1:1 calling by design; it is strictly worse than a temporarily-disabled calling feature on an otherwise-working client.

## Summary decision table

| Scenario | Safe action |
|---|---|
| Critical bug found in current client/v6 pair, unrelated to calling | Fix forward on current pair, or temporarily disable calling UI only |
| Critical bug found specifically in `call_attempts`/`daily-room v6` calling logic | Fix forward (this pair is the only validated one); do not revert to `75fab4e` |
| Desire to revert to pre-`call_attempts` architecture entirely | Blocked — requires a verified `daily-room v5` source that does not currently exist anywhere recoverable |
| Any rollback scenario | Never drop `call_attempts`/RPCs/grants/publication/additive Realtime policies |
