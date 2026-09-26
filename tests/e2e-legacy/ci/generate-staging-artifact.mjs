#!/usr/bin/env node
// TeachyaED -- ephemeral staging-configured copy of root index.html.
// Applies approved staging-only client patches, then structurally swaps only
// the four known production Supabase endpoints. Fails closed on drift.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applyDef123aPatch } from './patch-def1-def2-def3a.mjs';
import { applyLvSyncLifecyclePatch } from './patch-lvsync-lifecycle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_REF = 'juwvlyrepwdcndkqiqna';
const EXPECTED_PROD_REF_OCCURRENCES = 4;
const CREATE_CLIENT_RE = /window\.supabase\.createClient\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/;
const AI_FN_RE = /const AI_FN='(https:\/\/[^']+)'/;
const INVITE_FN_RE = /const INVITE_FN='(https:\/\/[^']+)'/;
const DELETE_USER_FN_RE = /const DELETE_USER_FN='(https:\/\/[^']+)'/;

function fail(msg, code = 1) { console.error(`[generate-staging-artifact] FAIL: ${msg}`); process.exit(code); }
function requireAnchor(src, re, label) {
  const matches=[...src.matchAll(new RegExp(re,'g'))];
  if(matches.length!==1) fail(`expected exactly 1 occurrence of anchor "${label}", found ${matches.length}.`);
  return matches[0];
}

const sourcePath=resolve(process.argv[2]||resolve(__dirname,'../../../index.html'));
const outputDir=resolve(process.argv[3]||resolve(__dirname,'../.staging-artifact'));
const outputPath=resolve(outputDir,'index.html');
const stagingRef=process.env.STAGING_SUPABASE_REF||'lqyetodkoxodwjyqxukq';
const stagingKey=process.env.STAGING_SUPABASE_ANON_KEY;
if(!stagingKey) fail('STAGING_SUPABASE_ANON_KEY env var is required.',2);
if(!existsSync(sourcePath)) fail(`source index.html not found at ${sourcePath}`,2);

let src=readFileSync(sourcePath,'utf8');
try {
  src=applyDef123aPatch(src);
  src=applyLvSyncLifecyclePatch(src);
} catch(err) { fail(err?.message||String(err)); }

const refOccurrences=(src.match(new RegExp(PROD_REF,'g'))||[]).length;
if(refOccurrences!==EXPECTED_PROD_REF_OCCURRENCES) fail(`expected production ref exactly ${EXPECTED_PROD_REF_OCCURRENCES} times, found ${refOccurrences}.`);
const createClientMatch=requireAnchor(src,CREATE_CLIENT_RE,'supabase client init (createClient)');
const aiFnMatch=requireAnchor(src,AI_FN_RE,'AI_FN edge function URL');
const inviteFnMatch=requireAnchor(src,INVITE_FN_RE,'INVITE_FN edge function URL');
const deleteUserFnMatch=requireAnchor(src,DELETE_USER_FN_RE,'DELETE_USER_FN edge function URL');
const [,capturedUrl]=createClientMatch;
if(capturedUrl!==`https://${PROD_REF}.supabase.co`) fail('createClient URL mismatch.');
for(const [label,m] of [['AI_FN',aiFnMatch],['INVITE_FN',inviteFnMatch],['DELETE_USER_FN',deleteUserFnMatch]]) if(!m[1].includes(PROD_REF)) fail(`${label} production-ref mismatch.`);

let out=src;
out=out.replace(CREATE_CLIENT_RE,`window.supabase.createClient('https://${stagingRef}.supabase.co','${stagingKey}')`);
out=out.replace(AI_FN_RE,full=>full.split(PROD_REF).join(stagingRef));
out=out.replace(INVITE_FN_RE,full=>full.split(PROD_REF).join(stagingRef));
out=out.replace(DELETE_USER_FN_RE,full=>full.split(PROD_REF).join(stagingRef));
if(out.includes(PROD_REF)) fail('generated artifact still contains production ref.');
const stagingRefOccurrences=(out.match(new RegExp(stagingRef.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
if(stagingRefOccurrences<EXPECTED_PROD_REF_OCCURRENCES) fail(`expected >=${EXPECTED_PROD_REF_OCCURRENCES} staging-ref occurrences, found ${stagingRefOccurrences}.`);
if(!out.includes(`'${stagingKey}'`)) fail('staging key missing from createClient position.');

mkdirSync(outputDir,{recursive:true});
writeFileSync(outputPath,out,'utf8');
console.log(`[generate-staging-artifact] PASS: wrote ${outputPath}`);
console.log('[generate-staging-artifact] DEF-1/DEF-2/DEF-3A + lvSync lifecycle patches applied');
console.log(`[generate-staging-artifact] production ref occurrences before: ${refOccurrences}`);
console.log('[generate-staging-artifact] production ref present after: false');
console.log(`[generate-staging-artifact] staging ref occurrences after: ${stagingRefOccurrences}`);
console.log('[generate-staging-artifact] key values: not logged');
