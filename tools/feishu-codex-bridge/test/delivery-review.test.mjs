import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canResumeDeliveryReview,
  readLatestFeishuRevision,
  reviewManifestPath,
  verifyCompletedReports,
} from '../src/delivery-review.mjs';

test('review-only recovery requires the same owned thread and saved result', () => {
  const job = {
    requestId: 'RQ-RECOVER',
    stage: 'verifying_delivery',
    codexThreadId: 'thread-one',
    codexThreadRequestId: 'RQ-RECOVER',
    finalResponse: 'https://my.feishu.cn/docx/ABC123',
    dispatchScope: { decision: 'execute' },
  };
  assert.equal(canResumeDeliveryReview(job), true);
  assert.equal(canResumeDeliveryReview({ ...job, codexThreadRequestId: 'RQ-OTHER' }), false);
  assert.equal(canResumeDeliveryReview({ ...job, finalResponse: '' }), false);
});

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-review-'));
  const stateDir = path.join(workspace, 'state');
  const requestId = 'RQ-REVIEW-TEST';
  const snapshotPath = path.join(workspace, 'snapshot.json');
  fs.writeFileSync(snapshotPath, '{}');
  fs.mkdirSync(path.dirname(reviewManifestPath(stateDir, requestId)), { recursive: true });
  fs.writeFileSync(reviewManifestPath(stateDir, requestId), JSON.stringify({
    requestId,
    documents: [{ url: 'https://my.feishu.cn/docx/ABC123', snapshotPath }],
  }));
  return {
    workspace,
    stateDir,
    requestId,
    finalResponse: '报告：https://my.feishu.cn/docx/ABC123',
  };
}

function passAudit() {
  return {
    verdict: 'PASS',
    document: { token: 'ABC123', revision_id: 7 },
    stats: { errors: 0, blocked: 0 },
    visual: { verdict: 'PASS' },
    receipt: {
      token: 'ABC123', revision_id: 7, verdict: 'PASS',
      script_version: 'test', reviewer_id: 'reviewer',
      layout_fingerprint: 'sha256:abc', generated_at: '2026-10-01T00:00:00Z',
    },
  };
}

test('completion rechecks deterministic PASS and the live latest revision', async () => {
  const item = fixture();
  try {
    let audited = 0;
    let read = 0;
    const receipts = await verifyCompletedReports({
      ...item,
      runAudit: async () => { audited += 1; return passAudit(); },
      readLatestRevision: async (token) => { read += 1; assert.equal(token, 'ABC123'); return 7; },
    });
    assert.equal(audited, 1);
    assert.equal(read, 1);
    assert.equal(receipts[0].revision_id, 7);
  } finally {
    fs.rmSync(item.workspace, { recursive: true, force: true });
  }
});

test('a link alone, failed review, or newer live revision cannot complete a job', async () => {
  const item = fixture();
  try {
    fs.rmSync(reviewManifestPath(item.stateDir, item.requestId));
    await assert.rejects(verifyCompletedReports({
      ...item,
      runAudit: async () => passAudit(),
      readLatestRevision: async () => 7,
    }), /ENOENT/);
    fs.writeFileSync(reviewManifestPath(item.stateDir, item.requestId), JSON.stringify({
      requestId: item.requestId,
      documents: [{ url: 'https://my.feishu.cn/docx/ABC123', snapshotPath: path.join(item.workspace, 'snapshot.json') }],
    }));
    await assert.rejects(verifyCompletedReports({
      ...item,
      runAudit: async () => ({ ...passAudit(), verdict: 'FAIL' }),
      readLatestRevision: async () => 7,
    }), /no matching deterministic FORMAT_REVIEW: PASS/);
    await assert.rejects(verifyCompletedReports({
      ...item,
      runAudit: async () => passAudit(),
      readLatestRevision: async () => 8,
    }), /changed after FORMAT_REVIEW: PASS/);
  } finally {
    fs.rmSync(item.workspace, { recursive: true, force: true });
  }
});

test('every report in a batch needs its own current PASS', async () => {
  const item = fixture();
  try {
    const secondSnapshot = path.join(item.workspace, 'second-snapshot.json');
    fs.writeFileSync(secondSnapshot, '{}');
    fs.writeFileSync(reviewManifestPath(item.stateDir, item.requestId), JSON.stringify({
      requestId: item.requestId,
      documents: [
        { url: 'https://my.feishu.cn/docx/ABC123', snapshotPath: path.join(item.workspace, 'snapshot.json') },
        { url: 'https://my.feishu.cn/docx/DEF456', snapshotPath: secondSnapshot },
      ],
    }));
    await assert.rejects(verifyCompletedReports({
      ...item,
      finalResponse: `${item.finalResponse}\nhttps://my.feishu.cn/docx/DEF456`,
      runAudit: async (snapshot) => {
        const audit = passAudit();
        if (snapshot === secondSnapshot) {
          audit.document.token = 'DEF456';
          audit.receipt.token = 'DEF456';
        }
        return audit;
      },
      readLatestRevision: async (token) => token === 'ABC123' ? 7 : 8,
    }), /report DEF456 changed after FORMAT_REVIEW: PASS/);
  } finally {
    fs.rmSync(item.workspace, { recursive: true, force: true });
  }
});

test('revision reader uses a read-only document GET and rejects missing revision', async () => {
  const revision = await readLatestFeishuRevision({
    async request(input) {
      assert.equal(input.method, 'GET');
      assert.equal(input.url, '/open-apis/docx/v1/documents/ABC123');
      return { code: 0, data: { document: { revision_id: 9 } } };
    },
  }, 'ABC123');
  assert.equal(revision, 9);
  await assert.rejects(
    readLatestFeishuRevision({ request: async () => ({ code: 0, data: {} }) }, 'ABC123'),
    /valid document revision/,
  );
});
