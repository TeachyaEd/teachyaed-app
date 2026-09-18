#!/usr/bin/env node
// TeachyaED — frontend security static check
// Companion to security/frontend_security_check.md and SECURITY_BASELINE.md §19-22, §27.
//
// READ-ONLY: fetches or reads index.html and inspects text only.
// Makes no network writes, no repo writes, no DB access.
//
// Usage:
//   node frontend_security_check.js <path-or-url-to-index.html>
//
// Exit code 0 = all reliably-automated checks PASS.
// Exit code 1 = at least one reliably-automated check FAILED.
// MANUAL CHECK items never affect the exit code — they are always
// printed for a human to review, per this script's own limitations
// (see frontend_security_check.md).

const fs = require('fs');

async function loadSource(arg) {
  if (/^https?:\/\//.test(arg)) {
    const res = await fetch(arg);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    return await res.text();
  }
  return fs.readFileSync(arg, 'utf8');
}

// Exact literal anchors — same strings used to apply the Security
// Audit v10 patch. If a refactor changes the surrounding code enough
// that an anchor no longer matches, that is reported as NOT FOUND
// (stale-check signal), never silently treated as PASS.
const CHANNEL_ANCHORS = [
  {
    name: 'notify-<profileId> receiver (Broadcast, private)',
    anchor: "sb.channel(`notify-${S.profile.id}`,{config:{private:true}})",
  },
  {
    name: 'notify-<ringId> sender (callContact ring)',
    anchor: "sb.channel(`notify-${ringId}`,{config:{private:true}})",
  },
  {
    name: "notify-<profileId> sender (bulk class-ring loop)",
    anchor: "sb.channel('notify-'+_pf.id,{config:{private:true}})",
  },
  {
    name: 'notify-<pendingCallerId> sender (decline)',
    anchor: "sb.channel(`notify-${S.pendingCallerId}`,{config:{private:true}})",
  },
  {
    name: 'pendingRoom sender (decline fallback)',
    anchor: "sb.channel(S.pendingRoom,{config:{private:true}})",
  },
  {
    name: 'roomId channel (hangup, both sides)',
    anchor: "S.callChannel=sb.channel(roomId,{config:{private:true}})",
  },
  {
    name: 'exsync-<roomKey> channel (both sides)',
    anchor: "LV._syncCh=sb.channel('exsync-'+roomKey,{config:{private:true}})",
  },
];

const SPLIT_ANCHORS = [
  { name: 'S.notifyBroadcastChannel exists', anchor: 'S.notifyBroadcastChannel' },
  { name: "notify-pg-<id> topic (plain Postgres Changes channel)", anchor: 'notify-pg-${S.profile.id}' },
];

const FORBIDDEN_PATTERNS = [
  {
    name: 'old unsafe ring handler (trusts raw broadcast payload) absent',
    // literal string that must NOT be present
    anchor: ".on('broadcast',{event:'ring'},({payload})=>handleIncomingCall(payload))",
    forbidden: true,
  },
];

// Advisory-only: known roomKey format literals near lvSyncInit(...).
// A grep confirming these are "still there" is NOT proof the mapping
// is still correct — see frontend_security_check.md.
const ROOMKEY_FORMAT_LITERALS = [
  { label: 'ls_ (lesson) prefix', literal: "'ls_'+" },
  { label: 'hw_ (homework) prefix', literal: "'hw_'+" },
  { label: 'as_ (assignment) prefix', literal: "'as_'+assignId" },
  { label: 'raw class_live.room_id fallback', literal: 'S._liveRoomId' },
];

function checkRow(name, expected, actual, pass) {
  return { name, expected, actual, status: pass ? 'PASS' : 'FAIL' };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node frontend_security_check.js <path-or-url-to-index.html>');
    process.exit(2);
  }

  const src = await loadSource(arg);
  const rows = [];

  for (const c of CHANNEL_ANCHORS) {
    const found = src.includes(c.anchor);
    rows.push(checkRow(
      `private:true present — ${c.name}`,
      'anchor present in source',
      found ? 'anchor present' : 'ANCHOR NOT FOUND (stale check or regression — investigate manually)',
      found
    ));
  }

  for (const s of SPLIT_ANCHORS) {
    const found = src.includes(s.anchor);
    rows.push(checkRow(
      `channel split intact — ${s.name}`,
      'present',
      found ? 'present' : 'MISSING',
      found
    ));
  }

  for (const f of FORBIDDEN_PATTERNS) {
    const found = src.includes(f.anchor);
    rows.push(checkRow(
      f.name,
      'absent',
      found ? 'PRESENT — regression' : 'absent',
      !found
    ));
  }

  // Print reliably-automated results
  console.log('=== Automated checks (affect exit code) ===\n');
  let anyFail = false;
  for (const r of rows) {
    if (r.status === 'FAIL') anyFail = true;
    console.log(`CHECK:    ${r.name}`);
    console.log(`EXPECTED: ${r.expected}`);
    console.log(`ACTUAL:   ${r.actual}`);
    console.log(`STATUS:   ${r.status}\n`);
  }

  // Print advisory-only roomKey format scan
  console.log('=== Advisory only — MANUAL CHECK required regardless of result ===\n');
  console.log('(See frontend_security_check.md: a grep cannot certify roomKey semantics.)\n');
  for (const f of ROOMKEY_FORMAT_LITERALS) {
    const found = src.includes(f.literal);
    console.log(`CHECK:    roomKey format literal still present — ${f.label}`);
    console.log(`EXPECTED: present (unchanged from Security Baseline v1 §21)`);
    console.log(`ACTUAL:   ${found ? 'present' : 'NOT FOUND — formats may have changed, manual review required'}`);
    console.log(`STATUS:   MANUAL CHECK (not scored)\n`);
  }

  console.log(anyFail
    ? 'RESULT: FAIL — at least one automated check failed. Do not release until resolved or manually reviewed.'
    : 'RESULT: PASS (automated checks only — manual items above still require human review).');

  process.exit(anyFail ? 1 : 0);
}

main().catch(err => {
  console.error('frontend_security_check.js error:', err.message);
  process.exit(2);
});
