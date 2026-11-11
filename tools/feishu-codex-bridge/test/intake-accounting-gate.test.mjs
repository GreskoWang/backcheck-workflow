import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {assertAccountingConfirmed} from '../src/intake-accounting-gate.mjs';
import {runBackgroundCheck, isThreadRecoveryError} from '../src/codex-runner.mjs';
import {applyResolvedIntake} from '../src/dispatch-intake-effects.mjs';
import {BridgeStore} from '../src/store.mjs';
import {resolveGroupPolicies, getGroupPolicy, acceptsGroupMessage, LEGACY_DISPATCH_CHAT_ID} from '../src/group-policy.mjs';

test('unresolved or disabled accounting without a verified off policy never passes the intake boundary',()=>{
  for(const accountingStatus of [undefined,'disabled','partial','blocked']) {
    assert.throws(()=>assertAccountingConfirmed({accountingStatus}),{code:'ACCOUNTING_INTAKE_BLOCKED'});
  }
  assert.doesNotThrow(()=>assertAccountingConfirmed({accountingStatus:'recorded'}));
});

test('an unattributed sheet match aborts intake before the dispatcher or receipt runs',async()=>{
  const job={requestId:'RQ-CUTOVER-DUPLICATE',requestText:'【背调需求10.17】\nTS\n1、已记账测试对象',
    dispatchScope:{decision:'execute',requestMode:'team_dispatch',assignments:[{code:'TS',itemNumbers:['1'],subject:'已记账测试对象',anchors:[],sourceBlock:'第1个【背调需求10.17】块'}],receiptAssignments:[{code:'TS',itemNumbers:['1'],subject:'已记账测试对象',sourceBlock:'第1个【背调需求10.17】块'}],ambiguousItems:[],deadline:'',reason:'isolated regression'}};
  let receipts=0,dispatches=0;
  await assert.rejects(()=>runBackgroundCheck(job,{codexDispatchMode:'desktop_native_handoff_v1'}, {
    onScopeResolved(){assertAccountingConfirmed({accountingStatus:'partial',accountingBlocked:[{reason:'existing_subject_unattributed'}]});receipts++;},
    desktopDispatcher:{dispatch(){dispatches++;throw new Error('must not run');}},
    onThreadBootstrapped(){},onResearchStarted(){},
  }),{code:'ACCOUNTING_INTAKE_BLOCKED'});
  assert.equal(receipts,0);assert.equal(dispatches,0);
});

