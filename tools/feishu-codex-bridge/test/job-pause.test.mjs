import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pauseJobWithBackup } from '../src/job-pause.mjs';
import { BridgeStore } from '../src/store.mjs';

test('pause maintenance makes a verified exact backup before changing jobs.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-pause-'));
  try {
    const stateDir = path.join(root, 'state');
    const backupRoot = path.join(root, 'backups');
    const store = new BridgeStore(stateDir);
    store.saveJobs([
      {
        requestId: 'RQ-BACKUP-PAUSE',
        sourceMessageId: 'om_pause',
        status: 'running',
        stage: 'executing',
        codexThreadId: 'thread-backup-pause',
        codexThreadRequestId: 'RQ-BACKUP-PAUSE',
      },
      { requestId: 'RQ-UNCHANGED', status: 'completed', stage: 'completed' },
    ]);
    const originalJobs = fs.readFileSync(store.jobsPath);

    const result = pauseJobWithBackup(store, {
      requestId: 'RQ-BACKUP-PAUSE',
      reason: 'explicit user pause',
      requestedBy: 'user',
      backupRoot,
      now: new Date('2026-09-30T13:15:00.000Z'),
    });

    assert.equal(result.mode, 'paused');
    assert.ok(result.backupPath.startsWith(path.resolve(backupRoot)));
    assert.deepEqual(fs.readFileSync(result.backupPath), originalJobs);
    assert.equal(result.backupSha256, result.jobsSha256Before);
    assert.notEqual(result.jobsSha256After, result.jobsSha256Before);
    assert.equal(store.getJob('RQ-BACKUP-PAUSE').status, 'paused');
    assert.equal(store.getJob('RQ-BACKUP-PAUSE').pausedFromStage, 'executing');
    assert.equal(store.getJob('RQ-BACKUP-PAUSE').codexThreadId, 'thread-backup-pause');
    assert.deepEqual(
      store.getJob('RQ-UNCHANGED'),
      { requestId: 'RQ-UNCHANGED', status: 'completed', stage: 'completed' },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pause maintenance leaves the job untouched when its backup cannot be created', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-pause-'));
  try {
    const stateDir = path.join(root, 'state');
    const blockedBackupRoot = path.join(root, 'backup-root-is-a-file');
    const store = new BridgeStore(stateDir);
    store.saveJobs([{
      requestId: 'RQ-BACKUP-FAIL',
      status: 'running',
      stage: 'executing',
      codexThreadId: 'thread-backup-fail',
      codexThreadRequestId: 'RQ-BACKUP-FAIL',
    }]);
    const originalJobs = fs.readFileSync(store.jobsPath);
    fs.writeFileSync(blockedBackupRoot, 'not a directory', 'utf8');

    assert.throws(
      () => pauseJobWithBackup(store, {
        requestId: 'RQ-BACKUP-FAIL',
        reason: 'must not mutate without a backup',
        backupRoot: blockedBackupRoot,
      }),
    );
    assert.deepEqual(fs.readFileSync(store.jobsPath), originalJobs);
    assert.equal(store.getJob('RQ-BACKUP-FAIL').status, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
