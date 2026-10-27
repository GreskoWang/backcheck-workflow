import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDesktopNativePrompt } from '../src/desktop-native-dispatch.mjs';
import { completionJobFingerprint, createCompletionObserver, observeCompletedHandoff,
  inspectBoundSessionCompletion } from '../src/completion-observer.mjs';
import { reviewManifestPath, verifyCompletedReports } from '../src/delivery-review.mjs';

const requestId = 'RQ-20261026-TEST';
const threadId = '00000000-3538-7000-8000-46c9a76ce73d';
const chatId = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
const reportUrl = 'https://my.feishu.cn/docx/ApprovedReportFixture';
const receipt = { token: 'ApprovedReportFixture', revision_id: 2, verdict: 'PASS' };
const lifecycle = (type, turnId = 'turn-1', other = {}) =>
  ({ type: 'event_msg', payload: { type, turn_id: turnId, ...other } });
const complete = (turnId = 'turn-1') => lifecycle('task_complete', turnId, { last_agent_message: reportUrl });
const user = text => ({ type: 'response_item', payload: { type: 'message', role: 'user',
  content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const sessionsRoot = path.join(root, 'sessions');
  const stateDir = path.join(workspace, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsRoot);
  const instructionPath = path.join(workspace, 'instruction.md');
  const instruction = `Only ${requestId}`;
  fs.writeFileSync(instructionPath, instruction);
  const sessionPath = path.join(sessionsRoot, 'bound.jsonl');
  const job = {
    requestId, chatId, sourceMessageId: 'om_fixture', sourceMessageCreatedAtMs: 2000,
    status: 'handed_off', stage: 'research_started',
    codexThreadId: threadId, codexThreadRequestId: requestId,
    codexThreadCreationMode: 'desktop_native_handoff_v1', codexThreadSource: 'vscode',
    codexThreadOriginator: 'Codex Desktop', codexThreadSourceKind: 'user',
    codexNativeDispatchMarker: `FEISHU-NATIVE-${requestId}-nonce`,
    codexNativeInstructionPath: instructionPath,
    codexNativeInstructionSha256: crypto.createHash('sha256').update(instruction).digest('hex'),
    codexNativeSessionPath: sessionPath, codexThreadTitle: 'Fixture batch',
    handoffEvidence: { threadId, outputRecordIndex: 4 },
  };
  const prompt = buildDesktopNativePrompt({ requestId, threadTitle: job.codexThreadTitle,
    marker: job.codexNativeDispatchMarker, instructionPath,
    instructionSha256: job.codexNativeInstructionSha256 });
  const records = [
    { type: 'session_meta', payload: { id: threadId, session_id: threadId,
      cwd: workspace, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' } },
    lifecycle('task_started'),
    { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    user(prompt),
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'source-bearing test data' } },
    complete(),
  ];
  const write = (items = records) => fs.writeFileSync(sessionPath, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  const append = items => fs.appendFileSync(sessionPath, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  write();
  const authorization = { enabled: true, chatId, activatedFromMs: 1000 };
  let reviews = 0;
  const dependencies = { workspace, sessionsRoot, stateDir, readLatestRevision: async () => 2,
    verifyReports: async args => { reviews++; assert.equal(args.requestId, requestId);
      assert.equal(args.finalResponse, reportUrl); return [receipt]; }, ...options };
  return { root, workspace, sessionsRoot, stateDir, sessionPath, instructionPath, job, prompt,
    records, write, append, authorization, dependencies, reviews: () => reviews,
    observer: createCompletionObserver(dependencies) };
}

test('a bound latest completion is only eligible after independent live review; observer never mutates job', async t => {
  const f = fixture(t);
  const before = JSON.stringify(f.job);
  const result = await f.observer.observe(f.job, f.authorization);
  assert.equal(result.status, 'eligible');
  assert.equal(result.completion.turnId, 'turn-1');
  assert.equal(result.completion.threadId, threadId);
  assert.equal(result.expectedJobSha256, completionJobFingerprint(f.job));
  assert.deepEqual(result.reviewReceipts, [receipt]);
  assert.equal(f.reviews(), 1);
  assert.equal(JSON.stringify(f.job), before);
});

test('special artifacts require their own bound PASS receipt and do not fabricate document revisions', async t => {
  const artifactReceipt = { kind: 'special_artifact_review_v1', artifactId: 'A1', verdict: 'PASS',
    contentDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64),
    receiptId: 'd'.repeat(64), reviewedAt: new Date().toISOString() };
  const f = fixture(t, { verifyReports: async ({ job }) => {
    assert.equal(job.requestId, requestId); return [artifactReceipt];
  } });
  const special = { ...f.job, workflowKind: 'special_research', deliveryReviewMode: 'special_artifacts_v1' };
  const result = await f.observer.observe(special, f.authorization);
  assert.equal(result.status, 'eligible'); assert.equal(result.reviewReceipts[0].revision_id, undefined);
  f.observer.forget(requestId);
  assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'waiting');
});

test('handoff alone, disabled routes, other chats and pre-activation historical jobs never cause review', async t => {
  const f = fixture(t);
  for (const [job, auth] of [[{ ...f.job, status: 'completed' }, f.authorization],
    [f.job, null], [f.job, { ...f.authorization, enabled: false }],
    [f.job, { ...f.authorization, chatId: 'oc_other' }],
    [f.job, { ...f.authorization, activatedFromMs: 2001 }]]) {
    assert.equal((await f.observer.observe(job, auth)).status, 'ignored');
  }
  f.write(f.records.slice(0, -1));
  assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'waiting');
  assert.equal(f.reviews(), 0);
});

test('newer active, failed, aborted, input or tool activity invalidates an earlier completion', async t => {
  const f = fixture(t);
  for (const tail of [[lifecycle('task_started', 'turn-2')],
    [lifecycle('task_started', 'turn-2'), lifecycle('task_failed', 'turn-2')],
    [lifecycle('task_started', 'turn-2'), lifecycle('task_failed', 'turn-2'), complete('turn-2')],
    [lifecycle('turn_aborted')], [user('Continue this same batch')],
    [{ type: 'event_msg', payload: { type: 'user_message', message: 'Continue' } }],
    [{ type: 'response_item', payload: { type: 'custom_tool_call', name: 'fixture' } }]]) {
    f.observer.forget(requestId);
    f.write([...f.records, ...tail]);
    assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'waiting');
  }
  assert.equal(f.reviews(), 0);
});

test('uses the latest successful turn after a completed earlier turn and a later failure', async t => {
  const f = fixture(t);
  f.append([lifecycle('task_started', 'turn-2'), lifecycle('task_failed', 'turn-2'),
    lifecycle('task_started', 'turn-3'), user('Finish the same batch'), complete('turn-3')]);
  const result = await f.observer.observe(f.job, f.authorization);
  assert.equal(result.status, 'eligible');
  assert.equal(result.completion.turnId, 'turn-3');
});

test('metadata, owner, original prompt and instruction digest mismatches fail closed', async t => {
  const f = fixture(t);
  for (const mutate of [
    () => { f.job.codexThreadRequestId = 'RQ-OTHER'; },
    () => { f.records[0].payload.id = '00000000-0000-7000-8000-000000000000'; },
    () => { f.records[0].payload.cwd = f.sessionsRoot; },
    () => { f.records[0].payload.originator = 'unknown'; },
    () => { f.records[3] = user('Fake marker: ' + f.job.codexNativeDispatchMarker); },
  ]) {
    const originalJob = structuredClone(f.job), originalRecords = structuredClone(f.records);
    mutate(); f.write(); f.observer.forget(requestId);
    assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'blocked');
    Object.assign(f.job, originalJob); f.records.splice(0, f.records.length, ...originalRecords);
  }
  fs.writeFileSync(f.instructionPath, 'changed');
  assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'blocked');
  assert.equal(f.reviews(), 0);
});

