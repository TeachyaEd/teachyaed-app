# TeachyaED — Security Baseline v1

This document describes the **current, permanent security invariants** of TeachyaED. It is not an audit log and does not describe history — it describes what must remain true in production, always, regardless of who is changing the code.

If you are a developer or an agent working on this codebase and you have never seen a prior audit report, this document is sufficient: it tells you what the security model *is*, and what you must re-verify before changing anything that touches it.

**Golden rule for this whole document:**

> **Client-controlled identifiers are never sufficient authorization.**

A client can *say* which object it wants (an id, a topic, a path, a room name). It can never be the thing that proves the caller is *allowed* to touch that object. Proof always comes from server-derived state.

---

## 1. Global tenant invariant

Tenant identity (which school a user belongs to) and role are derived **server-side only**, via this exact chain:

```
auth.uid()
→ profiles
→ school_id / role
```

The following are **never** trusted as an authorization source, even if they happen to be correct:

- `body.school_id`
- `body.role`
- `query.school_id`
- `path.school_id`
- room name
- topic name
- a profile UUID by itself
- an email address alone, where a stronger identity check is available
- Broadcast payload fields
- a Storage path supplied by the client

A client may pass an identifier to *select* which object it wants to act on. The server must independently prove the caller has rights to that specific object — via RLS, a trigger, or a security-definer function that re-derives identity from `auth.uid()`.

## 2. Role invariant

Four roles exist: `student`, `teacher`, `admin`, `owner`.

A privileged role is never created from:

- `raw_user_meta_data.role`
- a client-supplied `role` field on signup/request
- a client-supplied `school_id` field

Public self-signup always produces `student`. There is no public path to any other role.

Staff (teacher/admin/owner) accounts are only created through an authorized server-side provisioning flow (`invite-user`), which enforces:

- caller must be `admin` or `owner`
- `school_id` is derived from the caller's own server-side profile, never from the request
- the requested role is validated server-side
- a `teacher` cannot provision another `teacher` (or any staff role)
- cross-school provisioning is denied

Do not change this model without a dedicated security review.

## 3. RLS invariant

Every tenant/business table reachable by clients must have `RLS ENABLED`.

Policies must be reviewed **as a set**, never one at a time. Postgres `PERMISSIVE` policies combine with `OR` — a new policy cannot be proven safe without re-reading every existing policy on the same table and command. A locally-safe-looking policy can silently widen access when combined with an existing one.

After any RLS change, run a fresh catalog query and read the actual result — do not reason from what you intended to deploy:

```sql
SELECT *
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;
```

Sending a DDL statement is not evidence it took effect. See §24.

## 4. UPDATE rebinding invariant

If INSERT enforces a foreign-key/tenant relationship, UPDATE must preserve the same invariant. This applies in particular to:

`school_id`, `teacher_id`, `student_id`, `class_id`, `lesson_id`, `assignment_id`, `conversation_id`, `user_id`, `profile_id`, `room_id`.

INSERT authorization and UPDATE authorization are different checks and must be verified separately. A policy's `USING` clause protects which *existing* rows are visible/editable — it does **not** automatically protect what a client can rewrite those tenant/FK columns *to*. For UPDATE, protection must come from either:

- a `WITH CHECK` clause that re-validates the new row values, or
- a server-side trigger that makes the field immutable for the calling role.

## 5. Student self-service invariant

Student self-service UPDATE must never allow changing staff-controlled identity/ownership fields. Examples of the currently-correct model:

- `homeworks`: student may write `student_answer` and move `status` only `pending → submitted`.
- `lesson_assignments`: student may write `progress`, `completed`, `score` only within the intended submission flow.

Identity/tenant fields remain immutable for students. `students.teacher_id` and `students.school_id` are `admin`/`owner`-only, always.

## 6. Homework security

- student: `SELECT` own rows, `UPDATE` own rows only (`student_answer`, status transition `pending → submitted`), no `DELETE`.
- teacher/admin/owner: full school-scoped management, authorized.

A student must never be able to change: `school_id`, `teacher_id`, `student_id`, `title`, `description`, `deadline`, `teacher_comment`, `lesson_id`.

