> **2026-09-25 update: calling architecture superseded.** Wherever this
> document describes `call_signals` + `call_room_participants` (trigger
> populated, 2h TTL) as the authoritative signalling mechanism for 1:1
> calls, that is no longer accurate. As of the `call_attempts` migration
> (see `docs/ROLLBACK_READINESS.md` for the current production/staging
> version state), **`call_attempts` is the authoritative call state
> machine** for 1:1 calling: a durable table (`ringing`/`accepted`/
> `declined`/`ended`/`failed`) written only via `SECURITY DEFINER` RPCs
> (`start_call`, `accept_call`, `decline_call`, `end_call`, `fail_call`)
> that derive caller/callee identity from `auth.uid()` server-side, never
> from client-supplied values. Realtime delivery uses private Broadcast
> channels (`notify-<profile_id>`) as a fast path plus Postgres Changes on
> `call_attempts` as a fallback, authorized by `realtime.messages` RLS
> policies. `call_signals` and `call_room_participants` still exist and
> are still referenced by the legacy `realtime_room_select`/
> `realtime_room_insert` policies for the separate `ty-cls-*` class-room
> Broadcast path (unchanged, additive-only), but they are no longer the
> mechanism 1:1 call signalling relies on. The rest of this document below
> is preserved as the PHASE 0 discovery snapshot and should be read with
> that correction in mind wherever it references `call_signals` as
> authoritative for calling.

---

# TeachyaED — Legacy Frontend Migration Inventory

Source of record: `index.html`, pinned to commit `86651cfe322900d695a00c78384db0cb1c7b7895`, fetched via GitHub Contents API (not raw.githubusercontent.com — known CDN staleness), 663,492 bytes / 11,206 lines / 5 `<script>` blocks, single file, no build step.

This document is a **read-only inventory**. It changes nothing in production. It is the factual basis for `REACT_MIGRATION_PLAN.md`.

Supabase client: `createClient('https://juwvlyrepwdcndkqiqna.supabase.co', 'sb_publishable_...')` — new-format publishable key (public by design, equivalent to legacy anon key). No secret literal found in source (checked for JWT-shaped literals — none present).

`localStorage` usage (8 keys, all non-sensitive UI state — no session token, no auth credential, no role/identity value stored client-side):
`ty_lang, ty_theme, ty_av_color_*, ty_av_emoji_*, ty_av_photo_*, teachya_dict, ty_last_screen_*, ty_nav_open_*`. This is consistent with `SECURITY_BASELINE.md`: identity/role is never trusted from client storage, only from `auth.uid()` server-side.

---

## 1. Backend surface referenced by the frontend

**Tables (27, via `.from(...)`):** `call_signals, class_feed, class_lessons, class_live, class_students, classes, conversation_members, conversations, homeworks, lesson_answers, lesson_assignments, lesson_chat, lesson_library_likes, lesson_notes, lessons, lessons_log, materials, messages, payments, pd_answers, pd_attempts, pd_materials, pd_questions, profiles, schedule_events, students, tasks, teacher_salaries`.

Server-only tables NOT queried directly by the frontend (trigger/RLS-mediated only, per prior audits): `call_room_participants`, `pending_user_deletions`. Their absence from the frontend query list is expected and correct — do not add direct frontend access to them during migration.

**RPCs (7):** `complete_lesson_for_class, complete_my_assignment, delete_class_cascade, delete_school_user, delete_student_cascade, ensure_my_profile, submit_pd_attempt`.

**Storage buckets (2):** `chat-files` (private), `materials` (public, intentional — course content).

**Edge Functions (3 — not 1; two are invoked via raw `fetch()` to a hardcoded URL, not `.functions.invoke()`, which a naive grep will miss):**
- `daily-room` — via `supabase.functions.invoke('daily-room', ...)`
- `invite-user` — via `fetch('https://juwvlyrepwdcndkqiqna.supabase.co/functions/v1/invite-user', ...)`
- `delete-user` — via `fetch('https://juwvlyrepwdcndkqiqna.supabase.co/functions/v1/delete-user', ...)`

Migration note: the React `services/supabase` layer must wrap both calling conventions behind one interface, so a future Edge Function doesn't silently regress to raw `fetch()` again.

**Realtime channels (14 total — exact parity with Security Audit v10, no drift found on fresh re-check):**

Private Broadcast (`{config:{private:true}}`), 7 sites:
| Channel | Site |
|---|---|
| `notify-'+_pf.id` | bulk ring sender (class-wide ring loop) |
| `` `notify-${S.profile.id}` `` | receiver |
| `` `notify-${ringId}` `` | caller sender |
| `` `notify-${S.pendingCallerId}` `` | decline sender |
| `S.pendingRoom` | decline fallback sender |
| `roomId` | hangup (both sides) |
| `'exsync-'+roomKey` | exercise sync (both sides) |