test('a marker in a tool output or system instruction cannot establish user submission', async t => {
  const f = fixture(t);
  f.records[3].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['agents_md.instructions'];
  f.records[4].payload.output = f.prompt;
  f.write();
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'bound_prompt_not_verified');
  assert.equal(f.reviews(), 0);
});

test('cross-batch user prompt and wrong completion turn are blocked', async t => {
  const f = fixture(t);
  f.append([lifecycle('task_started', 'turn-2'), user('飞书背调批次：RQ-OTHER\n'), complete('turn-2')]);
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'foreign_batch_prompt');
  f.observer.forget(requestId);
  f.write([...f.records.slice(0, -1), complete('unbound-turn')]);
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'completion_turn_mismatch');
});

test('foreign file paths outside the session root are not read as evidence', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.jsonl');
  fs.copyFileSync(f.sessionPath, outside);
  f.job.codexNativeSessionPath = outside;
  assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'blocked');
  assert.equal(f.reviews(), 0);
});

test('bounded incremental scans never claim completion before reaching the live end', async t => {
  const f = fixture(t, { maxBytesPerPoll: 500 });
  const large = { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2000) } };
  f.write([...f.records.slice(0, -1), large, complete()]);
  let result;
  for (let i = 0; i < 30; i++) {
    f.job.lastObservationAt = `tick-${i}`;
    result = await f.observer.observe(f.job, f.authorization);
    if (result.status === 'eligible') break;
    assert.equal(result.status, 'waiting');
    assert.equal(f.reviews(), 0);
  }
  assert.equal(result.status, 'eligible');
  assert.equal(f.reviews(), 1);
});

