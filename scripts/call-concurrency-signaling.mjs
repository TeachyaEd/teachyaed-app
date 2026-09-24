// scripts/call-concurrency-signaling.mjs
import { createClient } from '@supabase/supabase-js';

const URL = process.env.STAGING_SUPABASE_URL;
const ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.STAGING_SERVICE_ROLE_KEY; // verification-only client, never used to act on behalf of a pair

class Metrics {
  constructor() {
    this.samples = [];
    this.failures = [];
    this.requestCountsByPair = [];
  }
  record(s) { this.samples.push(s); }
  fail(step, pairIndex, err) { this.failures.push({ step, pairIndex, message: err?.message ?? String(err) }); }
  percentile(key, p) {
    const vals = this.samples.map((s) => s[key]).sort((a, b) => a - b);
    if (!vals.length) return null;
    return vals[Math.floor((p / 100) * (vals.length - 1))];
  }
  printPercentiles(keys, ps) {
    for (const k of keys) console.log(k, Object.fromEntries(ps.map((p) => [\`p\${p}\`, this.percentile(k, p)])));
  }
}

function countingFetch(counterRef) {
  const orig = fetch;
  return async (...args) => {
    counterRef.count++;
    return orig(...args);
  };
}

async function runPair(pairIndex, callerCreds, calleeCreds, calleeProfileId, metrics) {
  const counter = { count: 0 };
  const caller = createClient(URL, ANON_KEY, { global: { fetch: countingFetch(counter) } });
  const callee = createClient(URL, ANON_KEY, { global: { fetch: countingFetch(counter) } });

  const { error: signInErr1 } = await caller.auth.signInWithPassword(callerCreds);
  const { error: signInErr2 } = await callee.auth.signInWithPassword(calleeCreds);
  if (signInErr1 || signInErr2) return metrics.fail('sign_in', pairIndex, signInErr1 || signInErr2);

  const attemptId = crypto.randomUUID();
  const roomId = \`room-conc-\${pairIndex}-\${attemptId}\`;
  const t0 = performance.now();
  const { data: started, error: e1 } = await caller.rpc('start_call', { p_id: attemptId, p_room_id: roomId, p_callee_profile_id: calleeProfileId });
  const t1 = performance.now();
  if (e1 || !started || started.state !== 'ringing') return metrics.fail('start_call', pairIndex, e1 || new Error(\`unexpected state \${started?.state}\`));

  const { data: accepted, error: e2 } = await callee.rpc('accept_call', { p_id: attemptId });
  const t2 = performance.now();
  if (e2 || accepted?.state !== 'accepted') return metrics.fail('accept_call', pairIndex, e2 || new Error(\`unexpected state \${accepted?.state}\`));

  const { data: ended, error: e3 } = await caller.rpc('end_call', { p_id: attemptId });
  const t3 = performance.now();
  if (e3 || ended?.state !== 'ended') return metrics.fail('end_call', pairIndex, e3 || new Error(\`unexpected state \${ended?.state}\`));

  metrics.record({ pairIndex, attemptId, roomId, start_ms: t1 - t0, accept_ms: t2 - t1, end_ms: t3 - t2 });
  metrics.requestCountsByPair.push({ pairIndex, count: counter.count });
}

async function verifyZeroTolerance(pairs, metrics) {
  if (!SERVICE_ROLE_KEY) throw new Error('STAGING_SERVICE_ROLE_KEY required for post-run verification.');
  const admin = createClient(URL, SERVICE_ROLE_KEY);

  const attemptIds = metrics.samples.map((s) => s.attemptId);
  const { data: rows, error } = await admin.from('call_attempts').select('*').in('id', attemptIds);
  if (error) throw error;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const problems = [];

  let lostTransitions = 0;
  for (const s of metrics.samples) {
    const row = byId.get(s.attemptId);
    if (!row || row.state !== 'ended' || !row.accepted_at || !row.ended_at) lostTransitions++;
  }
  if (lostTransitions > 0) problems.push(\`lost transitions: \${lostTransitions}\`);

  const roomIdCounts = new Map();
  for (const row of rows) roomIdCounts.set(row.room_id, (roomIdCounts.get(row.room_id) || 0) + 1);
  const duplicateRoomIds = [...roomIdCounts.entries()].filter(([, c]) => c > 1);
  if (duplicateRoomIds.length > 0) problems.push(\`duplicate attempts: \${JSON.stringify(duplicateRoomIds)}\`);

  let crossTalk = 0;
  for (const s of metrics.samples) {
    const row = byId.get(s.attemptId);
    const pair = pairs[s.pairIndex];
    if (!row || row.callee_profile_id !== pair.calleeProfileId) crossTalk++;
  }
  if (crossTalk > 0) problems.push(\`stale cross-talk: \${crossTalk}\`);

  const stuck = rows.filter((r) => r.state === 'ringing' || r.state === 'accepted');
  if (stuck.length > 0) problems.push(\`stuck ringing/accepted rows: \${stuck.length}\`);

  let unauthorizedVisibility = 0;
  for (let i = 0; i < pairs.length; i++) {
    const other = metrics.samples[(i + 1) % metrics.samples.length];
    if (!other || other.pairIndex === i) continue;
    const caller = createClient(URL, ANON_KEY);
    await caller.auth.signInWithPassword(pairs[i].caller);
    const { data } = await caller.from('call_attempts').select('id').eq('id', other.attemptId);
    if (data && data.length > 0) unauthorizedVisibility++;
  }
  if (unauthorizedVisibility > 0) problems.push(\`unauthorized visibility: \${unauthorizedVisibility}\`);

  const stormy = metrics.requestCountsByPair.filter((r) => r.count > 6);
  if (stormy.length > 0) problems.push(\`request storms: \${JSON.stringify(stormy)}\`);

  return { problems, lostTransitions, duplicateRoomIds: duplicateRoomIds.length, crossTalk, stuck: stuck.length, unauthorizedVisibility, stormy: stormy.length };
}

async function main(n) {
  const raw = process.env.CALL_CONCURRENCY_FIXTURE_JSON;
  if (!raw) throw new Error('CALL_CONCURRENCY_FIXTURE_JSON not set -- run scripts/provision-staging-fixtures.mjs pairs <n> first.');
  const allPairs = JSON.parse(raw);
  if (allPairs.length < n) throw new Error(\`fixture has \${allPairs.length} pairs, need \${n}\`);
  const pairs = allPairs.slice(0, n);

  const metrics = new Metrics();
  await Promise.all(pairs.map((p, i) => runPair(i, p.caller, p.callee, p.calleeProfileId, metrics)));

  console.log(\`n=\${n} ok=\${metrics.samples.length} failed=\${metrics.failures.length}\`);
  if (metrics.failures.length) {
    console.error('failures:', JSON.stringify(metrics.failures, null, 2));
  }
  metrics.printPercentiles(['start_ms', 'accept_ms', 'end_ms'], [50, 90, 99]);

  const verification = await verifyZeroTolerance(pairs, metrics);
  console.log('zero-tolerance verification:', JSON.stringify(verification, null, 2));

  const hardFail = metrics.failures.length > 0 || verification.problems.length > 0;
  if (hardFail) {
    console.error('FAIL: n=' + n + ' had RPC failures and/or zero-tolerance violations -- see above.');
    process.exitCode = 1;
  } else {
    console.log('PASS: n=' + n + ', zero lost transitions, zero duplicate attempts, zero cross-talk, zero stuck rows, zero unauthorized visibility, zero request storms.');
  }
}

main(Number(process.argv[2] || 10));