Plain `postgres_changes` (intentionally not private), 7 sites:
| Channel | Table/purpose |
|---|---|
| `'nt_'+lesson_id` | lesson_notes |
| `` `notify-pg-${S.profile.id}` `` | split receiver channel (DB-backed notification fallback) |
| `'lc_'+roomId` | lesson_chat |
| `'cls-'+roomKey` | class_live UPDATE |
| `'la-'+roomKey` | lesson_answers |
| `'hww-'+hwId` | homeworks UPDATE |
| `'ms_'+S.schoolId` | messenger messages INSERT |

---

## 2. Feature map

Each feature below lists: UI entry points (representative function names), key Supabase surface, Realtime use, risk-relevant notes. Function names are drawn from the 424 top-level `function` declarations in the source; this is not an exhaustive line-by-line spec, it is the map needed to sequence a strangler migration.

### Auth / Invite / Session
`checkInviteToken, doLogin, afterLogin, doLogout, callInviteFunction, setInvitePassword, ensure_my_profile (RPC)`.
Tables: `profiles`. Edge Fn: `invite-user`. No Realtime.
Security: authoritative identity is `auth.uid() → profiles.school_id/role`; the frontend never asserts role, it reads what `profiles`/RLS return. This is the contract PHASE 2 auth foundation must preserve exactly.

### Profile
`openProfile, saveProfile, changeEmail, changePassword`. Tables: `profiles`. No Realtime.

### Dashboard / Home shells
`renderAdminHome, renderOwnerHome` (+ role-specific student/teacher home renderers implied by naming, not separately enumerated here). Aggregates several features below; low logic of its own, mostly navigation.

### Students
`renderAdminStudents, renderOwnerStudents, confirmDeleteStudent, openStudentCard, openStudentProgress, renderStudentVocab, openPlacementTest, submitPlacementTest`. Tables: `students`, `profiles`. RPC: `delete_student_cascade`.

### Staff / Admin / Owner (role & user management)
`openChangeRole, applyRoleChange, confirmDeleteUser, doDeleteUser, renderAdminTeachers, renderOwnerUsers`. RPC: `delete_school_user`. Edge Fn: `delete-user`. Highest privilege-escalation-sensitive area outside calls — must land on server-checked role changes only, never client-trusted.

### Classes
`renderClasses, openNewClass, saveClass, openClassDetail, enterClassLesson, startLiveLesson, endLiveLesson, joinLiveLesson, loadClassTab, addToClass, removeFromClass, postClassFeed`. Tables: `classes, class_students, class_lessons, class_live, class_feed`. Realtime: `'cls-'+roomKey` (class_live UPDATE). Bridges into Live Lessons / Exercise Sync (see below) — do not migrate in isolation from that feature.

### Lessons / Content Editor ("CE")
`openCE, ceRenderAll, ceAddSection, ceExercise, saveFromCE` + dozens of exercise-type sub-functions. Tables: `lessons, lesson_assignments`. This is the largest single UI subsystem by function count; recommended as a **later**, not first, migration slice — high UI complexity, low direct security risk (author-only content editing, RLS-gated by ownership).

### Teacher Lessons / Assignment / Library
`renderTeacherLessons, newLesson, aiGenerateLesson, openLessonEditor, openAssignLesson, assignLesson, renderLibrary, shareToLibrary, copyFromLibrary, toggleLibraryLike`. Tables: `lessons, lesson_assignments, lesson_library_likes`. RPC: `complete_lesson_for_class`.

### Homework
`hwParse, openHWEditor, hweRenderExercises, saveHWEditor, openHWPlayer, submitHWAnswers`. Tables: `homeworks`. RPC: `complete_my_assignment`. Realtime: `'hww-'+hwId` (homeworks UPDATE).

### Schedule
`renderSchedule, openAddEventOnDate, saveEvent, deleteEvent, exportICal`. Tables: `schedule_events`. No Realtime. Good **first-slice candidate**: self-contained, no Realtime, no privileged writes beyond owner's own schedule, easy to test in isolation, low blast radius if a regression slips through.

### Materials
`renderMaterials, deleteMaterial, openMatCard, saveMaterial, resolveStorageUrl, openStorageFile, _matEmbedUrl`. Tables: `materials`. Storage: `materials` bucket (public). No Realtime.

### Chat / Messenger
`renderMessenger, loadConvs, sendMsg, uploadMsgFile, initMsgrRealtime, createConv`, plus in-lesson chat (`cvChatInit, cvChatSend`). Tables: `conversations, conversation_members, messages, lesson_chat`. Storage: `chat-files` bucket (private). Realtime: `'ms_'+schoolId`, `'lc_'+roomId`.

