import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDispatchScopeResult } from './dispatch-scope.mjs';

// Caller must own the bridge's maintenance lock. This operation never creates
// a request or a thread and never changes another request's lifecycle.
export function retryFailedPreflight(store, {
  requestId, sourceMessageId, sourceHash, authorization, validatedScope, model,
  now = () => new Date(),
}) {
  const jobs = store.listJobs();
  const job = store.getJob(requestId);
  if (!authorization || !sourceHash || !job || job.sourceMessageId !== sourceMessageId ||
      job.status !== 'failed' || job.stage !== 'preflight_blocked' ||
      job.codexThreadRequestId !== requestId || job.preflightRetryClaimedAt ||
      jobs.some(item => ['queued', 'running'].includes(item.status))) {
    throw new Error('authorized preflight retry identity or lifecycle changed');
  }
  const possibleEffects = ['codexThreadId', 'codexThreadCreationMode', 'codexCliAttemptStartedAt',
    'handoffEvidence', 'dispatchScope', 'intakeDispatchScope', 'acceptanceSendAttemptAt',
    'acceptanceQueuedAt', 'acceptanceSuppressedAt', 'accountingStatus'];
  if (possibleEffects.some(field => Boolean(job[field])) ||
      fs.existsSync(path.join(store.stateDir, 'native-jobs', `${requestId}.md`))) {
    throw new Error('prior side effects require review before preflight retry');
  }
  if (crypto.createHash('sha256').update(job.requestText).digest('hex') !== sourceHash) {
    throw new Error('authorized source text changed');
  }
  const ledgerPath = path.join(store.stateDir, 'accounting-ledger.json');
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { entries: {} };
  const outbox = fs.existsSync(store.outboxPath) ? JSON.parse(fs.readFileSync(store.outboxPath, 'utf8')) : [];
  if (Object.values(ledger.entries).some(entry => entry.requestId === requestId || entry.sourceMessageId === sourceMessageId) ||
      outbox.some(item => item.replyTo === sourceMessageId)) {
    throw new Error('prior accounting or group reply requires review before retry');
  }
  const scope = parseDispatchScopeResult(validatedScope, { requestText: job.requestText });
  if (scope.decision !== 'execute') throw new Error('preflight retry has no validated watched assignment');
  return store.updateJob(requestId, {
    status: 'queued', stage: 'queued', accountingPolicy: 'per_code_v2',
    intakeDispatchScope: scope, dispatchScope: scope, preflightModelUsed: model,
    preflightRetryClaimedAt: now().toISOString(), preflightRetryAuthorization: authorization,
    preflightRetrySourceHash: sourceHash, priorPreflightFailure: job.errorSummary,
  });
}