## 7. Lesson assignments / answers

A student only receives their own assignment/answer records, per the current intended model. For `lesson_answers`, authorization must check the full transitive chain:

```
answer → assignment → student → class/lesson → school
```

An `assignment_id` must never be accepted as authorized just because the client supplied a UUID that happens to exist — existence is not ownership.

## 8. Chat / conversations

`lesson_chat`: authorization = actual class/live-room membership; identity is always server-derived, never client-asserted.

A client must never be the authoritative source for: `user_id`, `user_role`, `user_name`, `school_id`, or room membership in chat.

`conversation_members` identity fields (`conversation_id`, `user_id`) are not rebinding-eligible via UPDATE.

Private chat attachments follow `conversation_members` membership — same-school membership alone is not sufficient.

## 9. Call security — identity

Authoritative call identity lives in `call_signals`. Identity fields (`from_name`, `from_role`, `from_profile_id`, etc.) are set server-side by the `enforce_call_signal_identity` trigger, which overwrites whatever the client sent using `auth.uid()` → `profiles`.

Broadcast payload fields (`from_name`, `from_role`, `room_id`) are never trusted as an identity or authorization source. Broadcast may be used as a wake-up/synchronization mechanism only. Authoritative identity must be re-read from trusted server state on receipt, not taken from the payload.

## 10. Call room authorization

1:1 room membership lives in `call_room_participants`, created only by a trusted trigger flow off `call_signals` (never written directly by a client).

For `call_room_participants`, from the client: `INSERT DENIED`, `UPDATE DENIED`, `DELETE DENIED` — always (RLS enabled, zero client-facing policies).

`daily-room` authorization requires all of: `room_id` + `auth.uid()` + `call_room_participants` membership + a bounded TTL. For class rooms, use the authoritative class/live membership relation instead.

Never implement (or reintroduce) authorization of the form "the room id contains a UUID fragment" or "knowing the room id means you're authorized." A room identifier is not a credential.

## 11. Call lifecycle invariant

`call_signals` is transient and must never be the sole proof of room membership. It is deleted by the client during incoming-call processing, potentially before the user has a chance to press Answer.

Durable authorization state is `call_room_participants`, which must outlive the transient signal for the duration of its TTL.

## 12. delete-user invariant

`delete-user` is fail-closed. This logic is explicitly forbidden:

```
if targetSchool exists and differs → deny
else → allow
```

A missing target school/profile never means "allowed." Absence of a check is not authorization.

The authorization ticket written after the first deletion step, `pending_user_deletions`, must be: server-written, caller-bound, school-bound, short-lived, single-use.

For `pending_user_deletions`, from the client: `INSERT DENIED`, `UPDATE DENIED`, `DELETE DENIED` — always.

## 13. SECURITY DEFINER baseline

For every `SECURITY DEFINER` function, review: owner, `SET search_path`, how it handles `auth.uid()`, role/school authorization inside the function body, its arguments, and its `EXECUTE` grants.

Being `authenticated` is never sufficient authorization for a privileged RPC by itself — the function body must still check role/school/ownership.

Trigger functions must not carry unnecessary `EXECUTE` grants to `PUBLIC`/`anon`/`authenticated`. Current hardened invariant: security-relevant trigger functions have **no direct client EXECUTE** (they are only reachable via trigger context).

## 14. Storage — materials

Bucket `materials` may remain public only for as long as its contents are genuinely intended-public course content.

Upload is teacher/admin/owner only, scoped to their own school's path. A student direct Storage upload must be denied regardless of what the UI allows and regardless of the `materials` table's own DB policy — DB security and Storage security are two independent authorization boundaries, and both must independently deny it.

## 15. Storage — chat files

Bucket `chat-files` is private. Authorization requires all of: caller's school + `conversation_id` path segment + actual `conversation_members` membership. Same-school membership alone is not sufficient.

Check `SELECT`, `INSERT`, `DELETE` independently, and any future `UPDATE`/`MOVE`/`COPY`/`UPSERT` operation the same way — do not assume a new operation inherits the same protection automatically.

