// scripts/provision-staging-fixtures.mjs
// Staging-only. Idempotent: safe to re-run -- checks for existing users by
// email before creating, and re-pushes secrets either way so a partially
// failed prior run can be repaired by re-running.
//
// Required env (read, never logged):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  -- staging project only
// Required on PATH: \`gh\`, authenticated with repo-secret write access.
//
// Usage:
//   node scripts/provision-staging-fixtures.mjs stranger
//   node scripts/provision-staging-fixtures.mjs pairs 50
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (not printed).');
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function genPassword() {
  return randomBytes(24).toString('base64url'); // never logged
}

function ghSecretSet(name, value) {
  const res = spawnSync('gh', ['secret', 'set', name], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  if (res.status !== 0) throw new Error(\`gh secret set \${name} failed (exit \${res.status})\`);
}

async function findUserByEmail(email) {
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) return found;
    if (data.users.length < 200) return null;
    page++;
  }
}

async function ensureUser(email, role, firstName, lastName, schoolId) {
  let user = await findUserByEmail(email);
  let password = null;
  if (!user) {
    password = genPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    user = data.user;
  } else {
    password = genPassword();
    const { error } = await admin.auth.admin.updateUserById(user.id, { password });
    if (error) throw error;
  }
  const { error: profErr } = await admin.from('profiles').upsert(
    { id: user.id, email, role, first_name: firstName, last_name: lastName, school_id: schoolId },
    { onConflict: 'id' },
  );
  if (profErr) throw profErr;
  return { id: user.id, email, password };
}

async function getStagingSchoolId() {
  const teacherEmail = process.env.STAGING_TEACHER_EMAIL;
  if (!teacherEmail) throw new Error('STAGING_TEACHER_EMAIL must be set to derive the target school_id.');
  const { data, error } = await admin.from('profiles').select('school_id').ilike('email', teacherEmail).maybeSingle();
  if (error) throw error;
  if (!data?.school_id) throw new Error('Could not resolve staging school_id from STAGING_TEACHER_EMAIL.');
  return data.school_id;
}

async function provisionStranger() {
  const schoolId = await getStagingSchoolId();
  const stranger = await ensureUser('e2e-stranger@teachyaed-staging.test', 'teacher', 'E2E', 'Stranger', schoolId);
  ghSecretSet('STAGING_STRANGER_EMAIL', stranger.email);
  ghSecretSet('STAGING_STRANGER_PASSWORD', stranger.password);
  console.log('Provisioned STAGING_STRANGER_EMAIL/STAGING_STRANGER_PASSWORD secrets (values not printed).');
}

async function provisionPairs(n) {
  const schoolId = await getStagingSchoolId();
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const caller = await ensureUser(\`e2e-conc-\${i}-caller@teachyaed-staging.test\`, 'teacher', 'E2E', \`ConcCaller\${i}\`, schoolId);
    const callee = await ensureUser(\`e2e-conc-\${i}-callee@teachyaed-staging.test\`, 'teacher', 'E2E', \`ConcCallee\${i}\`, schoolId);
    pairs.push({ caller: { email: caller.email, password: caller.password }, callee: { email: callee.email, password: callee.password }, calleeProfileId: callee.id });
  }
  ghSecretSet('CALL_CONCURRENCY_FIXTURE_JSON', JSON.stringify(pairs));
  console.log(\`Provisioned \${n} pairs into CALL_CONCURRENCY_FIXTURE_JSON secret (values not printed).\`);
}

const [, , mode, arg] = process.argv;
if (mode === 'stranger') {
  await provisionStranger();
} else if (mode === 'pairs') {
  const n = Number(arg || 50);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error('pairs count must be an integer between 1 and 200');
  await provisionPairs(n);
} else {
  console.error('Usage: node scripts/provision-staging-fixtures.mjs <stranger|pairs> [count]');
  process.exit(1);
}
