import path from 'node:path';
import fs from 'node:fs';

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync.native(resolved); }
  catch (error) {
    // Saved synthetic/legacy identities may not exist on this host. Live
    // handoff evidence is independently checked against an existing session.
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    return resolved;
  }
}

function samePath(a, b) {
  const left = canonicalPath(a).replaceAll('/', '\\').toLowerCase();
  const right = canonicalPath(b).replaceAll('/', '\\').toLowerCase();
  return left === right;
}

function validEvidence(evidence) {
  return evidence?.sessionPath &&
    ['web', 'edge_page'].includes(evidence.researchTool) &&
    /^call_[a-zA-Z0-9_-]+$/u.test(String(evidence.callId || '')) &&
    Number.isSafeInteger(evidence.callRecordIndex) &&
    Number.isSafeInteger(evidence.outputRecordIndex) &&
    evidence.outputRecordIndex > evidence.callRecordIndex &&
    evidence?.runtime?.approvalPolicy && evidence?.runtime?.sandboxType;
}

export function commitResearchHandoff(store, requestId, evidence) {
  const bound = store.getJob(requestId);
  if (!bound || bound.status !== 'running' || bound.stage !== 'handoff_verifying' ||
      bound.codexThreadCreationMode !== 'desktop_native_handoff_v1' ||
      bound.codexThreadId !== evidence?.threadId ||
      bound.codexThreadRequestId !== requestId ||
      !bound.codexNativeSessionPath || !evidence?.sessionPath ||
      !samePath(bound.codexNativeSessionPath, evidence?.sessionPath) ||
      !validEvidence(evidence)) {
    throw new Error('research handoff identity, evidence, or stage changed');
  }
  return store.updateJob(requestId, {
    status: 'handed_off',
    stage: 'research_started',
    handoffAt: new Date().toISOString(),
    handoffEvidence: {
      threadId: evidence.threadId,
      researchTool: evidence.researchTool,
      callId: evidence.callId,
      callRecordIndex: evidence.callRecordIndex,
      outputRecordIndex: evidence.outputRecordIndex,
      runtime: evidence.runtime,
      observedAt: evidence.observedAt,
    },
  });
}

// Commit a verified Desktop turn after UI invocation succeeded but the bridge
// stopped before writing its binding. This is one atomic job-store write: a
// recovery must never create a second thread or silently reuse another batch.
export function commitRecoveredResearchHandoff(store, requestId, binding, evidence) {
  const jobs = store.listJobs();
  const matches = jobs.filter((item) => item.requestId === requestId);
  const job = matches.length === 1 ? matches[0] : null;
  if (!job || job.status !== 'recovery_required' ||
      job.stage !== 'thread_recovery_required' ||
      job.recoveryFromStage !== 'thread_bootstrapping' ||
      job.codexThreadCreationMode !== 'desktop_native_handoff_v1' ||
      job.codexThreadRequestId !== requestId || job.codexThreadId ||
      !binding?.threadId || binding.threadId !== evidence?.threadId ||
      binding.marker !== job.codexNativeDispatchMarker ||
      !samePath(binding.instructionPath, job.codexNativeInstructionPath) ||
      binding.instructionSha256 !== job.codexNativeInstructionSha256 ||
      binding.source !== 'vscode' || binding.threadSource !== 'user' ||
      !['codex_work_desktop', 'Codex Desktop'].includes(binding.originator) ||
      !samePath(binding.sessionPath, evidence?.sessionPath) ||
      !validEvidence(evidence) ||
      jobs.some((item) => item.requestId !== requestId &&
        item.codexThreadId === binding.threadId)) {
    throw new Error('recovered research handoff identity, evidence, or stage changed');
  }
  Object.assign(job, {
    codexThreadId: binding.threadId,
    codexThreadSource: binding.source,
    codexThreadOriginator: binding.originator,
    codexThreadSourceKind: binding.threadSource,
    codexNativeSessionPath: binding.sessionPath,
    codexThreadBoundAt: new Date().toISOString(),
    codexThreadBootstrappedAt: new Date().toISOString(),
    status: 'handed_off',
    stage: 'research_started',
    handoffAt: new Date().toISOString(),
    recoveryResolution: 'verified original Desktop prompt and source-bearing research output',
    handoffEvidence: {
      threadId: evidence.threadId,
      researchTool: evidence.researchTool,
      callId: evidence.callId,
      callRecordIndex: evidence.callRecordIndex,
      outputRecordIndex: evidence.outputRecordIndex,
      runtime: evidence.runtime,
      observedAt: evidence.observedAt,
    },
  });
  store.saveJobs(jobs);
  return job;
}