## 16. Storage path invariant

A Storage path is not a credential. If a path encodes `school_id/conversation_id/...`, the policy must independently match those path segments against trusted server-side state (e.g. `auth.uid()` → membership), not trust the client-supplied prefix at face value.

## 17. Public URL invariant

DB RLS does not protect a public Storage URL. If an object is intended-private, it must never live in a public bucket.

When a bucket is converted from public to private, every consumer flow must be checked: `getPublicUrl()`, `createSignedUrl()`, `download()`, `openStorageFile()`, and any other read path — a public-bucket assumption baked into one of these will silently keep leaking content.

## 18. Realtime — Postgres Changes

A client subscription `filter:` is not authorization — it only shapes what the client *asks* to see. The real security boundary is the table's `SELECT` RLS.

Every new table added to the `supabase_realtime` publication requires its own dedicated `SELECT` RLS review before going live.

## 19. Realtime — Broadcast

Every security-sensitive Broadcast channel must be created with:

```js
{ config: { private: true } }
```

Currently-protected patterns: `notify-<profileId>`, `<roomId>`, `exsync-<roomKey>`.

Both the sender-side and the receiver-side channel-creation call sites must carry `private:true` — a fix applied to only one side is incomplete.

## 20. Realtime authorization (private Broadcast)

Private Broadcast authorization is enforced by policies on `realtime.messages`. A topic string is never treated as secret.

- `notify-<profileId>`: `SELECT` → target user only. `INSERT` → the intended same-school caller model (see §21 note).
- `<roomId>`: `call_room_participants` membership OR active `class_live` membership.
- `exsync-<roomKey>`: `exsync_authorized(roomKey)`.

## 21. Exsync invariant

**`roomKey != lesson_id`.** This is not an approximation — it is a hard fact about the current frontend and must never be re-assumed away.

Currently-supported `roomKey` formats:

```
ls_<truncated lesson id, 20 hex chars, no dashes>
hw_<truncated homework id, 20 hex chars, no dashes>
as_<assignment id, untruncated>
<raw class_live.room_id>            (fallback)
```

Never revert the exsync policy to `substring(topic...)::uuid = lesson_id` without independently re-verifying the real frontend mapping first — that exact regression happened once already (see §25) and is exactly the class of bug this baseline exists to prevent.

Any change to `lvSyncInit()` or to how `roomKey` is generated requires a simultaneous review of: the frontend generator, `exsync_authorized()`, `realtime_exsync_select`, and `realtime_exsync_insert`. These four must always be reviewed together, never one at a time.

## 22. Broadcast payload trust

Even on a `private:true` channel, the payload is still client-controlled data. `private:true` proves the caller was authorized to *use the channel* — it proves nothing about whether any individual payload field is truthful.

Security-sensitive identity must always come from server-side state (e.g. re-reading `call_signals`), never from the Broadcast payload itself, private channel or not.

## 23. Deployment invariant

None of the following are evidence that a change is live:

- SQL was sent
- a commit was created
- "deploy" was clicked

After a DB migration, re-verify against a **fresh** read of: `pg_policies`, `pg_proc`, `information_schema.triggers`, and grants — for the actual changed surface, not a cached mental model of what should be there.

