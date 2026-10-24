import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BridgeStore } from '../src/store.mjs';

test('interrupted CLI execution remains isolated even with a durable thread binding', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-recovery-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.addJob({
      requestId: 'RQ-CLI-CRASH', status: 'running', stage: 'executing',
      codexThreadCreationMode: 'cli_visible_v1',
      codexThreadId: '00000000-6890-7000-8000-ca07e33e97e0',
      codexThreadRequestId: 'RQ-CLI-CRASH',
      codexCliAttemptStartedAt: '2026-10-03T00:00:00.000Z',
    });
    const recovered = new BridgeStore(stateDir).recoverInterruptedJobs()[0];
    assert.equal(recovered.status, 'recovery_required');
    assert.match(recovered.recoveryReason, /inspect the bound session/u);
    assert.throws(() => store.prepareExecutionJob('RQ-CLI-CRASH'), /prior CLI execution attempt/u);
    store.updateJob('RQ-CLI-CRASH', { status: 'queued', stage: 'scope_resolved' });
    assert.throws(() => store.prepareExecutionJob('RQ-CLI-CRASH'), /prior CLI execution attempt/u);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a failed handler can release its persistent message claim for retry', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    assert.equal(store.markMessageSeen('om_retry'), true);
    assert.equal(store.markMessageSeen('om_retry'), false);
    assert.equal(store.forgetMessage('om_retry'), true);
    assert.equal(store.markMessageSeen('om_retry'), true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('queues a source message idempotently even if its seen claim must be repaired', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    const job = { requestId: 'RQ-1', sourceMessageId: 'om_1', status: 'queued' };
    assert.equal(store.addJobForMessage('om_1', job).added, true);
    assert.equal(store.addJobForMessage('om_1', { ...job, requestId: 'RQ-2' }).added, false);
    assert.equal(store.listJobs().length, 1);

    fs.writeFileSync(store.seenPath, JSON.stringify({ ids: [] }), 'utf8');
    assert.equal(store.addJobForMessage('om_1', { ...job, requestId: 'RQ-3' }).added, false);
    assert.equal(store.isMessageSeen('om_1'), true);
    assert.equal(store.listJobs().length, 1);

    store.markMessageSeen('om_lost_before_job');
    const recovered = store.addJobForMessage('om_lost_before_job', {
      requestId: 'RQ-4',
      sourceMessageId: 'om_lost_before_job',
      status: 'queued',
    });
    assert.equal(recovered.added, true);
    assert.equal(store.listJobs().length, 2);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('isolates every new request from caller-supplied or previous Codex threads', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    const first = store.addJobForMessage('om_1', {
      requestId: 'RQ-1',
      sourceMessageId: 'om_1',
      status: 'queued',
      codexThreadId: 'thread-from-an-older-request',
      codexThreadRequestId: 'RQ-OLDER',
    }).job;
    assert.equal(first.codexThreadId, null);
    assert.equal(first.codexThreadRequestId, 'RQ-1');

    store.bindExecutionThread('RQ-1', 'thread-1', { title: 'batch one' });
    const prepared = store.prepareExecutionJob('RQ-1');
    assert.equal(prepared.codexThreadId, 'thread-1');
    assert.equal(prepared.codexThreadRequestId, 'RQ-1');
    assert.equal(prepared.codexThreadTitle, 'batch one');

    const second = store.addJobForMessage('om_2', {
      requestId: 'RQ-2',
      sourceMessageId: 'om_2',
      status: 'queued',
      codexThreadId: 'thread-1',
    }).job;
    assert.equal(second.codexThreadId, null);
    assert.equal(second.codexThreadRequestId, 'RQ-2');
    assert.throws(
      () => store.bindExecutionThread('RQ-2', 'thread-1'),
      /already bound to request RQ-1/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fails closed for an ownerless legacy thread until an explicit verified migration', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.saveJobs([{ requestId: 'RQ-LEGACY', codexThreadId: 'thread-legacy', status: 'queued' }]);
    assert.throws(
      () => store.prepareExecutionJob('RQ-LEGACY'),
      /has no verified ownership/,
    );
    assert.equal(store.getJob('RQ-LEGACY').codexThreadRequestId, undefined);
    assert.throws(
      () => store.migrateLegacyExecutionThread('RQ-LEGACY', 'thread-wrong', { evidence: 'checked' }),
      /thread mismatch/,
    );
    assert.throws(
      () => store.migrateLegacyExecutionThread('RQ-LEGACY', 'thread-legacy'),
      /requires verification evidence/,
    );

    const migrated = store.migrateLegacyExecutionThread('RQ-LEGACY', 'thread-legacy', {
      evidence: 'verified against the persisted Codex session title and request marker',
    });
    assert.equal(migrated.codexThreadRequestId, 'RQ-LEGACY');
    assert.equal(store.prepareExecutionJob('RQ-LEGACY').codexThreadId, 'thread-legacy');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('rejects duplicate request ids and duplicate thread bindings at the store boundary', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.addJobForMessage('om_1', {
      requestId: 'RQ-UNIQUE', sourceMessageId: 'om_1', status: 'queued',
    });
    assert.throws(
      () => store.addJobForMessage('om_2', {
        requestId: 'RQ-UNIQUE', sourceMessageId: 'om_2', status: 'queued',
      }),
      /duplicate request id/,
    );
    assert.equal(store.listJobs().length, 1);

    assert.throws(
      () => store.saveJobs([
        { requestId: 'RQ-1', codexThreadId: 'thread-shared' },
        { requestId: 'RQ-2', codexThreadId: 'thread-shared' },
      ]),
      /bound to multiple requests/,
    );

    fs.writeFileSync(store.jobsPath, JSON.stringify([
      { requestId: 'RQ-CORRUPT', status: 'completed' },
      { requestId: 'RQ-CORRUPT', status: 'queued' },
    ]), 'utf8');
    assert.throws(
      () => store.recoverInterruptedJobs(),
      /duplicate request id/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fault-injected restart stops an executing job whose thread binding was not persisted', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.saveJobs([
      {
        requestId: 'RQ-BEFORE-BIND', status: 'running', stage: 'executing',
        codexThreadId: null, codexThreadRequestId: 'RQ-BEFORE-BIND',
      },
      {
        requestId: 'RQ-AFTER-BIND', status: 'running', stage: 'executing',
        codexThreadId: 'thread-after-bind', codexThreadRequestId: 'RQ-AFTER-BIND',
      },
      {
        requestId: 'RQ-PREFLIGHT', status: 'running', stage: 'scope_preflight',
        codexThreadId: null,
      },
      {
        requestId: 'RQ-OWNERLESS', status: 'running', stage: 'executing',
        codexThreadId: 'thread-ownerless',
      },
      {
        requestId: 'RQ-OLD-QUEUED-BEFORE-BIND', status: 'queued', stage: 'executing',
        codexThreadId: null, codexThreadRequestId: 'RQ-OLD-QUEUED-BEFORE-BIND',
      },
      {
        requestId: 'RQ-BOOTSTRAP-CRASH', status: 'running', stage: 'thread_bootstrapping',
        codexThreadId: null, codexThreadRequestId: 'RQ-BOOTSTRAP-CRASH',
      },
      {
        requestId: 'RQ-BOOTSTRAP-BOUND', status: 'running', stage: 'thread_bootstrapping',
        codexThreadId: 'thread-bootstrap-bound', codexThreadRequestId: 'RQ-BOOTSTRAP-BOUND',
      },
    ]);

    const recovered = new BridgeStore(stateDir).recoverInterruptedJobs();
    const byId = Object.fromEntries(recovered.map((job) => [job.requestId, job]));
    assert.equal(byId['RQ-BEFORE-BIND'].status, 'recovery_required');
    assert.equal(byId['RQ-BEFORE-BIND'].stage, 'thread_recovery_required');
    assert.match(byId['RQ-BEFORE-BIND'].recoveryReason, /before a Codex thread binding/);
    assert.equal(byId['RQ-AFTER-BIND'].status, 'queued');
    assert.equal(byId['RQ-PREFLIGHT'].status, 'queued');
    assert.equal(byId['RQ-OWNERLESS'].status, 'recovery_required');
    assert.match(byId['RQ-OWNERLESS'].recoveryReason, /unverified/);
    assert.equal(byId['RQ-OLD-QUEUED-BEFORE-BIND'].status, 'recovery_required');
    assert.equal(byId['RQ-BOOTSTRAP-CRASH'].status, 'recovery_required');
    assert.match(byId['RQ-BOOTSTRAP-CRASH'].recoveryReason, /before a Codex thread binding/);
    assert.equal(byId['RQ-BOOTSTRAP-BOUND'].status, 'queued');
    assert.equal(byId['RQ-BOOTSTRAP-BOUND'].codexThreadId, 'thread-bootstrap-bound');

    assert.equal(
      store.prepareExecutionJob('RQ-AFTER-BIND').codexThreadId,
      'thread-after-bind',
    );
    assert.throws(
      () => store.prepareExecutionJob('RQ-OWNERLESS'),
      /requires local recovery review/,
    );
    const reviewed = store.migrateLegacyExecutionThread('RQ-OWNERLESS', 'thread-ownerless', {
      evidence: 'fault-injection test verified the persisted session belongs to this request',
    });
    assert.equal(reviewed.status, 'queued');
    assert.equal(reviewed.stage, 'executing');
    assert.equal(reviewed.codexThreadRequestId, 'RQ-OWNERLESS');
    assert.match(reviewed.recoveryResolution, /same-request resume/);
    assert.equal(
      store.prepareExecutionJob('RQ-OWNERLESS').codexThreadId,
      'thread-ownerless',
    );
    assert.throws(
      () => store.prepareExecutionJob('RQ-OLD-QUEUED-BEFORE-BIND'),
      /requires local recovery review/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a live bootstrap failure is durably isolated for local recovery', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.addJobForMessage('om_bootstrap', {
      requestId: 'RQ-BOOTSTRAP', sourceMessageId: 'om_bootstrap', status: 'queued',
    });
    store.updateJob('RQ-BOOTSTRAP', { status: 'running', stage: 'thread_bootstrapping' });
    const isolated = store.markThreadRecoveryRequired('RQ-BOOTSTRAP', {
      reason: 'ConPTY exited before the marker was verified',
    });
    assert.equal(isolated.status, 'recovery_required');
    assert.equal(isolated.stage, 'thread_recovery_required');
    assert.equal(isolated.recoveryFromStage, 'thread_bootstrapping');
    assert.match(isolated.recoveryReason, /ConPTY exited/);
    assert.throws(
      () => store.prepareExecutionJob('RQ-BOOTSTRAP'),
      /requires local recovery review/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an explicit pause records its origin and blocks execution until a future explicit resume', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.saveJobs([
      {
        requestId: 'RQ-PAUSE',
        status: 'running',
        stage: 'executing',
        codexThreadId: 'thread-pause',
        codexThreadRequestId: 'RQ-PAUSE',
      },
      { requestId: 'RQ-DONE', status: 'completed', stage: 'completed' },
    ]);

    const paused = store.pauseJob('RQ-PAUSE', {
      reason: 'user asked to pause this request',
      requestedBy: 'user',
      now: new Date('2026-09-30T13:00:00.000Z'),
    });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.stage, 'paused');
    assert.equal(paused.pausedFromStatus, 'running');
    assert.equal(paused.pausedFromStage, 'executing');
    assert.equal(paused.pausedAt, '2026-09-30T13:00:00.000Z');
    assert.equal(paused.pauseReason, 'user asked to pause this request');
    assert.equal(paused.pauseRequestedBy, 'user');
    assert.equal(paused.codexThreadId, 'thread-pause');
    assert.equal(paused.codexThreadRequestId, 'RQ-PAUSE');
    assert.throws(
      () => store.prepareExecutionJob('RQ-PAUSE'),
      /is paused and cannot execute until explicitly resumed/,
    );

    const idempotent = store.pauseJob('RQ-PAUSE', {
      reason: 'must not replace original pause metadata',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    assert.equal(idempotent.pausedAt, '2026-09-30T13:00:00.000Z');
    assert.equal(idempotent.pauseReason, 'user asked to pause this request');
    assert.throws(
      () => store.pauseJob('RQ-DONE'),
      /cannot be paused from status completed/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('restart recovery preserves paused jobs byte-for-byte and does not requeue them', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    const pausedJob = {
      requestId: 'RQ-PAUSED-RESTART',
      status: 'paused',
      stage: 'paused',
      pausedFromStatus: 'running',
      pausedFromStage: 'executing',
      pausedAt: '2026-09-30T13:00:00.000Z',
      pauseReason: 'user pause survives restart',
      codexThreadId: 'thread-paused-restart',
      codexThreadRequestId: 'RQ-PAUSED-RESTART',
    };
    store.saveJobs([
      pausedJob,
      {
        requestId: 'RQ-INTERRUPTED',
        status: 'running',
        stage: 'scope_preflight',
        codexThreadId: null,
        codexThreadRequestId: 'RQ-INTERRUPTED',
      },
    ]);

    const recovered = new BridgeStore(stateDir).recoverInterruptedJobs();
    const byId = Object.fromEntries(recovered.map((job) => [job.requestId, job]));
    assert.deepEqual(byId['RQ-PAUSED-RESTART'], pausedJob);
    assert.equal(byId['RQ-INTERRUPTED'].status, 'queued');
    assert.equal(byId['RQ-PAUSED-RESTART'].recoveredAt, undefined);
    assert.throws(
      () => store.prepareExecutionJob('RQ-PAUSED-RESTART'),
      /is paused and cannot execute/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('persists poll watermarks and retries a durable reply outbox', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-store-'));
  try {
    const store = new BridgeStore(stateDir);
    store.setPollWatermark('oc_chat', 1720000000);
    assert.equal(new BridgeStore(stateDir).getPollWatermark('oc_chat'), 1720000000);

    store.enqueueReply({ id: 'reply-1', chatId: 'oc_chat', replyTo: 'om_1', text: 'ok' });
    assert.equal(store.listPendingReplies().length, 1);
    store.recordReplyAttempt('reply-1', { delivered: false, error: 'temporary' });
    assert.equal(store.getOutboxStats().pending, 1);
    store.recordReplyAttempt('reply-1', { delivered: true });
    assert.deepEqual(store.getOutboxStats(), { pending: 0, delivered: 1 });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
