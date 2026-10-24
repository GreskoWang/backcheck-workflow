import fs from 'node:fs';
import path from 'node:path';

import {
  buildDesktopNativePrompt,
  findDesktopNativeSession,
  inspectDesktopResearchStart,
} from '../src/desktop-native-dispatch.mjs';
import { commitRecoveredResearchHandoff } from '../src/research-handoff.mjs';
import { BridgeStore } from '../src/store.mjs';

const [stateDir, requestId, workspace, sessionsRootArg] = process.argv.slice(2);
if (!stateDir || !requestId || !workspace || !sessionsRootArg) {
  throw new Error('usage: recover-native-handoff-once.mjs STATE_DIR REQUEST_ID WORKSPACE SESSIONS_ROOT');
}
const store = new BridgeStore(path.resolve(stateDir));
const job = store.getJob(requestId);
if (!job || job.requestId !== requestId ||
    job.status !== 'recovery_required' || job.stage !== 'thread_recovery_required' ||
    job.recoveryFromStage !== 'thread_bootstrapping' || job.codexThreadId ||
    job.codexThreadCreationMode !== 'desktop_native_handoff_v1') {
  throw new Error('request is not an unbound native Desktop handoff recovery');
}
const instructionHash = (await import('node:crypto')).createHash('sha256')
  .update(fs.readFileSync(job.codexNativeInstructionPath)).digest('hex');
if (instructionHash !== job.codexNativeInstructionSha256) {
  throw new Error('persisted native instruction hash changed');
}
const prompt = buildDesktopNativePrompt({
  requestId, threadTitle: job.codexThreadTitle,
  marker: job.codexNativeDispatchMarker,
  instructionPath: job.codexNativeInstructionPath,
  instructionSha256: job.codexNativeInstructionSha256,
});
const sessionsRoot = path.resolve(sessionsRootArg);
const session = findDesktopNativeSession({
  sessionsRoot, marker: job.codexNativeDispatchMarker, expectedPrompt: prompt,
  workspace,
  notBeforeMs: Date.parse(job.codexThreadBootstrapStartedAt),
});
if (!session) throw new Error('no unique matching native Desktop session');
const threadId = String(session.meta.id || session.meta.session_id);
const evidence = inspectDesktopResearchStart({
  sessionPath: session.filePath,
  sessionsRoot,
  marker: job.codexNativeDispatchMarker,
  expectedPrompt: prompt,
  workspace,
  expectedThreadId: threadId,
  instructionPath: job.codexNativeInstructionPath,
  instructionSha256: job.codexNativeInstructionSha256,
  researchTerms: (job.dispatchScope?.assignments || [])
    .flatMap((item) => [item.subject, ...(item.anchors || [])]),
});
if (!evidence) throw new Error('matching Desktop thread has not produced research source output');
const committed = commitRecoveredResearchHandoff(store, requestId, {
  threadId,
  marker: job.codexNativeDispatchMarker,
  instructionPath: job.codexNativeInstructionPath,
  instructionSha256: job.codexNativeInstructionSha256,
  source: session.meta.source,
  originator: session.meta.originator,
  threadSource: session.meta.thread_source,
  sessionPath: session.filePath,
}, evidence);
console.log(JSON.stringify({
  requestId: committed.requestId,
  status: committed.status,
  stage: committed.stage,
  threadId: committed.codexThreadId,
  researchTool: evidence.researchTool,
  callRecordIndex: evidence.callRecordIndex,
  outputRecordIndex: evidence.outputRecordIndex,
}));
