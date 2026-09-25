# Default Privileges Remediation Proposal (Phase 9)

_Last updated: 2026-09-25. Read-only audit; **no changes have been applied to production or staging**. This is a proposal only, for future review and explicit sign-off before any production action._

## 1. What was found

Both the production project (`juwvlyrepwdcndkqiqna`) and the staging project (`lqyetodkoxodwjyqxukq`, "teachyaed-staging") carry **two separate `ALTER DEFAULT PRIVILEGES` rules** that auto-grant privileges on future objects created in the `public` schema (and, for the `supabase_admin`-owned rule, in `auth`/`extensions`/`graphql`/`graphql_public`/`realtime`/`storage` too):

1. **`supabase_admin`-owned rule** — present identically on both projects. Grants `arwdDxtm` (INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — i.e. full read/write/DDL-adjacent access) on every future table to `postgres`, `anon`, `authenticated`, and `service_role`. This is Supabase's own platform-level default, applied by the managed-Postgres provisioning process itself, not something introduced by any work in this engagement.
2. **`postgres`-owned rule** — **diverges between the two projects**:
   - **Production**: also grants full `arwdDxtm` to `postgres`/`anon`/`authenticated`/`service_role` on future `public` tables — i.e. duplicates the `supabase_admin` rule's effect.
   - **Staging**: grants only `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) to `anon`/`authenticated`/`service_role` — **no SELECT, INSERT, UPDATE, or DELETE** — while `postgres` itself keeps the full set. This is materially narrower than production.

## 2. Who created the broad defaults, and why they exist

The `supabase_admin`-owned rule is part of Supabase's own project bootstrap; it is not attributable to any change made in this engagement or, most likely, to any explicit action by TeachyaEd's team — it is the platform's own default posture. The `postgres`-owned rule on production most likely originates from an early `ALTER DEFAULT PRIVILEGES ... GRANT ALL ...` run manually (or via an early migration/tool) against the `postgres` role at some point before the security-hardening work already completed in this engagement (see `SECURITY_BASELINE.md` and the v1–v10 audit history) started tightening RLS. Staging was provisioned later, during the `call_attempts` migration, and evidently did not inherit that same broad `postgres`-owned grant — which is why the two projects diverge.

## 3. Which future object types are affected

Both default-ACL rules apply to **tables** (`defaclobjtype = 'r'`) created in future in the covered schemas. The `supabase_admin`-owned rule additionally covers **sequences** and **functions** (and, on some namespaces, **types**/**schemas**) across `auth`, `extensions`, `graphql`, `graphql_public`, `realtime`, and `storage` — this is standard Supabase platform behavior across all Supabase projects, not specific to TeachyaEd's schema design.

## 4. Do `anon`/`authenticated` receive broad privileges automatically?

**Yes, on production**, for any new `public` table created without an explicit `REVOKE` afterward: both the `supabase_admin` and the `postgres` default rule grant `anon` and `authenticated` full CRUD (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) automatically, the moment the table is created — before any RLS policy is even written for it. RLS being enabled (`ENABLE ROW LEVEL SECURITY`) blocks unauthorized *rows*, but does not remove the underlying *grant*; a table created and left with RLS disabled, or with a permissive policy, is immediately exposed to both roles via these defaults alone.

**On staging**, only the `supabase_admin` rule grants this (the `postgres` rule does not), so the automatic exposure is narrower but still present via the platform-level rule.

## 5. Which existing tables have already inherited these grants (blast radius)

A direct `has_table_privilege()` sweep of all 32 tables in the production `public` schema found **29 of 32 tables** carry `anon SELECT = true` and `authenticated` full CRUD (`SELECT`/`INSERT`/`UPDATE`/`DELETE` = true) at the grant level:

```
call_signals, class_feed, class_lessons, class_live, class_students, classes,
conversation_members, conversations, homeworks, lesson_answers,
lesson_assignments, lesson_chat, lesson_library_likes, lesson_notes, lessons,
lessons_log, materials, messages, payments, pd_answers, pd_attempts,
pd_materials, pd_questions, profiles, schedule_events, schools, students,
tasks, teacher_salaries
```

Only **`call_attempts`** and **`call_room_participants`** are exceptions — both were explicitly hardened during this engagement (§Phase 8/9 rollback doc and the v9/v10 Realtime-authorization work) with grants revoked down to exactly what their RLS policies need.

**Critical distinction**: this grant-level exposure is **not** the same as an actual data leak. Every one of these 29 tables has already been through the v1–v10 security audit series in this engagement and has RLS policies enforcing row-level authorization (tenant/ownership checks) independently of the grant. The grants are broader than necessary, but the *policies* are what has actually been protecting the data — the grants are a second, currently-unused layer of exposure that should be tightened as defense-in-depth, not a currently-exploitable hole on their own (no bypass of the existing RLS policies was found or implied by this finding).

## 6. Proposed remediation (NOT applied — for review only)

Two options, in order of preference:

**Option A — narrow the default ACL rules going forward (recommended, lowest risk):**
```sql
-- Run once per role that currently has a broad default rule (postgres, and
-- optionally supabase_admin if Supabase tooling permits altering it — it
-- may not, since it is platform-managed):
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
```
This only changes behavior for *tables created after* the change — it does not touch any existing table's current grants, so it carries no risk of breaking anything live. It closes the "forgot to REVOKE after CREATE TABLE" hazard for all future tables.

**Option B — retroactively tighten existing tables' grants to match least privilege (higher risk, requires per-table review):**
For each of the 29 tables, determine whether `anon` needs any access at all (most should have zero — TeachyaEd has no genuinely public-anonymous read surface that this audit has identified) and whether `authenticated`'s full CRUD grant should be narrowed to only the operations its RLS policies actually author (e.g. a table that's meant to be read-only for students should not carry an `authenticated INSERT` grant even if RLS would reject the insert — removing the grant is a stronger guarantee than relying on RLS alone, consistent with the `call_attempts`/`call_room_participants` precedent already set). This requires a per-table pass similar to the v6–v10 audit work already done, and should be scheduled as its own reviewed change, not bundled silently into an unrelated commit.

## 7. Recommendation

- Apply **Option A** to staging and production once explicitly approved — it is additive-only, forward-looking, and matches the pattern already used for `call_attempts`/`call_room_participants`.
- Schedule **Option B** as a separate, explicitly-scoped hardening pass (its own plan, its own review, its own rollback point), given the number of tables involved and the need to confirm each table's actual intended access pattern before revoking anything live.
- Apply to **staging first**, verify no regression via the existing E2E suite, then apply to **production** in a dedicated, announced change window — consistent with the standing "no production changes without explicit authorization" rule for this engagement.

**No SQL from this document has been run against production or staging. This is a proposal only.**
