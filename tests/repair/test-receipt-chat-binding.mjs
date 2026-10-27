import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--repo', '--out'].includes(key) || !value || args[key]) throw new Error('Use --repo PATH [--out FILE]');
  args[key] = value;
}
if (!args['--repo']) throw new Error('--repo is required');
const repo = fs.realpathSync(args['--repo']);
const bridge = path.join(repo, 'tools/feishu-codex-bridge');
if (args['--out'] && fs.existsSync(args['--out'])) throw new Error('refusing to overwrite prior test output');
const load = (file) => import(pathToFileURL(path.join(bridge, 'src', file)));
const { sendAcceptanceReceiptOnce } = await load('acceptance-receipt.mjs');
const { BridgeStore } = await load('store.mjs');
const { canResumeDeliveryReview } = await load('delivery-review.mjs');
const { localExecutionScope } = await load('dispatch-scope.mjs');
const {applyResolvedIntake} = await load('dispatch-intake-effects.mjs');
const {getGroupPolicy, acceptsGroupMessage} = await load('group-policy.mjs');
const {recordScopePreflightFailure} = await load('preflight-failure.mjs');
function syntheticPolicy(chatId) {
  return {chatId,role:'regular_dispatch',enabled:true,researchEnabled:true,
    accountingEnabled:true,acceptanceRepliesEnabled:true,activationFromMs:1000,acceptanceFromMs:1000};
}

