#!/usr/bin/env node
// Production recovery, lease and queue functions in a VM. No browser or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

function option(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; }
const repo = option('--repo');
if (!repo) { console.error('Usage: node test-recovery-health-validation.mjs --repo PATH [--out result.json]'); process.exit(2); }
const sourcePath = path.resolve(repo, 'skills/web-access/scripts/cdp-proxy.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');
function section(start, end) {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Missing production section: ${start}`);
  return source.slice(at, until);
}
const code = section('function queueForTarget(', 'async function detachSessionOrRetire(')
  + section('function requireLease(', 'function requestLeaseToken(')
  + section('async function withTargetLease(', 'function safeEqualToken(')
  + section('async function recoverTargetUnlocked(', 'function routeBudget(')
  + '\nasync function runRecoveryRoute() {\n'
  + section("    if (pathname === '/recover' && request.method === 'POST') {", '    const targetId = query.target;')
  + '\n}\n({runRecoveryRoute,withTargetLease,queueForTarget,recoverTargetUnlocked});';

class BrokerError extends Error {
  constructor(code, message, details, status) { super(message); this.name = 'BrokerError'; Object.assign(this, { code, details, status }); }
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = (promise) => promise.then(value => ({ value }), error => ({ error }));
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const validHealth = (ready = 'complete', title = 'Fixture page') => ({ result: { type: 'object', value: { title, ready } } });
function fixture({ result = validHealth(), stalled = true, quarantined = true } = {}) {
  const marker = Object.freeze({ code: 'target_lane_stalled', at: 'fixture' });
  const quarantine = Object.freeze({ code: 'cdp_timeout', method: 'Runtime.callFunctionOn', at: 'fixture' });
  const calls = [];
  const deadline = { remaining: () => 2000 };
  const context = {
    BrokerError, setTimeout, clearTimeout, Date, Map,
    stalledTargets: new Map(stalled ? [['page', marker]] : []),
    quarantinedTargets: new Map(quarantined ? [['page', quarantine]] : []),
    targetQueues: new Map(), sessions: new Map(),
    leases: new Map([['page', { owner: 'owner', token: 'lease', epoch: 7, lastUsedAt: Date.now() }]]),
    leaseExpired: lease => lease.expired === true, safeEqualToken: (a, b) => a === b,
    isOpen: () => true, browserSocket: {}, BUDGETS: { dom: 5000 },
    clearSessionByTarget: id => context.sessions.delete(id),
    detachSessionOrRetire: async (_id, _session, d, timeout) => {
      assert.equal(d, deadline); assert.equal(timeout, 700); return { status: 'detached' };
    },
    connectBrowser: async d => { assert.equal(d, deadline); },
    retireBrowserSocket: () => { throw new Error('Unexpected active-operation poison in short unit test'); },
    callFixedFunctionUnlocked: async (id, declaration, args, options) => {
      calls.push({ id, declaration, args, options }); return result;
    },
    pathname: '/recover', request: { method: 'POST', token: 'lease' },
    requestLeaseToken: request => request.token,
    query: { target: 'page' }, owner: 'owner', deadline, response: {},
    ok: (_response, value) => { context.responseValue = value; },
  };
  const api = vm.runInNewContext(code, context);
  return { context, api, calls, deadline, marker, quarantine };
}
function assertRetained(f) {
  assert.equal(f.context.stalledTargets.get('page'), f.marker, 'stalled lane must remain marked');
  assert.equal(f.context.quarantinedTargets.get('page'), f.quarantine, 'quarantine must remain unchanged');
  assert.equal(f.context.responseValue, undefined, 'failed recovery must not publish success');
}
function assertOriginalBudget(f) {
  assert.equal(f.calls.length, 1, 'health validation must not add retries');
  assert.equal(f.calls[0].options.deadline, f.deadline, 'original deadline must be retained');
  assert.equal(f.calls[0].options.timeoutMs, 5000, 'DOM health budget must remain 5 seconds');
}
const cases = [];
async function test(name, fn) {
  try { await fn(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error.message, code: error.code || null }); }
}

const invalidResults = [
  ['exception_details', { exceptionDetails: { text: 'Synthetic exception' }, result: { type: 'object', subtype: 'error' } }, 'runtime_exception'],
  ['exception_even_with_valid_value', { ...validHealth(), exceptionDetails: { text: 'Synthetic exception' } }, 'runtime_exception'],
  ['missing_value', { result: { type: 'undefined' } }, 'invalid_health'],
  ['unrelated_object', { result: { value: { unrelated: true } } }, 'invalid_health'],
  ['null_protocol_result', null, 'invalid_health'],
  ['null_health', { result: { value: null } }, 'invalid_health'],
  ['array_health', { result: { value: [] } }, 'invalid_health'],
  ['scalar_health', { result: { value: 'complete' } }, 'invalid_health'],
  ['missing_title', { result: { value: { ready: 'complete' } } }, 'invalid_health'],
  ['non_string_title', { result: { value: { title: 5, ready: 'complete' } } }, 'invalid_health'],
  ['missing_ready', { result: { value: { title: '' } } }, 'invalid_health'],
  ['invalid_ready', { result: { value: { title: '', ready: 'healthy' } } }, 'invalid_health'],
  ['oversized_title', validHealth('complete', 'x'.repeat(1001)), 'invalid_health'],
];
for (const [name, result, reason] of invalidResults) {
  await test(`reject_${name}_and_keep_isolation`, async () => {
    const f = fixture({ result });
    await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'recovery_probe_failed' && e.status === 502 && e.details.reason === reason);
    assertRetained(f); assertOriginalBudget(f);
  });
}
for (const [ready, title] of [['complete', 'Fixture page'], ['loading', ''], ['interactive', ''], ['complete', '文'.repeat(1000)]]) {
  await test(`accept_${ready}_${title ? 'title' : 'blank_title'}_${title.length}`, async () => {
    const f = fixture({ result: validHealth(ready, title) });
    await f.api.runRecoveryRoute();
    assert.deepEqual(plain(f.context.responseValue), { targetId: 'page', recovered: true, page: { title, ready } });
    assert.equal(f.context.quarantinedTargets.has('page'), false);
    assert.equal(f.context.stalledTargets.has('page'), false);
    assertOriginalBudget(f);
  });
}
for (const code of ['cdp_timeout', 'request_timeout', 'request_aborted', 'connection_lost', 'outcome_unknown']) {
  await test(`preserve_${code}_without_retry`, async () => {
    const f = fixture();
    const expected = new BrokerError(code, 'Synthetic failure', { outcomeUnknown: true }, 504);
    let calls = 0;
    f.context.callFixedFunctionUnlocked = async (_id, _fn, _args, options) => {
      calls++; assert.equal(options.deadline, f.deadline); throw expected;
    };
    await assert.rejects(f.api.runRecoveryRoute(), e => e === expected);
    assert.equal(calls, 1); assertRetained(f);
  });
}
for (const [name, configure, code] of [
  ['wrong_owner', c => { c.owner = 'other'; }, 'lease_conflict'],
  ['wrong_lease', c => { c.request.token = 'other'; }, 'lease_conflict'],
  ['expired_lease', c => { c.leases.get('page').expired = true; }, 'lease_expired'],
  ['missing_lease', c => { c.leases.clear(); }, 'lease_required'],
]) {
  await test(`${name}_cannot_recover_or_clear_markers`, async () => {
    const f = fixture(); configure(f.context);
    await assert.rejects(f.api.runRecoveryRoute(), e => e.code === code);
    assert.equal(f.calls.length, 0); assertRetained(f);
  });
}
await test('changed_lease_epoch_cannot_clear_quarantine', async () => {
  const f = fixture();
  f.context.callFixedFunctionUnlocked = async () => {
    f.context.leases.set('page', { ...f.context.leases.get('page'), epoch: 8 }); return validHealth();
  };
  await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'lease_changed'); assertRetained(f);
});
await test('changed_owner_during_probe_cannot_clear_quarantine', async () => {
  const f = fixture();
  f.context.callFixedFunctionUnlocked = async () => {
    f.context.leases.set('page', { ...f.context.leases.get('page'), owner: 'other' }); return validHealth();
  };
  await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'lease_conflict'); assertRetained(f);
});
await test('reconnect_failure_preserves_markers_and_original_deadline', async () => {
  const f = fixture(); f.context.sessions.set('page', 'old-session');
  f.context.detachSessionOrRetire = async (_id, _session, deadline, timeout) => {
    assert.equal(deadline, f.deadline); assert.equal(timeout, 700); return { status: 'connection_retired' };
  };
  f.context.connectBrowser = async deadline => { assert.equal(deadline, f.deadline); throw new BrokerError('approval_required', 'Synthetic refusal'); };
  await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'approval_required');
  assert.equal(f.calls.length, 0); assertRetained(f);
});
await test('expired_request_does_not_admit_recovery_or_clear_stall', async () => {
  const f = fixture(); f.deadline.remaining = () => { throw new BrokerError('request_timeout', 'Synthetic exhausted budget'); };
  await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'request_timeout');
  assert.equal(f.calls.length, 0); assertRetained(f);
});
await test('deadline_expiring_after_health_reply_cannot_clear_markers', async () => {
  const f = fixture(); let expired = false;
  f.deadline.remaining = () => { if (expired) throw new BrokerError('request_timeout', 'Synthetic exhausted budget'); return 2000; };
  f.context.callFixedFunctionUnlocked = async () => { expired = true; return validHealth(); };
  await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'request_timeout'); assertRetained(f);
});
await test('cancellation_after_health_reply_cannot_clear_markers', async () => {
  const f = fixture(), controller = new AbortController();
  f.deadline.signal = controller.signal;
  f.deadline.remaining = () => { if (controller.signal.aborted) throw new BrokerError('request_aborted', 'Synthetic caller cancellation'); return 2000; };
  f.context.callFixedFunctionUnlocked = async () => { controller.abort('request_aborted'); return validHealth(); };
  await assert.rejects(f.api.runRecoveryRoute(), e => e.code === 'request_aborted'); assertRetained(f);
});
await test('ordinary_reads_and_navigation_remain_blocked_during_recovery', async () => {
  const f = fixture(), entered = deferred(), finish = deferred();
  f.context.callFixedFunctionUnlocked = async () => { entered.resolve(); return await finish.promise; };
  const running = settle(f.api.runRecoveryRoute()); await entered.promise;
  const markerWhileRunning = f.context.stalledTargets.get('page');
  let ordinaryCalls = 0;
  const ordinary = ['read', 'navigate'].map(() => settle(f.api.withTargetLease('page', 'owner', 'lease', f.deadline, async () => { ordinaryCalls++; })));
  const blockedBeforeFinish = await Promise.race([Promise.all(ordinary), pause(20).then(() => null)]);
  finish.resolve(validHealth()); const outcome = await running; const outcomes = await Promise.all(ordinary);
  assert.equal(outcome.error, undefined); assert.equal(markerWhileRunning, f.marker);
  assert.ok(blockedBeforeFinish, 'ordinary operations must be rejected while recovery is still active');
  assert.ok(outcomes.every(x => x.error?.code === 'target_lane_stalled'));
  assert.equal(ordinaryCalls, 0);
  assert.equal(f.context.stalledTargets.has('page'), false);
});
await test('recovery_bypass_still_waits_for_an_existing_active_lane', async () => {
  const f = fixture({ stalled: false, quarantined: false }), entered = deferred(), finish = deferred();
  let priorActive = true, overlap = false;
  const previous = settle(f.api.queueForTarget('page', f.deadline, async () => { entered.resolve(); await finish.promise; priorActive = false; }));
  await entered.promise;
  f.context.stalledTargets.set('page', f.marker); f.context.quarantinedTargets.set('page', f.quarantine);
  f.context.callFixedFunctionUnlocked = async () => { if (priorActive) overlap = true; return validHealth(); };
  const recovery = settle(f.api.runRecoveryRoute());
  await pause(10); const laneWhileWaiting = f.context.targetQueues.get('page');
  finish.resolve(); await previous; const outcome = await recovery;
  assert.equal(outcome.error, undefined); assert.ok(laneWhileWaiting);
  assert.equal(overlap, false, 'allowStalled must not bypass an active serial queue');
});

const report = {
  suite: 'U01 recovery health, isolation, ownership and queue validation',
  runtime: process.version, sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'),
  scope: 'Extracted production functions and actual recovery route in an isolated VM',
  networkUsed: false, liveBrowserUsed: false, passed: cases.filter(x => x.passed).length, total: cases.length,
  allPassed: cases.every(x => x.passed), cases,
};
console.log(JSON.stringify(report, null, 2));
if (option('--out')) { const out = path.resolve(option('--out')); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
if (!report.allPassed) process.exitCode = 1;