### Calls / Ringing (HIGH RISK — migrate last, per user's own PART 6/18/19/20)
`loadContacts, getRoomId, playRingTone, handleIncomingCall, subscribeNotifications, callContact, acceptCall, declineCall, hangUp, minimizeCall` + whiteboard/laser-pointer sub-features. Tables: `call_signals` (write path only — `call_room_participants` is server/trigger-only). Edge Fn: `daily-room`. Realtime: 6 of the 7 private Broadcast channels above.
Security-critical invariant carried forward: Broadcast payload is never trusted as identity, even on `private:true` channels — the ring handler re-reads authoritative `call_signals` server state. Any React rewrite of this feature must preserve that exact pattern, not just the `private:true` flag.

### Live Lessons / Exercise Sync ("LV"/"CV") (HIGH RISK — migrate last)
`openClassroomView, lvRender, lvSyncInit, lvSyncSend, lvSyncApply, cvLoadHomework, cvPostponeHW`. Tables: `class_live, lesson_answers, lesson_notes`. Realtime: `exsync-'+roomKey`, `'cls-'+roomKey`, `'la-'+roomKey`, `'nt_'+lesson_id`.
Security-critical invariant: `roomKey` format (`ls_`, `hw_`, `as_` prefixes, or raw `class_live.room_id`) must exactly match what `exsync_authorized()` expects server-side. `SECURITY_BASELINE.md` §21 flags this as a manual-review item on every change — the same discipline applies to any React port, not just legacy edits.

### Exercise checkers (shared utility, used by CE/Homework/PD)
`checkFillBlank, checkQuiz, checkTF, matchLeft/matchRight, checkWordOrder, checkSequence, checkWordBank`. Pure client-side grading logic, no direct table/Realtime access of its own — good candidate for an early, low-risk shared `lib/` port since it's pure functions with no security surface.

### PD (Professional Development) module
`renderPD, pdRenderTeacher, pdSubmitAttempt, pdRenderOwner, pdSaveMaterial, pdDeleteMaterial` (~18 functions total). Tables: `pd_materials, pd_questions, pd_attempts, pd_answers`. RPC: `submit_pd_attempt`. No Realtime. Self-contained, good early/mid-slice candidate.

### Payments / Teacher Salaries
`renderPayments, openAddPayment, markPaid, savePayment, renderSalaries, openSetSalary, saveSalary`. Tables: `payments, teacher_salaries`. Financial data — no Realtime, but sensitive; keep RLS-only authorization, no client-side amount trust.

### Tasks / Kanban (not explicitly named by user spec — discovered feature)
`renderTasks, loadTasks, moveTask, saveTask, initTaskReminders`. Tables: `tasks`. No Realtime found.

### Student card / progress / vocab / placement test (discovered, grouped under Students above)
Already listed under Students.

---

## 3. Security-sensitive surface map (cross-ref `SECURITY_BASELINE.md`)

| Surface | Feature(s) | Baseline invariant |
|---|---|---|
| Broadcast private channels | Calls, Live Lessons/Exsync | §19-22: `private:true` required, payload never authoritative identity |
| `roomKey` format | Live Lessons/Exsync | §21: format must match `exsync_authorized()` prefix logic exactly |
| Role/identity chain | Auth, Staff/Admin, all RLS-gated tables | golden rule: client-controlled identifiers never sufficient authorization |
| Storage bucket ACLs | Materials (public), Chat (private) | §14-17 |
| Edge Functions | invite-user, delete-user, daily-room | server-side privilege boundary, must not be re-implemented client-side |
| SECURITY DEFINER RPCs | delete_school_user, delete_student_cascade, delete_class_cascade, ensure_my_profile, submit_pd_attempt, complete_lesson_for_class, complete_my_assignment | must remain the only path for these privileged operations |

No new trust boundary is proposed anywhere in this inventory. The React migration plan (`REACT_MIGRATION_PLAN.md`) treats all of the above as fixed constraints, not things to redesign.

---

## 4. Architecture snapshot (current state)

- Single `index.html`, 11,206 lines, 5 inline `<script>` blocks, no bundler, no TypeScript, no tests, no CI.
- Deployment: manual GitHub web-upload UI commit directly to `main` → GitHub Pages serves `teachyaeded.github.io` (or configured domain) from `main`. No staging environment exists today.
- State management: a single global `S` object (session/profile/school state) plus feature-local module state (`LV`, etc.) — no framework, direct DOM manipulation via string templates.
- No automated tests of any kind currently exist for this frontend.
