# TeachyaED — Release Security Report

Copy this template once per release. Fill in every field. Do not delete sections — mark `NOT RUN` / `N/A` explicitly with a reason instead of omitting them.

```
Release:
Commit:
Date:

Database baseline: PASS/FAIL
Frontend baseline: PASS/FAIL
Storage baseline: PASS/FAIL
Realtime baseline: PASS/FAIL

Runtime staging regression: PASS/FAIL/NOT RUN

Security-relevant changes:
- ...

Baseline deviations:
- ...

New security assumptions:
- ...

Unresolved findings:
- ...

Release security status:
PASS / BLOCKED
```

## How to fill each field

**Database baseline** — run `security/security_baseline.sql` fresh against the target database (staging first, then production post-deploy) and read every row. `PASS` only if every row is `PASS`. Any `FAIL` row → this field is `FAIL`, quote the failing check verbatim under "Baseline deviations."

**Frontend baseline** — see `security/frontend_security_check.md`. Run whatever is automated there against the deployed commit SHA; for the parts marked MANUAL CHECK, a human must actually re-read the relevant source per §21/§22 of `SECURITY_BASELINE.md` and record the result here. `PASS` requires both the automated part and the manual part to pass.

**Storage baseline** — confirm bucket public/private status matches `SECURITY_BASELINE.md` §14-17 (materials intentionally public for course content, chat-files private, no intended-private object living in a public bucket), and that `storage.objects` policies for both buckets are present (covered by `security_baseline.sql`, but re-read the actual policy predicates, not just "a policy exists").

**Realtime baseline** — confirm the 6 `realtime.messages` policies (`security_baseline.sql`) plus, if this release touches Broadcast, that every security-sensitive channel (`notify-<profileId>`, `<roomId>`, `exsync-<roomKey>`, and any new one) uses `{config:{private:true}}` on both sender and receiver sides.

**Runtime staging regression** — run the "Runtime Security Regression" plan below on staging, with at least two real accounts. `NOT RUN` is only acceptable when this release does not touch any call/chat/exercise-sync/Storage-upload surface, and that fact is stated explicitly under "Security-relevant changes." Never mark `NOT RUN` for a release that does touch those surfaces.

**Security-relevant changes** — plain list of what changed that this document's invariants care about: new tables, new RLS, new Realtime channels/publications, new Storage buckets/paths, new SECURITY DEFINER functions, changes to `invite-user`/`delete-user`/`daily-room`, changes to `lvSyncInit()` or any roomKey format.

**Baseline deviations** — anything `security_baseline.sql` or the manual checks found that does not match `SECURITY_BASELINE.md`. If this list is non-empty: **stop, do not release, report the drift** for a dedicated security review (see `SECURITY_BASELINE.md` §29). Do not "fix and ship" in the same pass.

**New security assumptions** — anything this release adds to the trusted set (e.g. a new server-derived identity source, a new trigger, a new authoritative relation). These should usually also become new invariants in `SECURITY_BASELINE.md`, in the same review.

**Unresolved findings** — anything known-imperfect that is being shipped anyway, with the reasoning for why it's acceptable for this release.

## Release security status rule

```
FAIL in any mandatory baseline check → BLOCKED
```

`Database baseline`, `Frontend baseline`, `Storage baseline`, and `Realtime baseline` are all mandatory whenever the release touches the relevant surface. `Runtime staging regression = NOT RUN` is acceptable **only** when explicitly justified as above; otherwise treat a missing/skipped run the same as `FAIL`.

---

## Runtime Security Regression (staging only — never production)

Requires at least two accounts on a staging/test environment (`student A`, `student B`, `teacher` recommended). Never run against production data. Record `EXPECTED` / `ACTUAL` / `PASS-FAIL` per row.

| # | Scenario | Expected |
|---|---|---|
| 1 | Teacher rings student A (legitimate) | Ring received by A, identity shown matches teacher's real profile |
| 2 | Student A answers | Call connects, both sides join the correct Daily room |
| 3 | Student A declines an incoming ring | Caller's UI reflects decline, no call state leaks |
| 4 | Either party hangs up | Both sides leave, `call_room_participants` no longer authorizes further signals for that room past hangup |
| 5 | Student B attempts to subscribe to `notify-<A's profile id>` | DENIED — no delivery of A's ring/decline events to B |
| 6 | Student B attempts to send `hangup` on a room they are not a participant of | DENIED — no effect on the real participants' call |
| 7 | Teacher and enrolled student sync an exercise in a live lesson | Both sides see the same live state |
| 8 | Student B (not enrolled in that class) attempts to subscribe to that lesson's `exsync-<roomKey>` | DENIED |
| 9 | Student B attempts to send an exsync event into that lesson's channel | DENIED — no effect on the real lesson's state |
| 10 | Student A opens a chat attachment in a conversation they're a member of | Loads normally |
| 11 | Student A attempts to open/guess a chat attachment path from a conversation they're not a member of | DENIED |
| 12 | Student A attempts a direct Storage upload to the `materials` bucket | DENIED, independent of what any UI button does |

This closes the evidence gap explicitly left open after Security Audit v10:

```
Call-flow regression: NOT VERIFIED (no second live account)
Exercise-sync regression: NOT VERIFIED (no second live account)
```

Until this plan has actually been run at least once, treat both of those as still open evidence gaps — `security_baseline.sql` and code review give strong static confidence (`DEPLOYED SOURCE VERIFIED` + `SQL CONTEXT VERIFIED` + `CODE ANALYSIS PROTECTED`), but not the same thing as a real multi-account runtime pass.
