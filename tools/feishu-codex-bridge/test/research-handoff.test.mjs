import assert from 'node:assert/strict';
import test from 'node:test';

import { commitRecoveredResearchHandoff } from '../src/research-handoff.mjs';

const requestId = 'RQ-20261004-IGDA';
const threadId = '00000000-934e-7000-8000-a871fd3740a6';
const sessionPath = 'C:\\Users\\Excal\\.codex\\sessions\\native.jsonl';
const instructionPath = 'O:\\背调\\native\\IGDA.md';
const marker = `FEISHU-NATIVE-${requestId}-nonce`;
const digest = 'a'.repeat(64);

function setup() {
  let jobs = [{
    requestId, status: 'recovery_required', stage: 'thread_recovery_required',
    recoveryFromStage: 'thread_bootstrapping',
    codexThreadCreationMode: 'desktop_native_handoff_v1',
    codexThreadRequestId: requestId, codexThreadId: null,
    codexNativeDispatchMarker: marker,
    codexNativeInstructionPath: instructionPath,
    codexNativeInstructionSha256: digest,
  }];
  let saves = 0;
  const store = {
    listJobs: () => structuredClone(jobs),
    saveJobs: (next) => { jobs = structuredClone(next); saves += 1; },
    current: () => jobs,
    saves: () => saves,
  };
  const binding = {
    threadId, marker, instructionPath, instructionSha256: digest,
    source: 'vscode', originator: 'Codex Desktop', threadSource: 'user', sessionPath,
  };
  const evidence = {
    threadId, sessionPath, researchTool: 'web', callId: 'call_verified',
    callRecordIndex: 12, outputRecordIndex: 15,
    runtime: { approvalPolicy: 'never', sandboxType: 'danger-full-access' },
    observedAt: '2026-10-04T14:07:55Z',
  };
  return { store, binding, evidence };
}

test('verified recovered handoff binds one request and records research in one write', () => {
  const { store, binding, evidence } = setup();
  const job = commitRecoveredResearchHandoff(store, requestId, binding, evidence);
  assert.equal(store.saves(), 1);
  assert.equal(job.codexThreadId, threadId);
  assert.equal(job.status, 'handed_off');
  assert.equal(job.stage, 'research_started');
  assert.equal(job.handoffEvidence.callId, 'call_verified');
  assert.throws(() => commitRecoveredResearchHandoff(store, requestId, binding, evidence),
    /identity, evidence, or stage changed/u);
  assert.equal(store.saves(), 1);
});

test('recovery refuses a changed marker, missing source output, or a foreign thread owner', () => {
  for (const kind of ['marker', 'output', 'owner']) {
    const { store, binding, evidence } = setup();
    if (kind === 'marker') binding.marker = 'other-marker';
    if (kind === 'output') evidence.outputRecordIndex = evidence.callRecordIndex;
    if (kind === 'owner') store.current().push({
      requestId: 'RQ-OTHER', codexThreadId: threadId,
    });
    assert.throws(() => commitRecoveredResearchHandoff(store, requestId, binding, evidence),
      /identity, evidence, or stage changed/u);
    assert.equal(store.saves(), 0);
  }
});
