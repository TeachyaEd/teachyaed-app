#!/usr/bin/env node
// TeachyaED -- ephemeral staging-configured copy of root index.html.
//
// Structurally locates the four known production-Supabase-endpoint
// declarations in the source (the createClient(...) call and the three
// Edge Function URL constants: AI_FN, INVITE_FN, DELETE_USER_FN) and
// replaces only the ref/key values inside those specific anchors --
// never a blind find/replace of the bare ref string across the whole
// file. The production project ref is verified live (2026-09-22) to
// occur in the source exactly 4 times, once at each of these anchors;
// if that count or any individual anchor doesn't match at runtime, this
// script fails closed rather than guessing.
//
// Why all four anchors, not just createClient(): AI_FN, INVITE_FN and
// DELETE_USER_FN are separate Edge Function URLs that also embed the
// production project ref. Leaving them pointed at production while only
// repointing the Supabase client itself would let an E2E run invoke
// real production Edge Functions (invite-user, delete-user) -- a
// production-mutation risk, not just a misconfiguration risk.
//
// Neither the production nor the staging key value is ever printed to
// logs -- only booleans and counts.
//
// Usage:
//   STAGING_SUPABASE_REF=lqyetodkoxodwjyqxukq \
//   STAGING_SUPABASE_ANON_KEY=sb_publishable_xxx \
//   node ci/generate-staging-artifact.mjs [path-to-source-index.html] [output-dir]
//
// Exit code 0 = artifact generated and every fail-closed check passed.
// Exit code 1 = a fail-closed check tripped (do not proceed to serve/test).
// Exit code 2 = usage/config error (missing env, source file not found).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applyDef123aPatch } from './patch-def1-def2-def3a.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROD_REF = 'juwvlyrepwdcndkqiqna';
const EXPECTED_PROD_REF_OCCURRENCES = 4; // verified live 2026-09-22: createClient + AI_FN + INVITE_FN + DELETE_USER_FN

const CREATE_CLIENT_RE = /window\.supabase\.createClient\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/;
const AI_FN_RE = /const AI_FN='(https:\/\/[^']+)'/;
const INVITE_FN_RE = /const INVITE_FN='(https:\/\/[^']+)'/;
const DELETE_USER_FN_RE = /const DELETE_USER_FN='(https:\/\/[^']+)'/;

function fail(msg, code = 1) {
  console.error(`[generate-staging-artifact] FAIL: ${msg}`);
  process.exit(code);
}

function requireAnchor(src, re, label) {
  const matches = [...src.matchAll(new RegExp(re, 'g'))];
  if (matches.length !== 1) {
    fail(`expected exactly 1 occurrence of anchor "${label}", found ${matches.length}. Source structure has likely changed -- update this script's anchor, do not loosen the check.`);
  }
  return matches[0];
}

const sourcePath = resolve(process.argv[2] || resolve(__dirname, '../../../index.html'));
const outputDir = resolve(process.argv[3] || resolve(__dirname, '../.staging-artifact'));
const outputPath = resolve(outputDir, 'index.html');

const stagingRef = process.env.STAGING_SUPABASE_REF || 'lqyetodkoxodwjyqxukq';
const stagingKey = process.env.STAGING_SUPABASE_ANON_KEY;

if (!stagingKey) {
  fail('STAGING_SUPABASE_ANON_KEY env var is required. Not proceeding with a partially-configured artifact.', 2);
}
if (!existsSync(sourcePath)) {
  fail(`source index.html not found at ${sourcePath}`, 2);
}

let src = readFileSync(sourcePath, 'utf8');
try {
  src = applyDef123aPatch(src);
} catch (err) {
  fail(err?.message || String(err));
}

// --- Step 1: sanity-check the overall occurrence count before touching anything ---
const refOccurrences = (src.match(new RegExp(PROD_REF, 'g')) || []).length;
if (refOccurrences !== EXPECTED_PROD_REF_OCCURRENCES) {
  fail(
    `expected the production ref to occur exactly ${EXPECTED_PROD_REF_OCCURRENCES} times in source, found ${refOccurrences}. ` +
    `Refusing to guess which occurrences are safe to replace -- update EXPECTED_PROD_REF_OCCURRENCES and the anchor list only after reviewing what changed.`,
  );
}

// --- Step 2: locate each of the 4 known anchors individually (fails closed if any is missing or duplicated) ---
const createClientMatch = requireAnchor(src, CREATE_CLIENT_RE, 'supabase client init (createClient)');
const aiFnMatch = requireAnchor(src, AI_FN_RE, 'AI_FN edge function URL');
const inviteFnMatch = requireAnchor(src, INVITE_FN_RE, 'INVITE_FN edge function URL');
const deleteUserFnMatch = requireAnchor(src, DELETE_USER_FN_RE, 'DELETE_USER_FN edge function URL');

const [, capturedUrl] = createClientMatch;
if (capturedUrl !== `https://${PROD_REF}.supabase.co`) {
  fail('createClient() URL did not match the expected production URL shape -- refusing to substitute blind.');
}
for (const [label, m] of [
  ['AI_FN', aiFnMatch],
  ['INVITE_FN', inviteFnMatch],
  ['DELETE_USER_FN', deleteUserFnMatch],
]) {
  if (!m[1].includes(PROD_REF)) {
    fail(`${label} URL did not contain the expected production ref -- refusing to substitute blind.`);
  }
}

// --- Step 3: perform the 4 anchored substitutions (never a blanket replaceAll of the bare ref) ---
let out = src;
out = out.replace(
  CREATE_CLIENT_RE,
  `window.supabase.createClient('https://${stagingRef}.supabase.co','${stagingKey}')`,
);
out = out.replace(AI_FN_RE, (full) => full.split(PROD_REF).join(stagingRef));
out = out.replace(INVITE_FN_RE, (full) => full.split(PROD_REF).join(stagingRef));
out = out.replace(DELETE_USER_FN_RE, (full) => full.split(PROD_REF).join(stagingRef));

// --- Step 4: fail-closed verification of the actual result ---
if (out.includes(PROD_REF)) {
  fail('generated artifact still contains the production ref after substitution -- refusing to serve an artifact that could reach production.');
}
const stagingRefOccurrences = (out.match(new RegExp(stagingRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
if (stagingRefOccurrences < EXPECTED_PROD_REF_OCCURRENCES) {
  fail(`expected at least ${EXPECTED_PROD_REF_OCCURRENCES} occurrences of the staging ref after substitution, found ${stagingRefOccurrences}.`);
}
if (!out.includes(`'${stagingKey}'`)) {
  fail('generated artifact does not contain the staging key in the expected createClient() position.');
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, out, 'utf8');

console.log(`[generate-staging-artifact] PASS: wrote ${outputPath}`);
console.log('[generate-staging-artifact] DEF-1/DEF-2/DEF-3A branch patch applied with exact-anchor checks');
console.log(`[generate-staging-artifact] production ref occurrences before: ${refOccurrences} (all 4 anchors matched)`);
console.log(`[generate-staging-artifact] production ref present after: false`);
console.log(`[generate-staging-artifact] staging ref occurrences after: ${stagingRefOccurrences}`);
console.log('[generate-staging-artifact] key values: not logged');
process.exit(0);