test('partial records wait and complete after append; malformed or oversized records block', async t => {
  const f = fixture(t);
  f.write(f.records.slice(0, -1));
  const last = JSON.stringify(complete());
  fs.appendFileSync(f.sessionPath, last.slice(0, 20));
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'partial_session_record');
  fs.appendFileSync(f.sessionPath, last.slice(20) + '\n');
  assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'eligible');
  f.observer.forget(requestId); f.write(); fs.appendFileSync(f.sessionPath, '{bad json}\n');
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'session_record_invalid');
  f.write();
  const bounded = createCompletionObserver({ ...f.dependencies, maxRecordBytes: 100 });
  assert.equal((await bounded.observe(f.job, f.authorization)).reason, 'session_record_too_large');
});

test('truncated or rewritten consumed session prefix cannot reuse an old scan', async t => {
  const f = fixture(t);
  assert.equal((await f.observer.observe(f.job, f.authorization)).status, 'eligible');
  f.write(f.records.slice(0, -1));
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'session_rewritten');
});

test('missing, failing or non-PASS review remains pending and never claims delivery', async t => {
  const f = fixture(t);
  for (const verifyReports of [async () => { throw new Error('missing manifest'); }, async () => [],
    async () => [{ ...receipt, verdict: 'FAIL' }], async () => [{ ...receipt, revision_id: null }]]) {
    const observer = createCompletionObserver({ ...f.dependencies, verifyReports });
    assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  }
});

test('a new turn arriving during asynchronous report review cancels eligibility', async t => {
  const f = fixture(t);
  const observer = createCompletionObserver({ ...f.dependencies, verifyReports: async () => {
    f.append([lifecycle('task_started', 'turn-2')]); return [receipt];
  } });
  const result = await observer.observe(f.job, f.authorization);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'session_changed_during_review');
});

test('concurrent ticks for the same identity share one review attempt', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.observer.observe(f.job, f.authorization), f.observer.observe(f.job, f.authorization)]);
  assert.equal(a.status, 'eligible'); assert.deepEqual(a, b); assert.equal(f.reviews(), 1);
});

test('inspection is read-only candidate evidence, never completion eligibility', async t => {
  const f = fixture(t);
  const result = await inspectBoundSessionCompletion({ ...f.dependencies, job: f.job, authorization: f.authorization });
  assert.equal(result.status, 'candidate'); assert.equal(f.reviews(), 0);
  assert.equal((await observeCompletedHandoff({ ...f.dependencies, job: f.job, authorization: f.authorization })).status, 'eligible');
});

test('a completion preceding the recorded research handoff remains waiting', async t => {
  const f = fixture(t); f.job.handoffEvidence.outputRecordIndex = 6;
  assert.equal((await f.observer.observe(f.job, f.authorization)).reason, 'completion_precedes_research_handoff');
  assert.equal(f.reviews(), 0);
});

test('unchanged missing review evidence is cached across ticks and mutable health fields', async t => {
  const f = fixture(t);
  let attempts = 0;
  const observer = createCompletionObserver({ ...f.dependencies, verifyReports: async args => {
    attempts++;
    return verifyCompletedReports(args);
  } });
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  f.job.lastObservationAt = 'a later poll';
  for (let i = 0; i < 3; i++) {
    const result = await observer.observe(f.job, f.authorization);
    assert.equal(result.reason, 'report_review_not_ready');
    assert.equal(result.reviewCached, true);
  }
  assert.equal(attempts, 1);
});

