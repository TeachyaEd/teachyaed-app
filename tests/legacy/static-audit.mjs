#!/usr/bin/env node
// TeachyaED — Phase 2 static regression audit for root index.html (legacy production app).
//
// Scope: root index.html ONLY. Never /web. Read-only: no network writes, no
// repo writes, no DB access. Structural checks (function-body / statement
// extraction) are preferred over raw line/whitespace-based assertions, per
// tests/legacy/README.md.
//
// Reuses security/frontend_security_check.js rather than duplicating its
// private:true / channel-split / forbidden-ring-handler checks — this script
// shells out to it and merges its pass/fail into the combined result.
//
// Usage:
//   node tests/legacy/static-audit.mjs [path-to-index.html]
//   (defaults to ../../index.html relative to this file, i.e. repo root)
//
// Exit code 0 = all checks PASS. Exit code 1 = at least one check FAILED.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const indexPath = process.argv[2] ? resolve(process.argv[2]) : resolve(repoRoot, 'index.html');
const src = readFileSync(indexPath, 'utf8');

const rows = [];
function check(name, pass, detail) {
  rows.push({ name, status: pass ? 'PASS' : 'FAIL', detail: detail || '' });
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

// Extract a top-level function body ("function name(" or "async function name(")
// by brace-matching from the first opening brace after the signature.
function extractFunctionBody(text, name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  let idx = -1;
  for (const m of markers) {
    idx = text.indexOf(m);
    if (idx !== -1) break;
  }
  if (idx === -1) return null;
  const braceStart = text.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(idx, i + 1);
    }
  }
  return null;
}

// Extract every "sb.from('TABLE')...;" statement (balances (), [], {} so the
// statement is captured even if it contains nested object/array literals),
// so a check can inspect exactly what happens in that one DB call rather than
// a fixed character window (which produced false positives during manual
// review this session — e.g. an unrelated school_id filter on a neighboring
// profiles lookup).
function extractTableStatements(text, table) {
  const needle = `sb.from('${table}')`;
  const out = [];
  let i = 0;
  while (true) {
    const idx = text.indexOf(needle, i);
    if (idx === -1) break;
    let depth = 0;
    let end = idx;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth <= 0) break;
    }
    out.push(text.slice(idx, end + 1));
    i = idx + needle.length;
  }
  return out;
}

// Extract the object-literal argument of the first .insert(...) call within a
// given statement/snippet, as raw text (not parsed — production code isn't
// guaranteed valid standalone JSON, e.g. computed keys / spreads).
function extractInsertArg(stmt) {
  const idx = stmt.indexOf('.insert(');
  if (idx === -1) return null;
  const parenStart = idx + '.insert('.length - 1;
  let depth = 0;
  for (let i = parenStart; i < stmt.length; i++) {
    if (stmt[i] === '(') depth++;
    else if (stmt[i] === ')') {
      depth--;
      if (depth === 0) return stmt.slice(parenStart + 1, i);
    }
  }
  return null;
}

function objectHasKey(objLiteralText, key) {
  // matches "key:" as an object-literal key position (not a read like sig.key)
  const re = new RegExp('(^|[{,\\s])' + key + '\\s*:');
  return re.test(objLiteralText);
}

// ---------------------------------------------------------------------------
// 1. security/frontend_security_check.js — reused, not duplicated
// ---------------------------------------------------------------------------
const fscPath = resolve(repoRoot, 'security/frontend_security_check.js');
const fsc = spawnSync('node', [fscPath, indexPath], { encoding: 'utf8' });
check(
  'security/frontend_security_check.js (private:true anchors, channel split, unsafe ring handler)',
  fsc.status === 0,
  fsc.status === 0 ? 'delegated check passed' : (fsc.stdout || fsc.stderr || '').slice(-2000)
);

// ---------------------------------------------------------------------------
// 2. call_signals: no school_id anywhere in a call_signals statement
// ---------------------------------------------------------------------------
{
  const stmts = extractTableStatements(src, 'call_signals');
  const offenders = stmts.filter(s => /school_id/.test(s));
  check(
    'no call_signals.school_id usage (column does not exist in production)',
    offenders.length === 0,
    offenders.length ? `${offenders.length} call_signals statement(s) reference school_id` : `${stmts.length} call_signals statements scanned, none reference school_id`
  );
}