const cases = [], tests = [];
const test = (name, fn) => tests.push({ name, fn });
function fixture(chatId = 'oc_verifiednewgroup') {
  const job = { requestId: 'RQ-RECEIPT-NEW', status: 'running', stage: 'scope_resolved',
    codexThreadRequestId: 'RQ-RECEIPT-NEW', chatId, sourceMessageId: 'om_fixture',
    sourceMessageCreatedAtMs: 2000 };
  let binding = { chatId };
  const calls = [], updates = [];
  const options = { store: { getJob: () => structuredClone(job), getBinding: () => binding,
    updateJob: (_id, patch) => { updates.push(structuredClone(patch)); Object.assign(job, patch); } },
    requestId: job.requestId, scope: { decision: 'execute', requestMode: 'team_dispatch',
      receiptAssignments: [{ code: 'TS', itemNumbers:['1'], subject: 'Synthetic' }], assignments: [{ code: 'TS', itemNumbers:['1'], subject: 'Synthetic' }] },
    enabled: true, allowedChatId: chatId, acceptanceFromMs: 1000, maxChars: 6000,
    formatText: () => 'Synthetic allocation receipt',
    send: async (item) => { calls.push(item); return 'om_synthetic_receipt'; } };
  return { job, options, calls, updates, setBinding: (next) => { binding = next; } };
}
test('a fully configured new group receives exactly one synthetic receipt', async () => {
  const x = fixture(); assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'sent');
  assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'already_attempted');
  assert.equal(x.calls.length, 1); assert.equal(x.calls[0].chatId, x.options.allowedChatId);
  assert.equal(x.updates[0].acceptanceSendOutcome, 'pending_confirmation');
});
test('a coincidentally matching legacy suffix grants no authority', async () => {
  const x = fixture('oc_unapproved92ed04'); x.options.allowedChatId = 'oc_authorized92ed04';
  const result = await sendAcceptanceReceiptOnce(x.options);
  assert.equal(result.status, 'ineligible'); assert.equal(result.reason, 'acceptance_chat_binding_mismatch');
  assert.equal(x.calls.length, 0); assert.equal(x.updates.length, 0);
});
test('an existing suffix group works when its full ID is explicitly configured', async () => {
  const x = fixture('oc_authorized92ed04');
  assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'sent'); assert.equal(x.calls.length, 1);
});
test('missing receipt chat configuration cannot be inferred from the incoming job', async () => {
  const x = fixture('oc_fixture92ed04'); delete x.options.allowedChatId;
  assert.equal((await sendAcceptanceReceiptOnce(x.options)).reason, 'acceptance_chat_not_configured');
  assert.equal(x.calls.length, 0);
});
test('malformed and padded full IDs fail closed', async () => {
  for (const allowedChatId of ['', 'not-a-chat', 'oc_', ' oc_fixture92ed04', 'oc_fixture92ed04 ']) {
    const x = fixture('oc_fixture92ed04'); x.options.allowedChatId = allowedChatId;
    assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'ineligible');
    assert.equal(x.calls.length, 0);
  }
});
test('the verified binding and message chat must both equal the configured group', async () => {
  for (const kind of ['binding', 'message']) {
    const x = fixture('oc_fixture92ed04');
    if (kind === 'binding') x.setBinding({ chatId: 'oc_other92ed04' });
    else x.job.chatId = 'oc_other92ed04';
    assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'ineligible');
    assert.equal(x.calls.length, 0);
  }
});
for (const kind of ['disabled', 'old_message', 'wrong_owner', 'scope_only', 'direct_request',
  'no_monitored_assignment', 'no_receipt_assignment', 'wrong_stage', 'missing_message_id']) {
  test(`${kind} still prevents every send`, async () => {
    const x = fixture();
    if (kind === 'disabled') x.options.enabled = false;
    if (kind === 'old_message') x.job.sourceMessageCreatedAtMs = 999;
    if (kind === 'wrong_owner') x.job.codexThreadRequestId = 'RQ-OTHER';
    if (kind === 'scope_only') x.job.scopeOnly = true;
    if (kind === 'direct_request') x.options.scope.requestMode = 'direct_request';
    if (kind === 'no_monitored_assignment') x.options.scope.assignments = [];
    if (kind === 'no_receipt_assignment') x.options.scope.receiptAssignments = [];
    if (kind === 'wrong_stage') x.job.stage = 'executing';
    if (kind === 'missing_message_id') x.job.sourceMessageId = '';
    assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, kind === 'disabled' ? 'disabled' : 'ineligible');
    assert.equal(x.calls.length, 0); assert.equal(x.job.acceptanceSendAttemptAt, undefined);
  });
}
test('an uncertain response is durably claimed and is never retried', async () => {
  const x = fixture(); let sends = 0;
  x.options.send = async () => { sends += 1; throw new Error('Synthetic lost response'); };
  assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'uncertain');
  assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'already_attempted');
  assert.equal(sends, 1); assert.equal(x.job.acceptanceSendOutcome, 'uncertain');
});
test('historical queued, attempted and suppressed receipts remain suppressed', async () => {
  for (const key of ['acceptanceQueuedAt', 'acceptanceSendAttemptAt', 'acceptanceSuppressedAt']) {
    const x = fixture(); x.job[key] = '2026-10-01T00:00:00Z';
    assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'already_attempted');
    assert.equal(x.calls.length, 0);
  }
});
test('oversized receipt text is rejected before claiming a send', async () => {
  const x = fixture(); x.options.maxChars = 5;
  assert.equal((await sendAcceptanceReceiptOnce(x.options)).status, 'preparation_failed');
  assert.equal(x.calls.length, 0); assert.equal(x.job.acceptanceSendAttemptAt, undefined);
});

