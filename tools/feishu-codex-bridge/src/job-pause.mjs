import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PAUSABLE_JOB_STATUSES = new Set(['queued', 'running', 'recovery_required']);

function normalized(value) {
  return String(value || '').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safePathPart(value) {
  return normalized(value).replace(/[^A-Za-z0-9_-]+/gu, '_').slice(-64);
}

function writeBackup(backupPath, contents) {
  const descriptor = fs.openSync(backupPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function pauseJobWithBackup(store, {
  requestId,
  reason,
  requestedBy = 'operator',
  backupRoot,
  now = new Date(),
} = {}) {
  const normalizedRequestId = normalized(requestId);
  if (!normalizedRequestId) throw new Error('pause requires requestId');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('pause timestamp must be a valid Date');
  }

  const before = store.getJob(normalizedRequestId);
  if (!before) throw new Error(`job not found: ${normalizedRequestId}`);
  if (before.status === 'paused') {
    return {
      mode: 'already-paused',
      before,
      updated: before,
      backupPath: null,
      jobsSha256Before: sha256(fs.readFileSync(store.jobsPath)),
      backupSha256: null,
      jobsSha256After: sha256(fs.readFileSync(store.jobsPath)),
    };
  }
  if (!PAUSABLE_JOB_STATUSES.has(before.status)) {
    throw new Error(
      `request ${normalizedRequestId} cannot be paused from status ${before.status || 'missing'}`,
    );
  }

  const resolvedBackupRoot = path.resolve(normalized(backupRoot));
  if (!backupRoot || resolvedBackupRoot === path.parse(resolvedBackupRoot).root) {
    throw new Error('backupRoot must name a non-root directory');
  }

  const jobsBefore = fs.readFileSync(store.jobsPath);
  const jobsSha256Before = sha256(jobsBefore);
  fs.mkdirSync(resolvedBackupRoot, { recursive: true });
  const timestamp = now.toISOString().replace(/[^0-9A-Za-z]+/gu, '');
  const backupDirectory = path.join(
    resolvedBackupRoot,
    `pause-${timestamp}-${safePathPart(normalizedRequestId)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(backupDirectory);
  const backupPath = path.join(backupDirectory, 'jobs.json');
  writeBackup(backupPath, jobsBefore);

  const backupContents = fs.readFileSync(backupPath);
  const backupSha256 = sha256(backupContents);
  if (backupSha256 !== jobsSha256Before || !backupContents.equals(jobsBefore)) {
    throw new Error(`jobs backup verification failed: ${backupPath}`);
  }

  // The maintenance instance lock prevents ordinary writers. This final check
  // also fails closed if a process that ignores the lock changed jobs.json.
  const jobsImmediatelyBeforeMutation = fs.readFileSync(store.jobsPath);
  if (!jobsImmediatelyBeforeMutation.equals(jobsBefore)) {
    throw new Error('jobs.json changed after backup; refusing to pause the job');
  }

  const updated = store.pauseJob(normalizedRequestId, {
    reason,
    requestedBy,
    now,
  });
  if (updated.status !== 'paused' || updated.stage !== 'paused') {
    throw new Error(`pause did not persist for request ${normalizedRequestId}`);
  }

  return {
    mode: 'paused',
    before,
    updated,
    backupPath,
    jobsSha256Before,
    backupSha256,
    jobsSha256After: sha256(fs.readFileSync(store.jobsPath)),
  };
}