function intakeFixture(t, { accounting = false, result, prior = {}, policyPatch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TEMP_ROOT || os.tmpdir(), 'accounting-intake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new BridgeStore(path.join(root, 'state'));
  store.setBinding({ chatId: LEGACY_DISPATCH_CHAT_ID });
  const activation = 1794400000000;
  const policies = resolveGroupPolicies({ localConfig: {
    target_chat_id: LEGACY_DISPATCH_CHAT_ID, listener_enabled: true,
    acceptance_replies_enabled: false, ...(accounting === null ? {} : { accounting: { enabled: accounting } }),
  }, binding: store.getBinding(), runtime: { acceptNewMessagesFromMs: activation, acceptanceRepliesFromMs: activation } });
  const policy = { ...policies[0], ...policyPatch };
  const job = { requestId: 'RQ-20261111-ACCOUNTING', sourceMessageId: 'om_accounting_fixture',
    chatId: LEGACY_DISPATCH_CHAT_ID, sourceMessageCreatedAtMs: activation + 1,
    status: 'running', requestText: '【背调需求11.11】\nTS\n1、独立测试对象',
    dispatchScope: { decision: 'execute', requestMode: 'team_dispatch',
      assignments: [{ code: 'TS', itemNumbers: ['1'], subject: '独立测试对象', anchors: [], sourceBlock: '第1个【背调需求11.11】块' }],
      receiptAssignments: [{ code: 'TS', itemNumbers: ['1'], subject: '独立测试对象', sourceBlock: '第1个【背调需求11.11】块' }],
      ambiguousItems: [], deadline: '', reason: 'offline fixture' }, ...prior };
  store.addJob(job);
  const calls = { accounting: 0, send: 0, dispatch: 0, research: 0 };
  const execution = () => runBackgroundCheck(store.prepareExecutionJob(job.requestId), {
    workspace: root, stateDir: store.stateDir, codexDispatchMode: 'desktop_native_handoff_v1',
  }, {
    onScopeResolved: (scope, metadata) => applyResolvedIntake({ job, scope, metadata, policy, store,
      recordAccounting: async () => { calls.accounting++; if (result instanceof Error) throw result;
        return result ?? { status: 'recorded', recorded: 1, blocked: [] }; },
      send: async () => { calls.send++; throw new Error('receipt must stay disabled'); } }),
    desktopDispatcher: {
      async dispatch() { calls.dispatch++; return { threadId: 'thread-accounting-fixture', sessionPath: path.join(root, 'fixture-session.jsonl') }; },
      async waitForResearchStart() { return { threadId: 'thread-accounting-fixture', fixture: true }; },
    },
    onThreadBootstrapped: (id) => store.bindExecutionThread(job.requestId, id),
    onResearchStarted: () => { calls.research++; },
  });
  return { root, store, job, policy, calls, execution };
}

test('explicitly disabled accounting reaches the production research path without ledger or group calls', async t => {
  const f = intakeFixture(t);
  const result = await f.execution();
  assert.equal(result.handedOff, true);
  assert.deepEqual(f.calls, { accounting: 0, send: 0, dispatch: 1, research: 1 });
  const saved = new BridgeStore(f.store.stateDir).getJob(f.job.requestId);
  assert.equal(saved.accountingStatus, 'disabled');
  assert.equal(saved.accountingRecorded, undefined);
  assert.equal(saved.codexThreadRequestId, f.job.requestId);
  assert.equal(saved.codexThreadId, 'thread-accounting-fixture');
  assert.equal(saved.requestText, f.job.requestText);
  assert.equal(saved.sourceMessageId, f.job.sourceMessageId);
});

test('ordinary bridge entry honors disabled accounting and retains the enabled confirmation gate', async t => {
  const source = fs.readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = source.indexOf('async function runJob(job) {');
  const end = source.indexOf('\nasync function shutdown(', start);
  assert.ok(start >= 0 && end > start);
  for (const { accounting, result, starts } of [
    { accounting: false, starts: true },
    { accounting: true, result: { status: 'recorded', recorded: 1 }, starts: true },
    { accounting: true, result: { status: 'blocked', recorded: 0 }, starts: false },
    { accounting: true, result: {}, starts: false },
  ]) {
    const f = intakeFixture(t, { accounting });
    // Execute the production entry without starting its listener, as in the
    // existing repair integration tests. Only external boundaries are fakes.
    const run = vm.runInNewContext(`(${source.slice(start, end)})`, {
      store: f.store, getGroupPolicy, acceptsGroupMessage, applyResolvedIntake, isThreadRecoveryError,
      groupPolicies: [f.policy], config: { workspace: f.root, stateDir: f.store.stateDir, codexDispatchMode: 'desktop_native_v1' },
      activePreflightModel: 'offline-fixture', pricingRegistry: {}, acceptanceFromMs: f.policy.activationFromMs,
      logger: { info() {}, warn() {}, error() {} }, safeError: error => error.message,
      queueUserAlert() {}, reviewClient: {}, accountingClient: () => ({}), alertAppId: 'synthetic', channel: {},
      recordDispatchAccounting: async () => { f.calls.accounting++; return result; },
      sendTextReplyIdempotent: async () => { f.calls.send++; throw new Error('unexpected group message'); },
      runBackgroundCheck: (job, config, hooks) => runBackgroundCheck(job, config, { ...hooks, desktopDispatcher: {
        dispatch: async () => { f.calls.dispatch++; return { threadId: 'thread-accounting-fixture', sessionPath: path.join(f.root, 'fixture-session.jsonl') }; },
        // Stop after startup without pretending a real investigation completed.
        waitForCompletion: async () => { throw new Error('offline fixture stops after execution entry'); },
      } }),
    });
    await run(f.job);
    const saved = new BridgeStore(f.store.stateDir).getJob(f.job.requestId);
    assert.deepEqual(f.calls, { accounting: accounting ? 1 : 0, send: 0, dispatch: starts ? 1 : 0, research: 0 });
    assert.equal(saved.status, starts ? 'recovery_required' : 'failed');
    assert.equal(saved.codexThreadId, starts ? 'thread-accounting-fixture' : null);
    assert.equal(saved.accountingStatus, accounting ? result.status : 'disabled');
    assert.equal(saved.requestText, f.job.requestText);
    assert.equal(saved.sourceMessageId, f.job.sourceMessageId);
  }
});

test('enabled accounting still requires a confirmed result before research', async t => {
  const ok = intakeFixture(t, { accounting: true });
  assert.equal((await ok.execution()).handedOff, true);
  assert.deepEqual(ok.calls, { accounting: 1, send: 0, dispatch: 1, research: 1 });
  assert.equal(ok.store.getJob(ok.job.requestId).accountingStatus, 'recorded');
  for (const result of [{}, { status: 'partial', recorded: 0, blocked: [{ reason: 'existing_subject_unattributed' }] },
    { status: 'blocked' }, { status: 'disabled' }, { status: 'unconfirmed' },
    new Error('ledger authorization missing'), new Error('write result uncertain')]) {
    const f = intakeFixture(t, { accounting: true, result });
    await assert.rejects(f.execution, { code: 'ACCOUNTING_INTAKE_BLOCKED' });
    assert.deepEqual(f.calls, { accounting: 1, send: 0, dispatch: 0, research: 0 });
  }
});

test('turning accounting off cannot release prior failed or uncertain accounting', async t => {
  for (const prior of [{ accountingStatus: 'partial' }, { accountingStatus: 'blocked' },
    { accountingStatus: 'uncertain' }, { accountingStatus: 'pending' },
    { accountingStatus: 'disabled', accountingError: 'unconfirmed prior write' },
    { accountingBlocked: [{ reason: 'existing_subject_unattributed' }] }, { accountingRecorded: 1 }]) {
    const f = intakeFixture(t, { prior });
    await assert.rejects(f.execution, { code: 'ACCOUNTING_INTAKE_BLOCKED' });
    assert.deepEqual(f.calls, { accounting: 0, send: 0, dispatch: 0, research: 0 });
    const saved = f.store.getJob(f.job.requestId);
    for (const [key, value] of Object.entries(prior)) assert.deepEqual(saved[key], value);
  }
});

test('missing policy configuration or other group permissions do not become a disabled-accounting waiver', async t => {
  const missing = intakeFixture(t, { accounting: null });
  await assert.rejects(missing.execution, { code: 'ACCOUNTING_INTAKE_BLOCKED' });
  assert.deepEqual(missing.calls, { accounting: 0, send: 0, dispatch: 0, research: 0 });
  for (const policyPatch of [{ enabled: false }, { researchEnabled: false },
    { chatId: 'oc_other' }, { role: 'regular_delivery' }, { activationFromMs: null }]) {
    const f = intakeFixture(t, { policyPatch });
    await assert.rejects(f.execution, { code: 'ACCOUNTING_INTAKE_BLOCKED' });
    assert.deepEqual(f.calls, { accounting: 0, send: 0, dispatch: 0, research: 0 });
  }
});
