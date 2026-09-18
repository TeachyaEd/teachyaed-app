-- =====================================================================
-- TeachyaED — Security Baseline v1 — automated read-only checks
-- =====================================================================
-- Companion to /SECURITY_BASELINE.md.
--
-- THIS SCRIPT IS STRICTLY READ-ONLY.
-- It only queries pg_catalog / information_schema / pg_policies /
-- has_*_privilege(). It never performs INSERT, UPDATE, DELETE, DDL,
-- or calls any function that mutates state. It is safe to run against
-- production at any time, including repeatedly, including by an
-- unattended job.
--
-- WHAT THIS SCRIPT DOES NOT DO:
-- It cannot prove business logic correctness (e.g. "students only see
-- their own homework", "exsync roomKey mapping matches the frontend").
-- Those require code review + the staging runtime regression plan in
-- security/RELEASE_SECURITY_TEMPLATE.md. Checks below are catalog/
-- metadata facts only: RLS is on, expected policies exist, dangerous
-- grants are absent, trigger functions have search_path pinned. A
-- PASS here is necessary, not sufficient, for the invariant in
-- SECURITY_BASELINE.md that it maps to.
--
-- OUTPUT: one row per check — CHECK / EXPECTED / ACTUAL / STATUS.
-- Run the whole file as one query (it's a single UNION ALL) so results
-- come back as one result set.
-- =====================================================================

WITH

-- ---------------------------------------------------------------
-- 1. RLS enabled on critical tables
-- ---------------------------------------------------------------
critical_tables AS (
  SELECT unnest(ARRAY[
    'call_room_participants','pending_user_deletions','profiles',
    'homeworks','lesson_assignments','lesson_answers','lesson_chat',
    'conversation_members','conversations','students','class_students',
    'class_live','call_signals'
  ]) AS relname
),
rls_check AS (
  SELECT
    'RLS enabled: public.' || ct.relname AS check_name,
    'true' AS expected,
    COALESCE(c.relrowsecurity::text, 'TABLE NOT FOUND') AS actual,
    CASE WHEN c.relrowsecurity IS TRUE THEN 'PASS' ELSE 'FAIL' END AS status
  FROM critical_tables ct
  LEFT JOIN pg_class c
    ON c.relname = ct.relname AND c.relnamespace = 'public'::regnamespace
),

-- ---------------------------------------------------------------
-- 2. realtime.messages: expected 6 policies exist, by name
-- ---------------------------------------------------------------
expected_rt_policies AS (
  SELECT unnest(ARRAY[
    'realtime_notify_select','realtime_notify_insert',
    'realtime_room_select','realtime_room_insert',
    'realtime_exsync_select','realtime_exsync_insert'
  ]) AS policyname
),
rt_policy_check AS (
  SELECT
    'realtime.messages policy exists: ' || erp.policyname AS check_name,
    'present' AS expected,
    CASE WHEN p.policyname IS NOT NULL THEN 'present' ELSE 'MISSING' END AS actual,
    CASE WHEN p.policyname IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
  FROM expected_rt_policies erp
  LEFT JOIN pg_policies p
    ON p.schemaname = 'realtime' AND p.tablename = 'messages' AND p.policyname = erp.policyname
),

-- ---------------------------------------------------------------
-- 3. exsync policy actually calls exsync_authorized() (not the old
--    broken substring(...)::uuid = lesson_id form)
-- ---------------------------------------------------------------
exsync_policy_check AS (
  SELECT
    'realtime.messages.' || p.policyname || ' uses exsync_authorized()' AS check_name,
    'qual/with_check text contains exsync_authorized' AS expected,
    CASE
      WHEN COALESCE(p.qual::text,'') LIKE '%exsync_authorized%'
        OR COALESCE(p.with_check::text,'') LIKE '%exsync_authorized%'
      THEN 'contains exsync_authorized'
      ELSE COALESCE(p.qual::text, p.with_check::text, 'POLICY NOT FOUND')
    END AS actual,
    CASE
      WHEN COALESCE(p.qual::text,'') LIKE '%exsync_authorized%'
        OR COALESCE(p.with_check::text,'') LIKE '%exsync_authorized%'
      THEN 'PASS' ELSE 'FAIL'
    END AS status
  FROM pg_policies p
  WHERE p.schemaname = 'realtime' AND p.tablename = 'messages'
    AND p.policyname IN ('realtime_exsync_select','realtime_exsync_insert')
),
exsync_fn_exists AS (
  SELECT
    'function exists: public.exsync_authorized' AS check_name,
    '1 function' AS expected,
    count(*)::text || ' function(s)' AS actual,
    CASE WHEN count(*) >= 1 THEN 'PASS' ELSE 'FAIL' END AS status
  FROM pg_proc
  WHERE proname = 'exsync_authorized' AND pronamespace = 'public'::regnamespace
),

-- ---------------------------------------------------------------
-- 4. call_room_participants / pending_user_deletions: zero
--    client-facing policies (deny-all by omission)
-- ---------------------------------------------------------------
zero_policy_tables AS (
  SELECT unnest(ARRAY['call_room_participants','pending_user_deletions']) AS relname
),
zero_policy_check AS (
  SELECT
    'zero client policies: public.' || zpt.relname AS check_name,
    '0 policies' AS expected,
    COALESCE(cnt.n, 0)::text || ' policies' AS actual,
    CASE WHEN COALESCE(cnt.n, 0) = 0 THEN 'PASS' ELSE 'FAIL' END AS status
  FROM zero_policy_tables zpt
  LEFT JOIN (
    SELECT tablename, count(*) AS n
    FROM pg_policies
    WHERE schemaname = 'public'
    GROUP BY tablename
  ) cnt ON cnt.tablename = zpt.relname
),

-- ---------------------------------------------------------------
-- 5. call_room_participants / pending_user_deletions: no
--    client-write (INSERT/UPDATE/DELETE) table grants to
--    anon/authenticated
-- ---------------------------------------------------------------
no_write_grants_check AS (
  SELECT
    'no client-write grants: public.' || t.table_name
      || ' (' || t.privilege_type || ' / ' || t.grantee || ')' AS check_name,
    'no grant row' AS expected,
    'grant exists' AS actual,
    'FAIL' AS status
  FROM information_schema.role_table_grants t
  WHERE t.table_schema = 'public'
    AND t.table_name IN ('call_room_participants','pending_user_deletions')
    AND t.grantee IN ('anon','authenticated')
    AND t.privilege_type IN ('INSERT','UPDATE','DELETE')
),
-- synthesize PASS rows for the 2 tables x 3 privileges x 2 grantees = 12
-- combos not already reported as FAIL above
no_write_grants_matrix AS (
  SELECT tbl, priv, grantee
  FROM unnest(ARRAY['call_room_participants','pending_user_deletions']) AS tbl
  CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) AS priv
  CROSS JOIN unnest(ARRAY['anon','authenticated']) AS grantee
),
no_write_grants_pass AS (
  SELECT
    'no client-write grants: public.' || m.tbl || ' (' || m.priv || ' / ' || m.grantee || ')' AS check_name,
    'no grant row' AS expected,
    'no grant row' AS actual,
    'PASS' AS status
  FROM no_write_grants_matrix m
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants t
    WHERE t.table_schema = 'public' AND t.table_name = m.tbl
      AND t.grantee = m.grantee AND t.privilege_type = m.priv
  )
),

