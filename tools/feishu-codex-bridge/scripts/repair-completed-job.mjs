import fs from 'node:fs';
import path from 'node:path';

import { applyCompletionRepair, inspectCompletionRepair, jobSha256 } from '../src/completion-repair.mjs';
import { config } from '../src/config.mjs';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { BridgeStore } from '../src/store.mjs';

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

const store = new BridgeStore(config.stateDir);

if (process.argv.includes('--inspect')) {
  const requestId = requiredArgument('--request-id');
  const job = store.getJob(requestId);
  if (!job) throw new Error(`job not found: ${requestId}`);
  console.log(JSON.stringify({
    request_id: job.requestId,
    source_message_id: job.sourceMessageId,
    thread_id: job.codexThreadId,
    thread_owner_request_id: job.codexThreadRequestId || null,
    expected_status: job.status,
    expected_stage: job.stage,
    expected_job_sha256: jobSha256(job),
    outbox: store.getOutboxStats(),
  }, null, 2));
  process.exit(0);
}

const manifestPath = path.resolve(requiredArgument('--manifest'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const apply = process.argv.includes('--apply');

if (!apply) {
  const inspected = inspectCompletionRepair(store, manifest);
  console.log(JSON.stringify({
    mode: 'dry-run',
    requestId: inspected.job.requestId,
    currentState: `${inspected.job.status}/${inspected.job.stage}`,
    jobSha256: inspected.actualJobSha256,
    documents: inspected.manifest.documents.length,
    pendingReplies: inspected.outbox.pending,
    next: 'keep the bridge stopped and re-run this command with --apply',
  }, null, 2));
  process.exit(0);
}

const maintenanceLock = acquireInstanceLock(
  path.join(config.stateDir, 'bridge.instance.lock'),
  { legacyPidPath: path.join(config.stateDir, 'bridge.pid') },
);
try {
  const repaired = applyCompletionRepair(store, manifest);
  console.log(JSON.stringify({
    mode: 'applied',
    requestId: repaired.updated.requestId,
    status: repaired.updated.status,
    stage: repaired.updated.stage,
    completedAt: repaired.updated.completedAt,
    documents: repaired.updated.completionDocuments.length,
    groupReplyQueued: false,
  }, null, 2));
} finally {
  maintenanceLock.release();
}
