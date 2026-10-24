import path from 'node:path';

import { bridgeRoot, config } from '../src/config.mjs';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { pauseJobWithBackup } from '../src/job-pause.mjs';
import { BridgeStore } from '../src/store.mjs';

function argument(name, { required = false, fallback } = {}) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value && !value.startsWith('--')) return value;
  if (required) throw new Error(`missing ${name}`);
  return fallback;
}

const requestId = argument('--request-id', { required: true });
const reason = argument('--reason', { required: true });
const requestedBy = argument('--requested-by', { fallback: 'operator' });
const store = new BridgeStore(config.stateDir);

// Owning the same lock as the bridge both proves that no bridge process is
// alive and prevents one from starting while jobs.json is backed up and edited.
const maintenanceLock = acquireInstanceLock(
  path.join(config.stateDir, 'bridge.instance.lock'),
  { legacyPidPath: path.join(config.stateDir, 'bridge.pid') },
);
try {
  const result = pauseJobWithBackup(store, {
    requestId,
    reason,
    requestedBy,
    backupRoot: path.join(bridgeRoot, 'state-backups'),
  });
  process.stdout.write(`${JSON.stringify({
    mode: result.mode,
    requestId: result.updated.requestId,
    previousStatus: result.before.status,
    previousStage: result.before.stage,
    status: result.updated.status,
    stage: result.updated.stage,
    pausedAt: result.updated.pausedAt,
    pauseReason: result.updated.pauseReason,
    pauseRequestedBy: result.updated.pauseRequestedBy,
    codexThreadId: result.updated.codexThreadId || null,
    codexThreadRequestId: result.updated.codexThreadRequestId || null,
    backupPath: result.backupPath,
    jobsSha256Before: result.jobsSha256Before,
    backupSha256: result.backupSha256,
    jobsSha256After: result.jobsSha256After,
  }, null, 2)}\n`);
} finally {
  maintenanceLock.release();
}