-- ---------------------------------------------------------------
-- 6. Security-relevant trigger functions: search_path pinned,
--    no direct client EXECUTE
-- ---------------------------------------------------------------
security_trigger_fns AS (
  SELECT unnest(ARRAY[
    'enforce_lesson_chat_identity','enforce_call_signal_identity',
    'protect_homework_student_fields','protect_lesson_assignment_fields',
    'protect_student_staff_fields','record_call_room_participants'
  ]) AS proname
),
search_path_check AS (
  SELECT
    'search_path pinned: public.' || stf.proname || '()' AS check_name,
    'proconfig contains search_path=' AS expected,
    COALESCE(
      (SELECT string_agg(cfg, ', ') FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'),
      'NOT SET'
    ) AS actual,
    CASE WHEN EXISTS (
      SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'
    ) THEN 'PASS' ELSE 'FAIL' END AS status
  FROM security_trigger_fns stf
  LEFT JOIN pg_proc p ON p.proname = stf.proname AND p.pronamespace = 'public'::regnamespace
),
no_client_execute_check AS (
  SELECT
    'no client EXECUTE: public.' || stf.proname || '() (' || role_name || ')' AS check_name,
    'false' AS expected,
    has_function_privilege(role_name, p.oid, 'EXECUTE')::text AS actual,
    CASE WHEN has_function_privilege(role_name, p.oid, 'EXECUTE') IS NOT TRUE THEN 'PASS' ELSE 'FAIL' END AS status
  FROM security_trigger_fns stf
  JOIN pg_proc p ON p.proname = stf.proname AND p.pronamespace = 'public'::regnamespace
  CROSS JOIN unnest(ARRAY['anon','authenticated','public']) AS role_name
),

-- ---------------------------------------------------------------
-- 7. Storage policies exist for materials / chat-files
-- ---------------------------------------------------------------
expected_storage_policies AS (
  SELECT unnest(ARRAY[
    'materials_select','materials_insert','materials_delete',
    'chat_files_select','chat_files_insert','chat_files_delete'
  ]) AS policyname
),
storage_policy_check AS (
  SELECT
    'storage.objects policy exists: ' || esp.policyname AS check_name,
    'present' AS expected,
    CASE WHEN p.policyname IS NOT NULL THEN 'present' ELSE 'MISSING' END AS actual,
    CASE WHEN p.policyname IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
  FROM expected_storage_policies esp
  LEFT JOIN pg_policies p
    ON p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = esp.policyname
),

-- ---------------------------------------------------------------
-- 8. RLS enabled on realtime.messages itself
-- ---------------------------------------------------------------
realtime_rls_check AS (
  SELECT
    'RLS enabled: realtime.messages' AS check_name,
    'true' AS expected,
    COALESCE(c.relrowsecurity::text, 'TABLE NOT FOUND') AS actual,
    CASE WHEN c.relrowsecurity IS TRUE THEN 'PASS' ELSE 'FAIL' END AS status
  FROM pg_class c
  WHERE c.relname = 'messages' AND c.relnamespace = 'realtime'::regnamespace
),

-- ---------------------------------------------------------------
-- 9. Storage RLS enabled
-- ---------------------------------------------------------------
storage_rls_check AS (
  SELECT
    'RLS enabled: storage.objects' AS check_name,
    'true' AS expected,
    COALESCE(c.relrowsecurity::text, 'TABLE NOT FOUND') AS actual,
    CASE WHEN c.relrowsecurity IS TRUE THEN 'PASS' ELSE 'FAIL' END AS status
  FROM pg_class c
  WHERE c.relname = 'objects' AND c.relnamespace = 'storage'::regnamespace
)

SELECT * FROM rls_check
UNION ALL SELECT * FROM rt_policy_check
UNION ALL SELECT * FROM exsync_policy_check
UNION ALL SELECT * FROM exsync_fn_exists
UNION ALL SELECT * FROM zero_policy_check
UNION ALL SELECT * FROM no_write_grants_check
UNION ALL SELECT * FROM no_write_grants_pass
UNION ALL SELECT * FROM search_path_check
UNION ALL SELECT * FROM no_client_execute_check
UNION ALL SELECT * FROM storage_policy_check
UNION ALL SELECT * FROM realtime_rls_check
UNION ALL SELECT * FROM storage_rls_check
ORDER BY status DESC, check_name;

-- =====================================================================
-- NOT AUTOMATED HERE — deliberately, per SECURITY_BASELINE.md §26-27.
-- These require code review and/or the staging runtime regression
-- plan, not a catalog query, because they are business-logic facts:
--
--   - notify-<profileId> INSERT actually matches the "same-school
--     caller" business model (vs. some narrower/wider rule)
--   - exsync roomKey generation in lvSyncInit() still matches the
--     4 formats exsync_authorized() expects (ls_/hw_/as_/raw)
--   - lesson_answers transitive ownership chain is enforced
--     end-to-end, not just at one hop
--   - Broadcast payload is genuinely never used as authoritative
--     identity anywhere in the frontend (requires source review,
--     see security/frontend_security_check.md)
--   - staff provisioning flow (invite-user) really can't be reached
--     by a teacher requesting a teacher role, cross-school
--   - daily-room Edge Function body still checks
--     call_room_participants + TTL before minting a room token
--
-- A PASS across this whole script is necessary but not sufficient
-- for "Security baseline: ACTIVE" — pair it with the checklist in
-- SECURITY_BASELINE.md §25 and, before any release touching these
-- surfaces, the staging runtime regression in
-- security/RELEASE_SECURITY_TEMPLATE.md.
-- =====================================================================