// ---------------------------------------------------------------------------
// 3. call_signals inserts: no school_id / from_id keys written
// ---------------------------------------------------------------------------
{
  const stmts = extractTableStatements(src, 'call_signals').filter(s => s.includes('.insert('));
  const bad = [];
  for (const s of stmts) {
    const arg = extractInsertArg(s);
    if (!arg) continue;
    if (objectHasKey(arg, 'school_id')) bad.push({ stmt: s.slice(0, 80), key: 'school_id' });
    if (objectHasKey(arg, 'from_id')) bad.push({ stmt: s.slice(0, 80), key: 'from_id' });
  }
  check(
    'call_signals inserts never write school_id or from_id',
    bad.length === 0,
    bad.length ? JSON.stringify(bad) : `${stmts.length} call_signals insert(s) scanned, clean`
  );
}

// ---------------------------------------------------------------------------
// 4. from_profile_id is never client-written (only ever read, e.g. sig.from_profile_id)
// ---------------------------------------------------------------------------
{
  // A write looks like "from_profile_id:" (object-literal key position).
  // A read looks like ".from_profile_id" (property access) — never flagged.
  const writeKeyRe = /(^|[{,\s])from_profile_id\s*:/g;
  const matches = [...src.matchAll(writeKeyRe)];
  check(
    'from_profile_id is never written client-side (server-enforced by enforce_call_signal_identity)',
    matches.length === 0,
    matches.length ? `${matches.length} object-literal write(s) of from_profile_id found` : 'no client-side writes of from_profile_id found'
  );
}

// ---------------------------------------------------------------------------
// 5. 1:1 call insert (callContact) carries an explicit per-attempt UUID
// ---------------------------------------------------------------------------
{
  const body = extractFunctionBody(src, 'callContact');
  const hasUuid = !!body && /crypto\.randomUUID\(\)/.test(body);
  const stmts = body ? extractTableStatements(body, 'call_signals').filter(s => s.includes('.insert(')) : [];
  const insertHasId = stmts.some(s => {
    const arg = extractInsertArg(s);
    return arg && objectHasKey(arg, 'id');
  });
  check(
    'callContact() generates crypto.randomUUID() and 1:1 call_signals insert carries explicit id',
    !!body && hasUuid && insertHasId,
    !body ? 'callContact() not found' : `randomUUID present=${hasUuid}, insert has id key=${insertHasId}`
  );
}

// ---------------------------------------------------------------------------
// 6. PG handler forwards sig.id and sig.from_profile_id into handleIncomingCall
// ---------------------------------------------------------------------------
{
  const body = extractFunctionBody(src, '_ensurePgNotifyChannel');
  const ok = !!body && body.includes('sig.from_profile_id') && body.includes('sig.id') && body.includes('handleIncomingCall(');
  check(
    '_ensurePgNotifyChannel() forwards sig.id and sig.from_profile_id to handleIncomingCall()',
    ok,
    !body ? '_ensurePgNotifyChannel() not found' : `has sig.from_profile_id=${body.includes('sig.from_profile_id')}, has sig.id=${body.includes('sig.id')}`
  );
}

// ---------------------------------------------------------------------------
// 7. Broadcast ring path re-reads call_signals authoritatively (does not trust
//    raw broadcast payload for identity)
// ---------------------------------------------------------------------------
{
  const body = extractFunctionBody(src, '_ensureBcNotifyChannel');
  const ringHandlerMatch = body && body.match(/\.on\('broadcast',\{event:'ring'\}[\s\S]*?\}\)\s*\n\s*\.on\('broadcast',\{event:'decline'\}/);
  const ringHandler = ringHandlerMatch ? ringHandlerMatch[0] : body;
  const reReads = !!ringHandler && /sb\.from\('call_signals'\)\.select\(/.test(ringHandler);
  const forwardsAuthoritativeId = !!ringHandler && ringHandler.includes('sig.from_profile_id');
  const trustsRawPayload = !!body && /handleIncomingCall\(\s*payload\s*\)/.test(body);
  check(
    'Broadcast ring handler re-reads call_signals and forwards sig.from_profile_id (never trusts raw payload identity)',
    reReads && forwardsAuthoritativeId && !trustsRawPayload,
    !body ? '_ensureBcNotifyChannel() not found' : `re-reads DB=${reReads}, forwards authoritative id=${forwardsAuthoritativeId}, trusts raw payload=${trustsRawPayload}`
  );
}

// ---------------------------------------------------------------------------
// 8. decline correlation requires BOTH room id and attempt id
// ---------------------------------------------------------------------------
{
  const body = extractFunctionBody(src, '_ensureBcNotifyChannel');
  const declineMatch = body && body.match(/\.on\('broadcast',\{event:'decline'\}[\s\S]*?\}\)\s*\n\s*\.subscribe\(/);
  const declineHandler = declineMatch ? declineMatch[0] : '';
  const usesRoomId = declineHandler.includes('S._callRoomId');
  const usesAttemptId = declineHandler.includes('S._callAttemptId');
  check(
    'decline handler requires both S._callRoomId and S._callAttemptId to match before hangUp()',
    usesRoomId && usesAttemptId,
    !body ? '_ensureBcNotifyChannel() not found' : `uses room id=${usesRoomId}, uses attempt id=${usesAttemptId}`
  );
}

// ---------------------------------------------------------------------------
// 9. PG/BC notification lifecycles remain decoupled (neither ensure-fn calls
//    the other from inside its own body/retry path)
// ---------------------------------------------------------------------------
{
  const pgBody = extractFunctionBody(src, '_ensurePgNotifyChannel');
  const bcBody = extractFunctionBody(src, '_ensureBcNotifyChannel');
  const pgCallsBc = !!pgBody && pgBody.includes('_ensureBcNotifyChannel(');
  const bcCallsPg = !!bcBody && bcBody.includes('_ensurePgNotifyChannel(');
  check(
    'PG and Broadcast notification channel lifecycles remain decoupled (no cross-calls inside either function)',
    !!pgBody && !!bcBody && !pgCallsBc && !bcCallsPg,
    (!pgBody || !bcBody) ? 'one or both lifecycle functions not found' : `pg calls bc=${pgCallsBc}, bc calls pg=${bcCallsPg}`
  );
}

// ---------------------------------------------------------------------------
// 10. Bounded, single retry timer per channel (no unbounded fanout)
// ---------------------------------------------------------------------------
{
  function retryCheck(fnName, retryVar) {
    const body = extractFunctionBody(src, fnName);
    if (!body) return { ok: false, detail: `${fnName}() not found` };
    const retryBlockMatch = body.match(new RegExp('if\\(!S\\.' + retryVar + '\\)\\{[\\s\\S]*?\\}'));
    const retryBlock = retryBlockMatch ? retryBlockMatch[0] : '';
    const scheduledOnce = (retryBlock.match(new RegExp(fnName + '\\(\\)', 'g')) || []).length === 1;
    const guarded = !!retryBlockMatch;
    return { ok: guarded && scheduledOnce, detail: `guarded=${guarded}, scheduledExactlyOnceInGuard=${scheduledOnce}` };
  }
  const pg = retryCheck('_ensurePgNotifyChannel', '_pgRetryTimer');
  const bc = retryCheck('_ensureBcNotifyChannel', '_bcRetryTimer');
  check('exactly one guarded retry timer for the PG channel (S._pgRetryTimer)', pg.ok, pg.detail);
  check('exactly one guarded retry timer for the Broadcast channel (S._bcRetryTimer)', bc.ok, bc.detail);
}

// ---------------------------------------------------------------------------
// 11. Teacher class entry does not implicitly start a live lesson
// ---------------------------------------------------------------------------
{
  const body = extractFunctionBody(src, 'enterClassLesson');
  const callsStart = !!body && (body.includes('cdpStartLesson(') || body.includes('startLiveLesson('));
  check(
    'enterClassLesson() (teacher class entry) never calls cdpStartLesson()/startLiveLesson() implicitly',
    !!body && !callsStart,
    !body ? 'enterClassLesson() not found' : `calls cdpStartLesson/startLiveLesson=${callsStart}`
  );
}

// ---------------------------------------------------------------------------
// 12. Student no-lesson fallback opens the classroom shell, not class details
// ---------------------------------------------------------------------------
{
  const body = extractFunctionBody(src, 'enterStudentClassLesson');
  let ok = false, detail = 'enterStudentClassLesson() not found';
  if (body) {
    // The "no assignments / no program" terminal fallback: the statement
    // immediately preceding the "no lessons assigned" toast must be an
    // openClassroomView(...) call, not openStudentClass(...).
    const toastIdx = body.indexOf('Уроки пока не назначены');
    const beforeToast = toastIdx === -1 ? '' : body.slice(0, toastIdx);
    const lastOpenClassroom = beforeToast.lastIndexOf('openClassroomView(');
    const lastOpenDetails = beforeToast.lastIndexOf('openStudentClass(');
    const finalFallbackOk = toastIdx !== -1 && lastOpenClassroom > lastOpenDetails;

    // The "!S.studentRowId" branch must also route to the shell, not details.
    const noRowMatch = body.match(/if\(!S\.studentRowId\)\{([^}]*)\}/);
    const noRowBranch = noRowMatch ? noRowMatch[1] : '';
    const noRowOk = /openClassroomView\(/.test(noRowBranch) && !/openStudentClass\(/.test(noRowBranch);

    ok = finalFallbackOk && noRowOk;
    detail = `final no-lesson fallback opens classroom shell=${finalFallbackOk}, no-studentRow fallback opens classroom shell=${noRowOk}`;
  }
  check('enterStudentClassLesson() no-lesson fallbacks open the classroom shell, never class details', ok, detail);
}

// ---------------------------------------------------------------------------
// 13. Production Supabase ref is exactly juwvlyrepwdcndkqiqna, no other ref present
// ---------------------------------------------------------------------------
{
  const EXPECTED_REF = 'juwvlyrepwdcndkqiqna';
  const hasExpected = src.includes(EXPECTED_REF);
  const allRefs = [...src.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map(m => m[1]);
  const uniqueRefs = [...new Set(allRefs)];
  const unexpected = uniqueRefs.filter(r => r !== EXPECTED_REF);
  check(
    'production Supabase project ref is exactly juwvlyrepwdcndkqiqna and no other ref appears',
    hasExpected && unexpected.length === 0,
    `expected ref present=${hasExpected}, unexpected refs=${JSON.stringify(unexpected)}`
  );
}

// ---------------------------------------------------------------------------
// 14. No service-role / JWT / private credentials in frontend source
// ---------------------------------------------------------------------------
{
  const hasServiceRoleString = /service_role/i.test(src);
  const jwtMatches = [...src.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)];
  const serviceRoleJwts = [];
  for (const m of jwtMatches) {
    try {
      const payload = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64').toString('utf8'));
      if (payload && payload.role === 'service_role') serviceRoleJwts.push(m[0].slice(0, 20) + '...');
    } catch { /* not decodable JSON payload — ignore, not our concern here */ }
  }
  check(
    'no "service_role" string and no decodable service_role JWT in frontend source',
    !hasServiceRoleString && serviceRoleJwts.length === 0,
    `literal "service_role" string present=${hasServiceRoleString}, service_role JWTs found=${serviceRoleJwts.length}`
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('=== TeachyaED Phase 2 static legacy audit — root index.html ===\n');
let anyFail = false;
for (const r of rows) {
  if (r.status === 'FAIL') anyFail = true;
  console.log(`[${r.status}] ${r.name}`);
  if (r.detail) console.log(`        ${r.detail}`);
}
console.log('');
console.log(`${rows.filter(r => r.status === 'PASS').length}/${rows.length} checks passed`);
console.log(anyFail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(anyFail ? 1 : 0);