test('manifest and snapshot creation or changes retry the real review pipeline, unchanged FAIL does not', async t => {
  const f = fixture(t);
  const manifestPath = reviewManifestPath(f.stateDir, requestId);
  const snapshotPath = path.join(f.workspace, 'snapshot.json');
  let attempts = 0, audits = 0, revisions = 0;
  const audit = { verdict: 'PASS', visual: { verdict: 'PASS' }, stats: { errors: 0, blocked: 0 },
    document: { token: receipt.token, revision_id: 2 },
    receipt: { ...receipt, script_version: 'fixture', reviewer_id: 'fixture',
      layout_fingerprint: 'fixture', generated_at: '2026-10-26T00:00:00Z' } };
  const observer = createCompletionObserver({ ...f.dependencies,
    readLatestRevision: async () => { revisions++; return 2; },
    verifyReports: async args => {
      attempts++;
      return verifyCompletedReports({ ...args, runAudit: async filename => {
        audits++;
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
      } });
    } });
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).reviewCached, true);
  assert.equal(attempts, 1);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ requestId, documents: [{ url: reportUrl, snapshotPath }] }));
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal(attempts, 2);
  assert.equal(audits, 0);
  fs.writeFileSync(snapshotPath, JSON.stringify({ verdict: 'FAIL' }));
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).reviewCached, true);
  assert.equal(attempts, 3); assert.equal(audits, 1); assert.equal(revisions, 0);
  fs.writeFileSync(snapshotPath, JSON.stringify(audit));
  assert.equal((await observer.observe(f.job, f.authorization)).status, 'eligible');
  assert.equal(attempts, 4); assert.equal(audits, 2); assert.equal(revisions, 1);
  // PASS is deliberately not cached: every eligibility decision requires a live revision check.
  assert.equal((await observer.observe(f.job, f.authorization)).status, 'eligible');
  assert.equal(audits, 3); assert.equal(revisions, 2);
});

test('stale revision and transient read failures wait for evidence change or explicit reset', async t => {
  const f = fixture(t);
  const manifestPath = reviewManifestPath(f.stateDir, requestId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{"documents":[]}');
  let attempts = 0;
  const observer = createCompletionObserver({ ...f.dependencies, verifyReports: async () => {
    attempts++;
    if (attempts === 1) throw new Error('report changed after FORMAT_REVIEW: PASS');
    if (attempts === 2) throw new Error('temporary transport failure');
    return [receipt];
  } });
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).reviewCached, true);
  fs.appendFileSync(manifestPath, '\n');
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).reviewCached, true);
  assert.equal(attempts, 2);
  observer.forget(requestId);
  assert.equal((await observer.observe(f.job, f.authorization)).status, 'eligible');
  assert.equal(attempts, 3);
});

test('a new latest session turn invalidates failed review without any evidence file changes', async t => {
  const f = fixture(t);
  let attempts = 0;
  const observer = createCompletionObserver({ ...f.dependencies, verifyReports: async () => {
    attempts++;
    if (attempts === 1) return [];
    return [receipt];
  } });
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).reviewCached, true);
  f.append([lifecycle('task_started', 'turn-2')]);
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'latest_turn_active');
  assert.equal(attempts, 1);
  f.append([complete('turn-2')]);
  const result = await observer.observe(f.job, f.authorization);
  assert.equal(result.status, 'eligible');
  assert.equal(result.completion.turnId, 'turn-2');
  assert.equal(attempts, 2);
});

test('evidence changed during a failing review is not mistaken for an already audited state', async t => {
  const f = fixture(t);
  let attempts = 0;
  const observer = createCompletionObserver({ ...f.dependencies, verifyReports: async () => {
    attempts++;
    if (attempts === 1) {
      const manifestPath = reviewManifestPath(f.stateDir, requestId);
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, '{"documents":[]}');
      throw new Error('evidence arrived while review was pending');
    }
    return [receipt];
  } });
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).status, 'eligible');
  assert.equal(attempts, 2);
});

test('changed validator configuration invalidates an unchanged failed review', async t => {
  const f = fixture(t);
  const originalAuditor = process.env.FEISHU_REVIEW_AUDITOR;
  t.after(() => {
    if (originalAuditor === undefined) delete process.env.FEISHU_REVIEW_AUDITOR;
    else process.env.FEISHU_REVIEW_AUDITOR = originalAuditor;
  });
  let attempts = 0;
  const observer = createCompletionObserver({ ...f.dependencies, verifyReports: async () => {
    attempts++;
    if (attempts === 1) throw new Error('validator unavailable');
    return [receipt];
  } });
  process.env.FEISHU_REVIEW_AUDITOR = path.join(f.workspace, 'unavailable-validator.py');
  assert.equal((await observer.observe(f.job, f.authorization)).reason, 'report_review_not_ready');
  assert.equal((await observer.observe(f.job, f.authorization)).reviewCached, true);
  fs.writeFileSync(process.env.FEISHU_REVIEW_AUDITOR, '# installed fixture validator');
  assert.equal((await observer.observe(f.job, f.authorization)).status, 'eligible');
  assert.equal(attempts, 2);
});
