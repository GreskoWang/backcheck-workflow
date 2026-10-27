import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
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
const { BridgeStore } = await load('store.mjs');
const review = await load('delivery-review.mjs');
const groupPolicy = await load('group-policy.mjs');
const { createJobQueue } = await load('job-queue.mjs');
const { acquireInstanceLock } = await load('instance-lock.mjs');
const retry = fs.existsSync(path.join(bridge, 'src/delivery-review-retry.mjs'))
  ? await load('delivery-review-retry.mjs') : {};
const source = fs.readFileSync(path.join(bridge, 'src/bridge.mjs'), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf('async function runJob(job) {');
const end = source.indexOf('\nasync function shutdown(', start);
assert.ok(start >= 0 && end > start, 'production runJob could not be isolated');
const runSource = source.slice(start, end);
const cases = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function passAudit(revision = 7) {
  return { verdict: 'PASS', visual: { verdict: 'PASS' },
    document: { token: 'SYNTHETICDOC', revision_id: revision },
    stats: { errors: 0, blocked: 0 },
    receipt: { token: 'SYNTHETICDOC', revision_id: revision, verdict: 'PASS',
      script_version: 'fixture-v1', reviewer_id: 'fixture', layout_fingerprint: 'fixture-layout',
      generated_at: '2026-10-27T12:00:00Z' } };
}

async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-only-recovery-'));
  const stateDir = path.join(root, 'state');
  const store = new BridgeStore(stateDir);
  const requestId = 'RQ-REVIEW-RECOVERY';
  const job = { requestId, chatId:'oc_SYNTHETICREVIEW', sourceMessageCreatedAtMs:1793100000000, sourceMessageId: 'om_synthetic', status: 'queued',
    stage: 'verifying_delivery', codexThreadId: 'thread-fixture',
    codexThreadRequestId: requestId, codexThreadCreationMode: 'cli_visible_v1',
    codexCliAttemptStartedAt: '2026-10-27T11:00:00Z',
    dispatchScope: { decision: 'execute', scopeVersion: 1 },
    finalResponse: 'https://fixture.feishu.cn/docx/SYNTHETICDOC' };
  store.saveJobs([job]);
  const snapshot = path.join(root, 'snapshot.json');
  fs.writeFileSync(snapshot, JSON.stringify({ revision: 7, visual: 'initial' }));
  const manifestPath = review.reviewManifestPath(stateDir, requestId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ requestId,
    documents: [{ url: job.finalResponse, snapshotPath: snapshot }] }));
  const auditor = path.join(root, 'synthetic-auditor.py');
  fs.writeFileSync(auditor, '# Synthetic fingerprint only. runAudit is injected.\n');
  const envNames = ['FEISHU_REVIEW_AUDITOR', 'BACKGROUND_CHECK_WORKSPACE', 'BACKCHECK_CONFIG_PATH'];
  const oldEnvironment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.FEISHU_REVIEW_AUDITOR = auditor;
  process.env.BACKGROUND_CHECK_WORKSPACE = root;
  process.env.BACKCHECK_CONFIG_PATH = path.join(root, 'config/backcheck-local.json');
  const counts = { audits: 0, revisions: 0, research: 0, alerts: 0 };
  const behavior = { audit: () => passAudit(), revision: () => 7 };
  const context = {
    store, config: { stateDir, workspace: root },
    groupPolicies:[{chatId:'oc_SYNTHETICREVIEW',role:'regular_dispatch',enabled:true,researchEnabled:true,activationFromMs:1793000000000}],
    getGroupPolicy:groupPolicy.getGroupPolicy, acceptsGroupMessage:groupPolicy.acceptsGroupMessage,
    workflow:{onCompleted:async()=>{}}, activePreflightModel:'synthetic',
    canResumeDeliveryReview: review.canResumeDeliveryReview,
    logger: { info() {}, warn() {}, error() {} }, safeError: (e) => e.message,
    isThreadRecoveryError: () => false, reviewClient: {},
    queueUserAlert: () => { counts.alerts += 1; },
    runBackgroundCheck: async () => { counts.research += 1; throw new Error('Research must not run'); },
    readLatestFeishuRevision: async (_client, token) => {
      counts.revisions += 1; assert.equal(token, 'SYNTHETICDOC'); return behavior.revision();
    },
    verifyCompletedReports: (options) => review.verifyCompletedReports({ ...options,
      runAudit: async () => { counts.audits += 1; return behavior.audit(); } }),
  };
  const verifyStart = source.indexOf('async function verifyJobReports(options) {');
  const verifyEnd = source.indexOf('\nconst repliesInFlight', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart);
  context.deliveryAdapters = { verifySpecialArtifacts: async () => { throw new Error('special adapter not injected'); } };
  context.verifyJobReports = vm.runInNewContext(`(${source.slice(verifyStart,verifyEnd)})`, context);
  const run = vm.runInNewContext(`(${runSource})`, context);
  const x = { root, store, requestId, job, snapshot, auditor, manifestPath, counts, behavior, context,
    run: () => run(store.getJob(requestId)),
    inspect: () => retry.inspectDeliveryReviewRetry(store, { requestId, workspace: root }),
    requeue: (extra = {}) => {
      const inspected = retry.inspectDeliveryReviewRetry(store, { requestId, workspace: root });
      return retry.queueDeliveryReviewRetry(store, { requestId, workspace: root,
        expectedJobSha256: inspected.expectedJobSha256, expectedInputSha256: inspected.inputFingerprint,
        reason: 'Synthetic evidence or read error reviewed', ...extra });
    },
  };
  try { await fn(x); }
  finally {
    for (const name of envNames) {
      if (oldEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnvironment[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('cross-group intake holds and duplicates cannot enter review-only recovery', () => fixture(async (x) => {
  for (const patch of [{intakeHold:{reason:'synthetic'}},{duplicateOfRequestId:'RQ-OTHER'}]) {
    x.store.saveJobs([{...x.job,...patch}]);
    await x.run();
    assert.equal(x.counts.research,0); assert.equal(x.counts.audits,0);
    assert.notEqual(x.store.getJob(x.requestId).status,'completed');
  }
}));

function specialCheckpoint(x, {remote=false} = {}) {
  const artifact=path.join(x.root,'result.csv'); fs.writeFileSync(artifact,'subject,value\nfixture,1\n');
  const scope={decision:'execute',requestMode:'special_dispatch',assignments:[{code:'SPECIAL_OWNER',itemNumbers:['1'],subject:'fixture'}]};
  const finalResponse=remote?'https://fixture.feishu.cn/sheets/SYNTHETICSHEET':'Reviewed result.csv';
  const specialIntake={status:'ready',attachments:[],scope,structuredRequest:{requirements:{deliverables:['fixture table']}}};
  x.store.updateJob(x.requestId,{workflowKind:'special_research',deliveryReviewMode:'special_artifacts_v1',specialIntake,dispatchScope:scope,finalResponse});
  fs.writeFileSync(x.manifestPath,JSON.stringify({schemaVersion:1,requestId:x.requestId,
    sourceChatId:x.job.chatId,sourceMessageId:x.job.sourceMessageId,sourceDigest:'a'.repeat(64),
    artifacts:[{id:'A1',artifactType:remote?'feishu_sheet':'csv',assignments:scope.assignments,
      ...(remote?{url:finalResponse}:{localPath:artifact})}]}));
  return {artifact,scope,finalResponse};
}

test('special artifact checkpoint with a docx manifest is rejected without new research', () => fixture(async (x) => {
  specialCheckpoint(x);
  fs.writeFileSync(x.manifestPath,JSON.stringify({requestId:x.requestId,documents:[]}));
  await x.run();
  assert.equal(x.counts.research,0); assert.equal(x.counts.audits,0);
  assert.equal(x.store.getJob(x.requestId).reviewErrorCode,'review_evidence_invalid');
  assert.equal(x.store.getJob(x.requestId).stage,'verifying_delivery');
}));

test('special sheet checkpoint resumes its original validator with no research rerun', () => fixture(async (x) => {
  specialCheckpoint(x,{remote:true}); let calls=0;
  x.context.deliveryAdapters.verifySpecialArtifacts=async({job})=>{
    calls++; assert.ok(job.finalResponse.includes('/sheets/')); return {receipts:[{artifactId:'A1',verdict:'PASS'}]};
  };
  x.store.updateJob(x.requestId,{status:'running'});x.store.recoverInterruptedJobs();
  assert.equal(x.store.getJob(x.requestId).stage,'verifying_delivery');
  await x.run();
  assert.equal(calls,1); assert.equal(x.counts.research,0); assert.equal(x.counts.audits,0);
  assert.equal(x.store.getJob(x.requestId).status,'completed');
  assert.equal(x.store.getJob(x.requestId).codexCliAttemptStartedAt,x.job.codexCliAttemptStartedAt);
}));

test('special FAIL is preserved and unchanged evidence does not repeat semantic review', () => fixture(async (x) => {
  const {artifact}=specialCheckpoint(x);let calls=0;
  x.context.deliveryAdapters.verifySpecialArtifacts=async()=>{
    calls++;throw Object.assign(new Error('synthetic semantic rejection'),{code:'semantic_review_not_passed',verdict:'FAIL'});
  };
  await x.run(); assert.equal(x.store.getJob(x.requestId).reviewStatus,'FAIL');
  assert.throws(()=>x.requeue(),/review_inputs_unchanged/);
  fs.appendFileSync(artifact,'fixture-two,2\n');x.requeue();
  x.context.deliveryAdapters.verifySpecialArtifacts=async()=>{calls++;return {receipts:[{artifactId:'A1',verdict:'PASS'}]};};
  await x.run();assert.equal(calls,2);assert.equal(x.counts.research,0);
  assert.equal(x.store.getJob(x.requestId).status,'completed');
}));

test('special artifact edits during verification cannot commit a stale PASS', () => fixture(async (x) => {
  const {artifact}=specialCheckpoint(x);
  x.context.deliveryAdapters.verifySpecialArtifacts=async()=>{
    fs.appendFileSync(artifact,'changed-during-review,3\n');return {receipts:[{artifactId:'A1',verdict:'PASS'}]};
  };
  await x.run();assert.equal(x.store.getJob(x.requestId).status,'review_pending');
  assert.equal(x.store.getJob(x.requestId).reviewErrorCode,'review_checkpoint_changed');
  assert.equal(x.counts.research,0);
}));

test('special delivery holds and changed requirement images cannot enter review', () => fixture(async (x) => {
  specialCheckpoint(x);x.store.updateJob(x.requestId,{deliveryEligible:false});
  await x.run();assert.notEqual(x.store.getJob(x.requestId).status,'completed');
  assert.equal(x.counts.research,0);
  specialCheckpoint(x);x.store.updateJob(x.requestId,{deliveryEligible:true});
  const image=path.join(x.store.stateDir,'requirement.png');fs.writeFileSync(image,'original image fixture');
  const intake=x.store.getJob(x.requestId).specialIntake;
  intake.attachments=[{localPath:image,sha256:crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex')}];
  x.store.updateJob(x.requestId,{specialIntake:intake});
  fs.writeFileSync(image,'modified image fixture');await x.run();
  assert.equal(x.store.getJob(x.requestId).reviewErrorCode,'review_evidence_invalid');
  assert.equal(x.counts.research,0);
}));

test('fresh special artifact result retains the installed non-docx validator', () => fixture(async (x) => {
  const special=specialCheckpoint(x,{remote:true});
  x.store.updateJob(x.requestId,{stage:'scope_preflight',codexCliAttemptStartedAt:null,
    workflowKind:'special_research'});
  x.context.runBackgroundCheck=async()=>({threadId:x.job.codexThreadId,
    finalResponse:'https://fixture.feishu.cn/sheets/SYNTHETICSHEET',
    dispatchScope:special.scope,deliveryReviewMode:'special_artifacts_v1'});
  let specialCalls=0;
  x.context.deliveryAdapters.verifySpecialArtifacts=async({job})=>{
    specialCalls++; assert.ok(job.finalResponse.includes('/sheets/'));
    return {receipts:[{artifactId:'synthetic',verdict:'PASS'}]};
  };
  await x.run();
  assert.equal(specialCalls,1); assert.equal(x.counts.audits,0);
  assert.equal(x.store.getJob(x.requestId).status,'completed');
}));

test('pause during special artifact verification cannot be overwritten by PASS', () => fixture(async (x) => {
  const special=specialCheckpoint(x,{remote:true});
  x.store.updateJob(x.requestId,{stage:'scope_preflight',codexCliAttemptStartedAt:null,
    workflowKind:'special_research'});
  x.context.runBackgroundCheck=async()=>({threadId:x.job.codexThreadId,
    finalResponse:'https://fixture.feishu.cn/sheets/SYNTHETICSHEET',
    dispatchScope:special.scope,deliveryReviewMode:'special_artifacts_v1'});
  x.context.deliveryAdapters.verifySpecialArtifacts=async()=>{
    x.store.updateJob(x.requestId,{status:'paused'});
    return {receipts:[{artifactId:'synthetic',verdict:'PASS'}]};
  };
  await x.run(); assert.equal(x.store.getJob(x.requestId).status,'paused');
  assert.equal(x.counts.audits,0);
}));

test('completed CLI research goes directly to read-only review', () => fixture(async (x) => {
  await x.run();
  assert.equal(x.store.getJob(x.requestId).status, 'completed');
  assert.equal(x.store.getJob(x.requestId).reviewStatus, 'PASS');
  assert.equal(x.store.getJob(x.requestId).codexCliAttemptStartedAt, x.job.codexCliAttemptStartedAt);
  assert.deepEqual(x.counts, { audits: 1, revisions: 1, research: 0, alerts: 0 });
}));
test('revision read error preserves the review checkpoint and needs explicit retry', () => fixture(async (x) => {
  x.behavior.revision = () => { throw new Error('Synthetic revision outage'); };
  await x.run();
  const pending = x.store.getJob(x.requestId);
  assert.equal(pending.status, 'review_pending'); assert.equal(pending.stage, 'verifying_delivery');
  assert.equal(pending.reviewErrorCode, 'review_revision_read_failed');
  assert.equal(pending.reviewStatus, 'ERROR'); assert.equal(pending.completedAt, null);
  x.behavior.revision = () => 7;
  x.requeue(); await x.run();
  assert.equal(x.store.getJob(x.requestId).status, 'completed');
  assert.equal(x.counts.research, 0); assert.equal(x.counts.audits, 2);
}));
test('restart preserves the CLI review stage without clearing execution history', () => fixture(async (x) => {
  x.store.updateJob(x.requestId, { status: 'running' });
  x.store.recoverInterruptedJobs();
  const saved = x.store.getJob(x.requestId);
  assert.equal(saved.status, 'queued'); assert.equal(saved.stage, 'verifying_delivery');
  assert.equal(saved.codexCliAttemptStartedAt, x.job.codexCliAttemptStartedAt);
  await x.run(); assert.equal(x.counts.research, 0); assert.equal(x.counts.audits, 1);
}));
test('ordinary CLI execution guard remains in force', () => fixture(async (x) => {
  x.store.updateJob(x.requestId, { stage: 'executing' });
  assert.throws(() => x.store.prepareExecutionJob(x.requestId), /prior CLI execution/);
  x.store.recoverInterruptedJobs();
  assert.equal(x.store.getJob(x.requestId).status, 'recovery_required');
}));
test('review-only stage cannot enter the research preparation API', () => fixture(async (x) => {
  x.store.updateJob(x.requestId, { codexCliAttemptStartedAt: null });
  assert.throws(() => x.store.prepareExecutionJob(x.requestId), /delivery-review-only/);
}));
test('missing or foreign thread ownership never starts research', () => fixture(async (x) => {
  for (const patch of [{ codexThreadRequestId: 'RQ-OTHER' }, { codexThreadId: '' }]) {
    x.store.saveJobs([{ ...x.job, ...patch }]); await x.run();
    assert.notEqual(x.store.getJob(x.requestId).status, 'completed');
    assert.equal(x.counts.research, 0); assert.equal(x.counts.audits, 0);
  }
}));
test('report manifest must exactly cover the current final links and request', () => fixture(async (x) => {
  for (const manifest of [
    { requestId: 'RQ-OTHER', documents: [] },
    { requestId: x.requestId, documents: [{ url: 'https://fixture.feishu.cn/docx/OTHER', snapshotPath: x.snapshot }] },
  ]) {
    fs.writeFileSync(x.manifestPath, JSON.stringify(manifest));
    x.store.saveJobs([x.job]); await x.run();
    assert.equal(x.store.getJob(x.requestId).status, 'review_pending');
    assert.equal(x.store.getJob(x.requestId).reviewErrorCode, 'review_evidence_invalid');
    assert.equal(x.counts.research, 0); assert.equal(x.counts.audits, 0);
  }
}));
test('paused, handed-off, transferred and completed jobs remain unchanged', () => fixture(async (x) => {
  for (const status of ['paused', 'handed_off', 'transferred', 'completed']) {
    x.store.saveJobs([{ ...x.job, status }]);
    const before = fs.readFileSync(x.store.jobsPath);
    await x.run(); assert.ok(fs.readFileSync(x.store.jobsPath).equals(before), status);
    assert.equal(x.counts.research, 0); assert.equal(x.counts.audits, 0);
  }
}));
test('unchanged rejected review does not repeatedly requeue or audit', () => fixture(async (x) => {
  x.behavior.audit = () => ({ ...passAudit(), verdict: 'FAIL' });
  const queue = createJobQueue({ canRun: () => true,
    nextJob: () => x.store.listJobs().find((j) => j.status === 'queued'), runJob: () => x.run() });
  await queue(); await queue();
  assert.equal(x.counts.audits, 1); assert.equal(x.store.getJob(x.requestId).reviewStatus, 'FAIL');
  const before = fs.readFileSync(x.store.jobsPath);
  assert.throws(() => x.requeue(), /review_inputs_unchanged/);
  assert.ok(fs.readFileSync(x.store.jobsPath).equals(before));
}));
test('new evidence at the same document revision permits review only', () => fixture(async (x) => {
  x.behavior.audit = () => ({ ...passAudit(), verdict: 'BLOCKED' });
  await x.run();
  fs.writeFileSync(x.snapshot, JSON.stringify({ revision: 7, visual: 'newly verified' }));
  x.behavior.audit = () => passAudit(); x.requeue(); await x.run();
  const after = x.store.getJob(x.requestId);
  assert.equal(after.status, 'completed'); assert.equal(after.reviewLastFailure.status, 'BLOCKED');
  assert.equal(x.counts.research, 0);
}));
test('a changed live revision requires a matching revised snapshot', () => fixture(async (x) => {
  x.behavior.revision = () => 8; await x.run();
  assert.equal(x.store.getJob(x.requestId).reviewErrorCode, 'review_revision_changed');
  assert.throws(() => x.requeue(), /review_inputs_unchanged/);
  fs.writeFileSync(x.snapshot, JSON.stringify({ revision: 8, visual: 'new revision checked' }));
  x.behavior.audit = () => passAudit(8); x.requeue(); await x.run();
  assert.equal(x.store.getJob(x.requestId).reviewReceipts[0].revision_id, 8);
  assert.equal(x.counts.research, 0);
}));
test('scope and review implementation changes invalidate the rejection fingerprint', () => fixture(async (x) => {
  x.behavior.audit = () => ({ ...passAudit(), verdict: 'FAIL' }); await x.run();
  const old = x.inspect(); assert.equal(old.queueAllowed, false);
  x.store.updateJob(x.requestId, { dispatchScope: { decision: 'execute', scopeVersion: 2 } });
  assert.equal(x.inspect().queueAllowed, true);
  x.store.updateJob(x.requestId, { dispatchScope: x.job.dispatchScope });
  fs.appendFileSync(x.auditor, '# independently changed validator version\n');
  assert.equal(x.inspect().queueAllowed, true);
}));
test('stale retry inspection and repeated apply cannot change a newer state', () => fixture(async (x) => {
  x.behavior.revision = () => { throw new Error('Synthetic read error'); }; await x.run();
  const inspected = x.inspect();
  x.store.updateJob(x.requestId, { operatorNote: 'new observation' });
  assert.throws(() => x.requeue({ expectedJobSha256: inspected.expectedJobSha256 }), /changed since inspection/);
  x.requeue();
  assert.throws(() => x.requeue(), /pending delivery review/);
  assert.equal(x.store.getJob(x.requestId).reviewRetryCount, 1);
}));
test('helper, policy and approved config changes invalidate an unchanged failed snapshot', () => fixture(async (x) => {
  x.behavior.audit = () => ({ ...passAudit(), verdict: 'FAIL' }); await x.run();
  assert.equal(x.inspect().queueAllowed, false);
  for (const relative of ['team_merge_audit.py', 'business_risk_gate.py', 'disclaimer_gate.py',
    '背调风险提示.md', 'config/backcheck-local.json']) {
    const file = path.join(x.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'synthetic changed dependency');
    assert.equal(x.inspect().queueAllowed, true, relative);
    fs.rmSync(file); assert.equal(x.inspect().queueAllowed, false, relative);
  }
}));
test('snapshot changes after retry inspection cannot silently change the applied input', () => fixture(async (x) => {
  x.behavior.revision = () => { throw new Error('Synthetic read error'); }; await x.run();
  const inspected = x.inspect(); const before = fs.readFileSync(x.store.jobsPath);
  fs.appendFileSync(x.snapshot, '\n');
  assert.throws(() => x.requeue({ expectedInputSha256: inspected.inputFingerprint }), /inputs changed since inspection/);
  assert.ok(fs.readFileSync(x.store.jobsPath).equals(before));
}));
test('pending review can be explicitly paused and restart preserves that decision', () => fixture(async (x) => {
  x.behavior.revision = () => { throw new Error('Synthetic outage'); }; await x.run();
  x.store.pauseJob(x.requestId, { reason: 'Synthetic user pause' });
  const before = fs.readFileSync(x.store.jobsPath); x.store.recoverInterruptedJobs();
  assert.ok(fs.readFileSync(x.store.jobsPath).equals(before));
  assert.throws(() => x.requeue(), /pending delivery review/);
}));
test('historical failed-stage restoration requires an explicit switch and verified artifacts', () => fixture(async (x) => {
  x.store.updateJob(x.requestId, { status: 'failed', stage: 'failed', errorSummary: 'old review failure' });
  const inspection = x.inspect(); assert.equal(inspection.requiresLegacyRestore, true);
  assert.throws(() => x.requeue(), /explicit restore-review-checkpoint/);
  x.requeue({ restoreLegacyReview: true }); await x.run();
  assert.equal(x.store.getJob(x.requestId).status, 'completed');
  assert.equal(x.store.getJob(x.requestId).reviewRestoredFrom.stage, 'failed');
  assert.equal(x.counts.research, 0);
}));
test('a user pause during asynchronous revision verification cannot be overwritten by PASS', () => fixture(async (x) => {
  x.behavior.revision = () => { x.store.pauseJob(x.requestId, { reason: 'Pause during review' }); return 7; };
  await x.run();
  assert.equal(x.store.getJob(x.requestId).status, 'paused');
  assert.equal(x.store.getJob(x.requestId).stage, 'paused');
  assert.equal(x.store.getJob(x.requestId).reviewReceipts, undefined);
  assert.equal(x.counts.research, 0);
}));
test('legacy restart recovery can restore only the explicitly recorded review origin', () => fixture(async (x) => {
  x.store.updateJob(x.requestId, { status: 'recovery_required', stage: 'thread_recovery_required',
    recoveryFromStage: 'verifying_delivery', recoveryReason: 'Old CLI guard classified completed research' });
  assert.equal(x.inspect().requiresLegacyRestore, true);
  assert.throws(() => x.requeue(), /explicit restore-review-checkpoint/);
  x.requeue({ restoreLegacyReview: true }); await x.run();
  assert.equal(x.store.getJob(x.requestId).status, 'completed');
  assert.equal(x.counts.research, 0);
  x.store.saveJobs([{ ...x.job, status: 'recovery_required', stage: 'thread_recovery_required', recoveryFromStage: 'executing' }]);
  assert.throws(() => x.inspect(), /pending delivery review/);
}));
test('scope or snapshot edits during verification cannot commit a stale PASS', () => fixture(async (x) => {
  for (const kind of ['scope', 'snapshot']) {
    x.store.saveJobs([x.job]);
    x.behavior.revision = () => {
      if (kind === 'scope') x.store.updateJob(x.requestId, { dispatchScope: { decision: 'execute', scopeVersion: 3 } });
      else fs.appendFileSync(x.snapshot, '\n');
      return 7;
    };
    await x.run();
    assert.equal(x.store.getJob(x.requestId).status, 'review_pending');
    assert.equal(x.store.getJob(x.requestId).reviewErrorCode, 'review_checkpoint_changed');
    assert.equal(x.store.getJob(x.requestId).reviewReceipts, undefined);
  }
}));
test('real retry CLI inspects and queues with a byte-identical backup', () => fixture(async (x) => {
  x.behavior.revision = () => { throw new Error('Synthetic outage'); }; await x.run();
  const command = [path.join(bridge, 'scripts/retry-delivery-review.mjs'),
    '--request-id', x.requestId, '--state-dir', x.store.stateDir, '--workspace', x.root];
  const inspected = JSON.parse(execFileSync(process.execPath, command,
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const before = fs.readFileSync(x.store.jobsPath);
  const result = JSON.parse(execFileSync(process.execPath, [...command, '--apply',
    '--expected-job-sha256', inspected.expectedJobSha256, '--expected-input-sha256', inspected.inputFingerprint,
    '--reason', 'Synthetic read-only retry'],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.mode, 'review-only-queued');
  assert.ok(fs.readFileSync(result.backupPath).equals(before));
  assert.equal(x.store.getJob(x.requestId).stage, 'verifying_delivery');
  assert.equal(result.externalMessages, 0);
}));
test('real retry CLI refuses while the bridge instance lock is held', () => fixture(async (x) => {
  x.behavior.revision = () => { throw new Error('Synthetic outage'); }; await x.run();
  const inspection = x.inspect(); const before = fs.readFileSync(x.store.jobsPath);
  const lock = acquireInstanceLock(path.join(x.store.stateDir, 'bridge.instance.lock'));
  try {
    assert.throws(() => execFileSync(process.execPath, [path.join(bridge, 'scripts/retry-delivery-review.mjs'),
      '--request-id', x.requestId, '--state-dir', x.store.stateDir, '--workspace', x.root,
      '--apply', '--expected-job-sha256', inspection.expectedJobSha256,
      '--expected-input-sha256', inspection.inputFingerprint, '--reason', 'Synthetic locked test'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }), (error) => {
      assert.equal(error.status, 1, 'the real child must execute and reject the lock');
      assert.match(String(error.stderr), /code: 'INSTANCE_LOCKED'/u);
      return true;
    });
    assert.ok(fs.readFileSync(x.store.jobsPath).equals(before));
  } finally { lock.release(); }
}));

for (const item of tests) {
  try { await item.fn(); cases.push({ name: item.name, passed: true }); }
  catch (error) { cases.push({ name: item.name, passed: false, error: String(error.stack || error) }); }
}
const files = ['src/bridge.mjs', 'src/store.mjs', 'src/delivery-review.mjs', 'src/job-pause.mjs',
  'src/delivery-review-retry.mjs', 'scripts/retry-delivery-review.mjs'];
const report = { suite: 'U04 delivery-review-only recovery', platform: process.platform,
  node: process.version, repo, tests: cases.length, passed: cases.filter((x) => x.passed).length,
  failed: cases.filter((x) => !x.passed).length, realAccounts: 0, externalMessages: 0, realResearchThreads: 0,
  method: 'Production runJob isolated without bridge startup; real store, manifest, validator gate and retry CLI with synthetic audit/revision callbacks',
  sourceSha256: Object.fromEntries(files.filter((f) => fs.existsSync(path.join(bridge, f)))
    .map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(bridge, f))).digest('hex')])), cases };
const output = JSON.stringify(report, null, 2) + '\n';
if (args['--out']) { fs.mkdirSync(path.dirname(path.resolve(args['--out'])), { recursive: true }); fs.writeFileSync(args['--out'], output); }
process.stdout.write(output); process.exitCode = report.failed ? 1 : 0;