async function productionWiring({ allowedChatId, expectedSend }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-wiring-'));
  try {
    const store = new BridgeStore(root); const x = fixture('oc_verifiednewgroup');
    const job = { ...x.job, status: 'queued', stage: 'queued' };
    store.saveJobs([job]); store.setBinding({ chatId: job.chatId });
    const source = fs.readFileSync(path.join(bridge, 'src/bridge.mjs'), 'utf8').replaceAll('\r\n', '\n');
    const start = source.indexOf('async function runJob(job) {');
    const end = source.indexOf('\nasync function shutdown(', start);
    assert.ok(start >= 0 && end > start);
    let sends = 0;
    const context = { store, applyResolvedIntake, getGroupPolicy, acceptsGroupMessage,
      recordScopePreflightFailure, pricingRegistry:{}, workflow:{onCompleted:async()=>{}},
      groupPolicies:[syntheticPolicy(typeof allowedChatId === 'undefined' ? job.chatId : allowedChatId)],
      config: { stateDir: root, workspace: root,
      feishuAcceptanceRepliesEnabled: true, feishuAcceptanceReplyChatId: allowedChatId, maxReplyChars: 6000 },
      activePreflightModel: 'synthetic-model', acceptanceFromMs: 1000,
      canResumeDeliveryReview, logger: { info() {}, warn() {}, error() {} },
      safeError: (e) => e.message, isThreadRecoveryError: () => false, queueUserAlert() {},
      accountingClient: () => ({}), reviewClient: {}, alertAppId: 'synthetic', channel: {},
      recordDispatchAccounting: async () => ({ status: 'recorded', recorded: [] }),
      assertAccountingConfirmed() {}, sendAcceptanceReceiptOnce,
      formatAcceptanceReply: () => 'Synthetic allocation receipt',
      sendTextReplyIdempotent: async (_channel, item) => {
        sends += 1; assert.equal(item.chatId, job.chatId); return 'om_synthetic_sent';
      },
      runBackgroundCheck: async (_job, _config, hooks) => {
        await hooks.onScopeResolved(x.options.scope, {});
        return { testOnly: true, dispatchScope: x.options.scope, finalResponse: 'Synthetic test result' };
      } };
    await vm.runInNewContext(`(${source.slice(start, end)})`, context)(job);
    assert.equal(sends, expectedSend);
    assert.equal(store.getJob(job.requestId).status, expectedSend ? 'completed' : 'intake_held');
    if (!expectedSend) assert.equal(store.getJob(job.requestId).stage, 'group_policy_hold');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('production runJob uses its exact configured group policy for the receipt helper', () =>
  productionWiring({ allowedChatId: 'oc_verifiednewgroup', expectedSend: 1 }));
test('production runJob retains a group-policy hold when no exact group is configured', () =>
  productionWiring({ allowedChatId: 'oc_foreigngroup', expectedSend: 0 }));

async function receiptOnlyDispatch(monitored) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-other-owner-'));
  try {
    const store = new BridgeStore(root); const x = fixture('oc_verifiednewgroup');
    const job = { ...x.job, status: 'queued', stage: 'queued' };
    store.saveJobs([job]); store.setBinding({ chatId: job.chatId });
    const scope = { decision: monitored ? 'execute' : 'no_owned_assignment', requestMode: 'team_dispatch',
      assignments: monitored ? ['TS1', '临H', 'BK2'].map((code,index) => ({ code, itemNumbers:[String(index+2)], subject: `Synthetic ${code}` })) : [],
      receiptAssignments: [{ code: 'TS2', itemNumbers:['1'], subject: 'Synthetic other member' }], ambiguousItems: [] };
    scope.receiptAssignments.push(...scope.assignments);
    const bridgeSource = fs.readFileSync(path.join(bridge, 'src/bridge.mjs'), 'utf8').replaceAll('\r\n', '\n');
    const runnerSource = fs.readFileSync(path.join(bridge, 'src/codex-runner.mjs'), 'utf8').replaceAll('\r\n', '\n');
    const start = bridgeSource.indexOf('async function runJob(job) {');
    const end = bridgeSource.indexOf('\nasync function shutdown(', start);
    const runnerStart = runnerSource.indexOf('export async function runBackgroundCheck(job, config, hooks = {}) {');
    assert.ok(runnerStart >= 0 && start >= 0 && end > start);
    const counts = { sends: 0, accounting: 0, localResearchStarts: 0 };
    const runBackgroundCheck = vm.runInNewContext(`(${runnerSource.slice(runnerStart).replace(/^export /u, '').trim()})`, {
      resolveDispatchScope: async () => ({ scope, usage: null, preflightModel: 'synthetic' }),
      localExecutionScope, formatDispatchScope: () => 'Synthetic receipt-only summary',
      getExecutionThreadPlan: () => { counts.localResearchStarts += 1; throw new Error('Unexpected research entry'); },
    });
    const context = { store, applyResolvedIntake, getGroupPolicy, acceptsGroupMessage,
      recordScopePreflightFailure, pricingRegistry:{}, workflow:{onCompleted:async()=>{}},
      groupPolicies:[syntheticPolicy(typeof allowedChatId === 'undefined' ? job.chatId : allowedChatId)],
      config: { stateDir: root, workspace: root,
      feishuAcceptanceRepliesEnabled: true, feishuAcceptanceReplyChatId: job.chatId, maxReplyChars: 6000 },
      activePreflightModel: 'synthetic', acceptanceFromMs: 1000, canResumeDeliveryReview,
      logger: { info() {}, warn() {}, error() {} }, safeError: (e) => e.message,
      isThreadRecoveryError: () => false, queueUserAlert() {}, accountingClient: () => ({}),
      reviewClient: {}, alertAppId: 'synthetic', channel: {},
      recordDispatchAccounting: async () => { counts.accounting += 1; return { status: 'recorded', recorded: [] }; },
      assertAccountingConfirmed() {}, sendAcceptanceReceiptOnce,
      formatAcceptanceReply: () => 'Synthetic full allocation receipt',
      sendTextReplyIdempotent: async () => { counts.sends += 1; return 'om_synthetic_receipt'; }, runBackgroundCheck };
    await vm.runInNewContext(`(${bridgeSource.slice(start, end)})`, context)(job);
    const saved = store.getJob(job.requestId);
    return { ...counts, status: saved.status, stage: saved.stage,
      localDecision: saved.dispatchScope?.decision, localAssignments: saved.dispatchScope?.assignments?.length };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('other-owner watched assignments receive a receipt and accounting without local research', async () => {
  const result = await receiptOnlyDispatch(true);
  assert.deepEqual(result, { sends: 1, accounting: 1, localResearchStarts: 0, status: 'completed',
    stage: 'scope_complete', localDecision: 'no_owned_assignment', localAssignments: 0 });
});

for (const t of tests) {
  try { await t.fn(); cases.push({ name: t.name, passed: true }); }
  catch (error) { cases.push({ name: t.name, passed: false, error: String(error.stack || error) }); }
}
const receiptOnlyOutsideWatched = await receiptOnlyDispatch(false);
const files = ['src/acceptance-receipt.mjs', 'src/bridge.mjs', 'src/config.mjs', 'src/codex-runner.mjs', 'src/dispatch-scope.mjs'];
const report = { suite: 'U06 full configured receipt chat binding', platform: process.platform,
  node: process.version, repo, tests: cases.length, passed: cases.filter((x) => x.passed).length,
  failed: cases.filter((x) => !x.passed).length,
  realAccounts: 0, externalMessages: 0, realResearchThreads: 0,
  method: 'Real receipt helper, production runJob and receipt-only runBackgroundCheck with synthetic callbacks and temporary stores',
  observationsExcludedFromPassCount: [{ id: 'only_non_monitored_members',
    result: receiptOnlyOutsideWatched, gap_observed: receiptOnlyOutsideWatched.sends === 0,
    interpretation: 'Dispatches with only members outside the watched six still receive no group allocation receipt. This conditional gap is not repaired by full-chat binding.' }],
  sourceSha256: Object.fromEntries(files.map((f) => [f,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(bridge, f))).digest('hex')])), cases };
const output = JSON.stringify(report, null, 2) + '\n';
if (args['--out']) { fs.mkdirSync(path.dirname(path.resolve(args['--out'])), { recursive: true }); fs.writeFileSync(args['--out'], output); }
process.stdout.write(output); process.exitCode = report.failed ? 1 : 0;
