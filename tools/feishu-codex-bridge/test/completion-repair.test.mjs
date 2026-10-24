import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyCompletionRepair,
  inspectCompletionRepair,
  jobSha256,
} from '../src/completion-repair.mjs';
import { BridgeStore } from '../src/store.mjs';

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-completion-repair-'));
  const store = new BridgeStore(stateDir);
  const job = {
    requestId: 'RQ-1',
    sourceMessageId: 'om_1',
    codexThreadId: 'thread-1',
    codexThreadRequestId: 'RQ-1',
    status: 'failed',
    stage: 'failed',
    errorSummary: 'old failure',
  };
  store.saveJobs([job]);
  const manifest = {
    request_id: 'RQ-1',
    source_message_id: 'om_1',
    thread_id: 'thread-1',
    expected_status: 'failed',
    expected_stage: 'failed',
    expected_job_sha256: jobSha256(job),
    evidence: 'four documents passed final readback review',
    documents: [{
      subject: 'subject one',
      url: 'https://my.feishu.cn/docx/DocOne',
      review: 'FORMAT_REVIEW: PASS revision 5',
    }],
    final_response: 'subject one: https://my.feishu.cn/docx/DocOne',
  };
  return { stateDir, store, manifest };
}

test('repairs one exact failed job without queuing a group reply', () => {
  const { stateDir, store, manifest } = setup();
  try {
    const beforeOutbox = store.getOutboxStats();
    const result = applyCompletionRepair(store, manifest, {
      now: new Date('2026-09-30T03:00:00.000Z'),
    });
    assert.equal(result.updated.status, 'completed');
    assert.equal(result.updated.stage, 'completed');
    assert.equal(result.updated.errorSummary, null);
    assert.equal(result.updated.completionDocuments.length, 1);
    assert.deepEqual(store.getOutboxStats(), beforeOutbox);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fails closed when state, ownership, fingerprint, or queue state changed', () => {
  const first = setup();
  try {
    first.store.updateJob('RQ-1', { stage: 'executing' });
    assert.throws(() => inspectCompletionRepair(first.store, first.manifest), /job state changed/);
  } finally {
    fs.rmSync(first.stateDir, { recursive: true, force: true });
  }

  const second = setup();
  try {
    second.store.saveJobs([{ ...second.store.getJob('RQ-1'), codexThreadRequestId: 'RQ-OTHER' }]);
    assert.throws(() => inspectCompletionRepair(second.store, second.manifest), /ownership/);
  } finally {
    fs.rmSync(second.stateDir, { recursive: true, force: true });
  }

  const third = setup();
  try {
    third.manifest.expected_job_sha256 = '0'.repeat(64);
    assert.throws(() => inspectCompletionRepair(third.store, third.manifest), /fingerprint changed/);
  } finally {
    fs.rmSync(third.stateDir, { recursive: true, force: true });
  }

  const fourth = setup();
  try {
    fourth.store.enqueueReply({ id: 'pending', chatId: 'oc_1', replyTo: 'om_1', text: 'x' });
    assert.throws(() => inspectCompletionRepair(fourth.store, fourth.manifest), /outbox has 1 pending/);
  } finally {
    fs.rmSync(fourth.stateDir, { recursive: true, force: true });
  }
});