After a frontend deployment, verify the source at the actual deployed commit SHA (e.g. via the hosting provider's API pinned to that SHA), not by trusting a CDN response — CDNs can serve stale content even with cache-busting query parameters.

## 24. Supabase SQL Editor warning

Operational lesson, recorded here because it already caused a real, silent regression once: the Supabase SQL Editor can show a **"Potential issue detected"** modal for DDL and require a second, separate confirmation click. If that confirmation is missed (e.g. in a scripted/automated run), the query does not execute — with no obvious error surfaced to a casual glance.

Mandatory process for any DDL change:

```
execute → confirm the modal → fresh catalog SELECT → compare EXPECTED vs ACTUAL
```

Never conclude a migration succeeded without the final comparison step.

---

## 25. Release security checklist

Run before every production release. Any unchecked mandatory item blocks release — see `security/RELEASE_SECURITY_TEMPLATE.md`.

```
[ ] No new table exposed to client without RLS review
[ ] No new permissive policy undermines existing policy composition
[ ] INSERT tenant/FK protection also preserved on UPDATE
[ ] No client-controlled role/school authorization
[ ] No new SECURITY DEFINER function without search_path/auth/grants review
[ ] No privileged trigger function directly executable by clients
[ ] No Storage bucket/path change without storage.objects review
[ ] No intended-private content moved to public Storage
[ ] No new Realtime publication without SELECT RLS review
[ ] No Broadcast channel added without private-channel authorization review
[ ] No Broadcast payload used as authoritative identity
[ ] No call-room authorization based on room-name secrecy
[ ] call_room_participants remains client-write-denied
[ ] pending_user_deletions remains client-write-denied
[ ] exsync frontend roomKey generation matches exsync_authorized()
[ ] materials Storage staff-only upload remains enforced
[ ] chat-files remains conversation-member scoped
[ ] delete-user remains fail-closed
[ ] daily-room still uses authoritative membership
[ ] Fresh catalog verification performed after DB DDL
[ ] Deployed frontend source verified after release
```

## 26. Automated checks

`security/security_baseline.sql` runs a read-only set of catalog/metadata checks covering a meaningful subset of this document (RLS enabled on critical tables, expected policies exist, dangerous grants absent, trigger function `search_path`, Storage policies exist). It is not a substitute for the full checklist above — several invariants in this document describe business logic that cannot be reliably proven by a catalog query, and are marked as such in that file.

## 27. Frontend static check

See `security/frontend_security_check.md` (or the automated check script if one exists in `security/`, per that file's own header) for what is and is not reliably automatable on the frontend side. In short: whether every security-sensitive Broadcast channel carries `private:true`, and whether the `notifyBroadcastChannel` / `notify-pg-` split still exists, are checked; whether `lvSyncInit()` roomKey formats changed is a MANUAL CHECK against §21 of this document — a regex-based test for that would create false confidence without real coverage, so none is provided.

## 28. Staging runtime regression test plan

See `security/RELEASE_SECURITY_TEMPLATE.md` for the report format, and the "Runtime Security Regression" section below for the actual test plan. This must run on **staging/test only, never production**, with at least two accounts (ideally: student A, student B, teacher).

Minimum coverage:

```
legitimate ring
legitimate answer
legitimate decline
legitimate hangup

unauthorized notify subscribe
unauthorized foreign-room hangup

legitimate exercise sync
non-member exercise-sync subscribe
non-member exercise-sync send

chat attachment — own conversation
chat attachment — foreign conversation

student direct materials Storage upload → DENY
```

Record EXPECTED / ACTUAL / PASS-FAIL for each. This is what closes the evidence gap left open by Security Audit v10:

```
Call-flow regression: NOT VERIFIED (no second live account)
Exercise-sync regression: NOT VERIFIED (no second live account)
```

Both chains are currently backed by `DEPLOYED SOURCE VERIFIED` + `SQL CONTEXT VERIFIED` + `CODE ANALYSIS PROTECTED` evidence — a real, consistent, static proof — but not by a full multi-user runtime test. That gap is intentional and honestly labeled, not hidden; this section exists to close it on staging when the team is ready to run it.

## 29. Scope note — this document does not change production

This baseline is documentation, read-only automated checks, and process. It intentionally does not modify, "improve," or re-architect production authorization. If a baseline check ever finds a live discrepancy between this document and production reality: **stop and report the drift.** Do not silently auto-fix it — any correction to production authorization requires its own dedicated security review, exactly as this document required for the v1–v10 audits it codifies.

---

*This document reflects the verified state as of Security Audit v10 (2026-09-18). Application layer: READY. Realtime layer: READY. Storage layer: READY. Platform security status: READY. 0 new Critical, 0 new High, 0 material authorization UNKNOWN, at that time. Treat this file, not the audit history, as the source of truth going forward — update it whenever an invariant intentionally changes, in the same review that changes the invariant.*
