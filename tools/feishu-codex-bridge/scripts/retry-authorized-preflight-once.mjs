import fs from 'node:fs';
import path from 'node:path';
import { bridgeRoot, config } from '../src/config.mjs';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { BridgeStore } from '../src/store.mjs';
import { retryFailedPreflight } from '../src/preflight-retry.mjs';
const outDir = path.join(bridgeRoot, 'state-backups', 'shared-assignment-retry-20261012');
const audit = JSON.parse(fs.readFileSync(path.join(outDir, 'before-audit.json'), 'utf8'));
const validated = JSON.parse(fs.readFileSync(path.join(outDir, 'validated-scope.json'), 'utf8'));
if (audit.requestId !== 'RQ-SYNTHETIC-8B25B313' ||
    audit.sourceMessageId !== 'om_x100b63f886ccacb4b1bc6933ce00519' ||
    audit.sourceHash !== 'b1342d39826844e01b9f70501f3a24d5d1d025eff22ce6f07442aadfa35a9acc' ||
    !audit.sourceTextConfirmed || audit.receipts.length || audit.entries.length ||
    validated.sourceHash !== audit.sourceHash || validated.requestId !== audit.requestId ||
    validated.sourceMessageId !== audit.sourceMessageId) {
  throw new Error('authorized source or validated scope audit changed');
}
const lock = acquireInstanceLock(path.join(config.stateDir, 'bridge.instance.lock'), {
  legacyPidPath: path.join(config.stateDir, 'bridge.pid'), entryPath: path.join(bridgeRoot, 'src', 'bridge.mjs'),
});
try {
  const store = new BridgeStore(config.stateDir);
  fs.copyFileSync(store.jobsPath, path.join(outDir, 'jobs-immediately-before-retry.json'), fs.constants.COPYFILE_EXCL);
  const job = retryFailedPreflight(store, { requestId: audit.requestId, sourceMessageId: audit.sourceMessageId,
    sourceHash: audit.sourceHash, validatedScope: validated.scope, model: validated.model,
    authorization: '用户2026-10-12 12:16:55UTC授权重试本单；12:18:44UTC明确同对象两码各收费一份' });
  process.stdout.write(JSON.stringify({ requestId: job.requestId, sourceMessageId: job.sourceMessageId,
    status: job.status, stage: job.stage, accountingPolicy: job.accountingPolicy,
    watchedCount: job.intakeDispatchScope.assignments.length, threadId: job.codexThreadId }) + '\n');
} finally { lock.release(); }
